/**
 * BlueprintPlanRevisionService — the conversation at the approval gate.
 *
 * ## Why this exists
 *
 * "Request Changes" used to do two things wrong. It dropped the human's text
 * (the IPC handler never read `args.feedback`), and it rewound the pipeline to
 * PLAN — re-running plan → tasks → review, roughly twenty minutes, before the
 * human could look again. So the expensive path ran with none of the
 * information that justified running it.
 *
 * This service makes a change request a cheap conversational turn instead:
 * resume the REVIEW conversation, hand the agent the feedback, get a revised
 * plan back, re-raise the gate. Iterate until the plan is right, and only then
 * pay for re-deriving tasks and review — once.
 *
 * ## Why conversation reuse, not a live session
 *
 * The obvious design is to hold the REVIEW session open across the gate and
 * send follow-up messages to it, the way CLARIFY does (`clarifySessions` in
 * blueprint-spec.service.ts). That does not survive contact with a human: the
 * gate can sit open for hours or days, and the process would be pinned the
 * whole time and lost on restart.
 *
 * Instead each turn spawns a fresh session that *resumes the stored
 * conversation id* — the mechanism REVIEW already uses for retries
 * (`BP-RETRY-CONV-REUSE`). The agent still sees the spec, plan, tasks and its
 * own review report, but nothing is held open between turns and the loop
 * survives an app restart.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
  STALL_TIMEOUT_MS,
  wireAskUserAutoResponder
} from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintPlanRevisionAdapter } from './role-adapters/blueprint/blueprint-plan-revision.adapter'
import { parsePlanRevisionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import type { PendingApproval } from './blueprint.service'
import { blueprintTasksService } from './blueprint-tasks.service'
import { modelConfigService } from './model-config.service'
import { blueprintPhaseRepository } from '../db/repositories/blueprint.repository'
import { conversationRepository } from '../db/repositories'
import type { BlueprintPlanRevision } from '../../shared/blueprint-types'
import type { BlueprintMachineState } from '../../shared/blueprint-snapshot-types'

const bpLog = log.scope('blueprint-plan-revision')

/** A revision turn is one edit, not a phase — it must not take phase-length time. */
const REVISION_TIMEOUT_MS = 10 * 60_000

/**
 * Which approval-gate precondition this blueprint fails, or null when it may act.
 *
 * Two checks, neither subsuming the other: the machine check catches a stale
 * `pendingApproval` left behind after the pipeline moved on, the identity check
 * catches a call aimed at a blueprint that is not the one at the gate. Pure so
 * both call sites share one rule and it can be tested without a live pipeline.
 */
export function approvalGateBlock(params: {
  blueprintId: string
  machineState: BlueprintMachineState
  gate: PendingApproval | null
}): 'not-at-gate' | 'wrong-blueprint' | null {
  if (params.machineState !== 'awaiting-approval') return 'not-at-gate'
  if (params.gate?.blueprintId !== params.blueprintId) return 'wrong-blueprint'
  return null
}

/**
 * The gate as it should look after a revision turn — the single source both the
 * snapshot and the `approvalNeeded` event are built from.
 *
 * Extracted because gate state has two write paths that were built
 * independently and therefore drifted: `preflight` reached the snapshot but not
 * the event, so a revision round silently dropped the environment checks from
 * the renderer's copy of the gate. One payload, two consumers, no drift.
 *
 * `completion` is deliberately NOT carried over: coverage percentages and
 * "3 critical findings" describe a review of the plan that just changed, and
 * presenting them against the revised plan would be a claim nothing supports.
 * `reviewMarkdown` IS carried — its findings (security gaps, missing coverage)
 * usually survive a plan tweak, and the gate relabels it "Review of the
 * pre-revision plan" so it never claims to describe the current one.
 * Accept & Re-derive re-runs REVIEW and repopulates both.
 */
export function buildRevisedApproval(params: {
  blueprintId: string
  round: number
  revision: BlueprintPlanRevision
  priorApproval: PendingApproval | null
}): PendingApproval {
  const { blueprintId, round, revision, priorApproval } = params
  const planSummary =
    `Revision round ${round}: ${revision.summary || 'plan revised'}` +
    (revision.changes.length ? `\n${revision.changes.map((c) => `• ${c}`).join('\n')}` : '') +
    (revision.concerns.length
      ? `\n\n⚠ Agent concerns:\n${revision.concerns.map((c) => `• ${c}`).join('\n')}`
      : '')

  return {
    blueprintId,
    planSummary,
    revisedPlanMarkdown: revision.planMarkdown,
    ...(priorApproval?.reviewMarkdown ? { reviewMarkdown: priorApproval.reviewMarkdown } : {}),
    ...(priorApproval?.preflight ? { preflight: priorApproval.preflight } : {})
  }
}

export class BlueprintPlanRevisionService extends EventEmitter {
  /** Blueprints with a revision turn in flight — guards against double-submit. */
  private inFlight = new Set<string>()

  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  /** Is a revision turn currently running for this blueprint? */
  isRevising(blueprintId: string): boolean {
    return this.inFlight.has(blueprintId)
  }

  /**
   * One round of "change this".
   *
   * Always records the feedback first: if the turn then fails, the request is
   * still on the blueprint and the next phase run will act on it. Losing the
   * text is the one outcome this whole service exists to prevent.
   */
  async requestChanges(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    feedback: string
  }): Promise<{ ok: true; revision: BlueprintPlanRevision } | { ok: false; error: string }> {
    const { blueprintId, workspaceId, workspacePath } = params
    const feedback = params.feedback.trim()

    if (!feedback) return { ok: false, error: 'Feedback is empty' }
    if (this.inFlight.has(blueprintId)) {
      return { ok: false, error: 'A revision is already in progress for this blueprint' }
    }

    // A revision turn re-raises the approval gate when it finishes. Called from
    // anywhere other than the gate that would raise a gate over whatever is
    // actually running — a BUILD, say — and hand the human an Approve button
    // for work already underway.
    const machineState = blueprintService.getMachine(workspaceId).currentState
    const gate = blueprintService.getPendingApproval(workspaceId)
    const block = approvalGateBlock({ blueprintId, machineState, gate })
    if (block) {
      bpLog.warn(
        `[requestChanges] Blueprint ${blueprintId} — refused (${block}): machine is ` +
          `'${machineState}', gate belongs to '${gate?.blueprintId ?? 'none'}'`
      )
      return {
        ok: false,
        error:
          block === 'not-at-gate'
            ? 'This blueprint is not waiting at the approval gate'
            : 'This blueprint is not the one waiting at the approval gate'
      }
    }

    // 1. Record BEFORE doing anything that can fail.
    const entry = blueprintService.appendRevisionRequest(blueprintId, {
      phase: 'review',
      feedback,
      disposition: 'revised'
    })
    if (!entry) return { ok: false, error: 'Blueprint not found' }

    // 2. The conversation to resume. Without it the agent has no plan in
    //    context and a "revision" would be a blind rewrite — worse than the
    //    rewind it replaces, because it looks cheap.
    const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
    const priorConvId = reviewPhase?.conversationId
    if (!priorConvId || !conversationRepository.getSessionId(priorConvId)) {
      blueprintService.setLatestRevisionDisposition(blueprintId, 'rewound')
      bpLog.warn(
        `[requestChanges] Blueprint ${blueprintId} — no resumable REVIEW conversation; ` +
          `feedback recorded for the next full run`
      )
      return {
        ok: false,
        error:
          'No resumable review conversation — your feedback was saved and will be applied on the next run.'
      }
    }

    // A provider swap invalidates the stored session the same way it does for
    // retries; resuming across it produces an agent with no memory of the plan.
    const priorConv = conversationRepository.findById(priorConvId)
    const currentProvider = modelConfigService.getProvider(workspacePath)
    if (priorConv?.llmProvider && priorConv.llmProvider !== currentProvider) {
      blueprintService.setLatestRevisionDisposition(blueprintId, 'rewound')
      bpLog.warn(
        `[requestChanges] Blueprint ${blueprintId} — provider changed ` +
          `(${priorConv.llmProvider} → ${currentProvider}); feedback recorded for the next full run`
      )
      return {
        ok: false,
        error:
          'The model provider changed since this review ran — your feedback was saved and will be applied on the next run.'
      }
    }

    this.inFlight.add(blueprintId)
    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let cleanupAskUser: (() => void) | undefined
    const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'PLAN-REVISION')

    try {
      this.safeEmit('revisionStart', { blueprintId, workspaceId, round: entry.round, feedback })

      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'review',
        workspacePath,
        blueprintService.resolveWorkspaceContextWindow(workspacePath)
      )

      const adapter = new BlueprintPlanRevisionAdapter({
        workspaceId,
        blueprintId,
        phaseContext,
        feedback,
        round: entry.round
      })
      session = new AgentSessionService(adapter)

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'review',
          workspacePath,
          mode: 'plan'
        })
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)
      cleanupAskUser = wireAskUserAutoResponder(session, 'PLAN-REVISION')

      await session.start(workspacePath, 'plan')

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Plan revision timed out')),
          REVISION_TIMEOUT_MS
        )
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), priorConvId)
      try {
        await Promise.race([sendPromise, timeoutPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      const text = session.getStreamedContent(priorConvId)
      const revision = parsePlanRevisionBlock(text)

      if (!revision) {
        // The turn ran but produced nothing usable. The feedback stays on the
        // ledger, so the next full run still honours it.
        blueprintService.setLatestRevisionDisposition(blueprintId, 'rewound')
        bpLog.warn(`[requestChanges] Blueprint ${blueprintId} — no usable revision block returned`)
        return {
          ok: false,
          error:
            'The agent did not return a revised plan. Your feedback was saved and will be applied on the next run.'
        }
      }

      // 3. The revised plan REPLACES the plan artifact — there is exactly one
      //    authoritative plan at any moment.
      //
      //    Appending a second one looked like version history and behaved like
      //    data loss: assemblePhaseContext() pushes every matching artifact, so
      //    TASKS received two contradictory plans with nothing to choose
      //    between them. Worse, renderSingleArtifact() prefers projected JSON
      //    for `plan`, and PLAN_PROJECTION_KEYS keeps only `summary` — so an
      //    artifact carrying both contentMd and revision metadata rendered as
      //    `{"summary":"…"}` and the revised plan never reached the agent at
      //    all. Hence contentMd and no contentJson.
      //
      //    The history is not discarded: the append-only `plan-revision`
      //    artifacts below carry every round's planMarkdown, changes and
      //    concerns.
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
      if (planPhase) {
        blueprintPhaseRepository.replaceArtifactOfType(planPhase.id, 'plan', {
          type: 'plan',
          contentMd: revision.planMarkdown
        })
      }

      // A record of the exchange itself, so Deliverables shows the negotiation
      // and not just its outcome.
      if (reviewPhase) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'plan-revision',
          contentMd:
            `## Revision round ${entry.round}\n\n` +
            `**You asked:**\n\n> ${feedback.replace(/\n/g, '\n> ')}\n\n` +
            `**Agent:** ${revision.summary || '(no summary)'}\n\n` +
            (revision.changes.length
              ? `**Changes:**\n${revision.changes.map((c) => `- ${c}`).join('\n')}\n\n`
              : '') +
            (revision.concerns.length
              ? `**Concerns raised:**\n${revision.concerns.map((c) => `- ${c}`).join('\n')}\n`
              : ''),
          // Carries planMarkdown — this is where plan version history lives now.
          contentJson: { round: entry.round, feedback, requestedAt: entry.at, ...revision }
        })
      }

      bpLog.info(
        `[requestChanges] Blueprint ${blueprintId} — round ${entry.round} revised ` +
          `(${revision.changes.length} change(s), ${revision.concerns.length} concern(s))`
      )

      // Re-raise the gate against the REVISED plan. The gate was never dismissed
      // — the human is still standing at it — but its summary still described the
      // plan they just objected to, so leaving it stale would show them the old
      // plan as though nothing had happened.
      const approval = buildRevisedApproval({
        blueprintId,
        round: entry.round,
        revision,
        priorApproval: blueprintService.getPendingApproval(workspaceId)
      })

      blueprintService.setPendingApproval(workspaceId, approval)
      this.safeEmit('approvalNeeded', { ...approval, workspaceId, phase: 'review' })

      this.safeEmit('revisionComplete', {
        blueprintId,
        workspaceId,
        round: entry.round,
        revision
      })

      return { ok: true, revision }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      blueprintService.setLatestRevisionDisposition(blueprintId, 'rewound')
      bpLog.error(`[requestChanges] Blueprint ${blueprintId} — revision turn failed:`, err)
      this.safeEmit('revisionFailed', { blueprintId, workspaceId, round: entry.round, error: msg })
      return {
        ok: false,
        error: `Revision failed: ${msg}. Your feedback was saved and will be applied on the next run.`
      }
    } finally {
      this.inFlight.delete(blueprintId)
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop().catch(() => {
          /* best effort — the turn already produced its result */
        })
      }
    }
  }

  /**
   * Why an accept would be refused, or null when it will proceed.
   *
   * Exposed because the re-derivation is fire-and-forget over IPC: the caller
   * cannot await the outcome, so it has to be able to ask first. Without this
   * a refused accept looks to the gate exactly like one still running, and the
   * button spins forever.
   */
  acceptBlockedReason(blueprintId: string, workspaceId: string): string | null {
    // Accepting mid-turn would re-derive TASKS from a plan the running turn is
    // about to replace, and the turn would then re-raise a gate over the
    // re-derivation it never knew about.
    if (this.inFlight.has(blueprintId)) {
      return 'A revision is still running — wait for it to finish before accepting.'
    }
    // Accepting dismisses the gate and re-derives TASKS. Doing that from a
    // blueprint the gate does not belong to would tear down someone else's
    // approval and rewind the wrong pipeline.
    const block = approvalGateBlock({
      blueprintId,
      machineState: blueprintService.getMachine(workspaceId).currentState,
      gate: blueprintService.getPendingApproval(workspaceId)
    })
    if (block === 'not-at-gate') return 'This blueprint is no longer waiting at the approval gate.'
    if (block === 'wrong-blueprint') {
      return 'This blueprint is not the one waiting at the approval gate.'
    }
    return null
  }

  /**
   * Accept the revised plan and re-derive downstream.
   *
   * TASKS and REVIEW re-run; PLAN does not. That is the entire economic point
   * of the loop: the plan is already what the human agreed to, so re-deriving
   * it would both waste the expensive step and risk losing the agreement.
   */
  async acceptRevision(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    // Re-checked here and not only at the IPC edge: this is the invariant, and
    // it must hold for every caller.
    const blocked = this.acceptBlockedReason(blueprintId, workspaceId)
    if (blocked) {
      bpLog.warn(`[acceptRevision] Blueprint ${blueprintId} — refused: ${blocked}`)
      return
    }

    const machine = blueprintService.getMachine(workspaceId)
    blueprintService.setPendingApproval(workspaceId, null)
    machine.transition('approvalResponded')

    // Reset only what must be recomputed. rewindToPhase('tasks') also clears
    // those phases' context snapshots, which is correct here — the retry
    // metadata describes a run against the pre-revision plan.
    blueprintService.rewindToPhase(blueprintId, 'tasks')

    bpLog.info(
      `[acceptRevision] Blueprint ${blueprintId} — re-deriving TASKS → REVIEW against the revised plan`
    )

    await blueprintTasksService.startTasksPhase({ blueprintId, workspaceId, workspacePath })
  }

  /** Current ledger, for the gate UI. */
  getRevisionHistory(blueprintId: string): ReturnType<typeof blueprintService.getRevisionRequests> {
    return blueprintService.getRevisionRequests(blueprintId)
  }

  async shutdown(): Promise<void> {
    // Turns are short-lived and awaited; nothing is held open between them.
    this.inFlight.clear()
  }
}

export const blueprintPlanRevisionService = new BlueprintPlanRevisionService()

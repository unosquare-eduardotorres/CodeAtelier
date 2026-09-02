/**
 * BlueprintLeadReviewService — post-verify lead-review pass (M6.1/M6.3).
 *
 * Layer 3.5-at-the-end: after VERIFY passes (`passed`/`human_needed`) and
 * before the blueprint is marked `complete`, one strong-model session reviews
 * the WHOLE feature diff against the spec. This is the cross-task judgment
 * layer — spec drift and test gaming are properties of the whole diff, not of
 * any single task, so the per-task gates structurally cannot see them.
 *
 * Bounded loop, mirroring M7's code-review shape:
 *   pass → findings → R-tasks (collision-safe) → one fix wave → build re-enters
 *   verify → verify re-triggers the pass → round-2 findings → survivors →
 *   ledger → complete.
 *
 * The round bound is `settingsJson.leadReviewRound`:
 *   absent/0 → first pass may dispatch a fix wave (sets it to 1)
 *   1        → second pass records survivors to the ledger, never loops
 *   2        → settled (defensive — treated the same as 1)
 *
 * Gated by the workspace setting `leadReviewPass` (default OFF). The
 * `blueprint:lead-review` role binding stays mandatory either way — it is the
 * escalation ladder's fixer of last resort, so it always resolves to a model.
 *
 * NOT a pipeline phase: the pass runs under the verify umbrella (phase record
 * untouched, progress emitted with phase 'verify') and appends a
 * `lead-review-pass` artifact to the verify phase record. This avoids a DB
 * CHECK-constraint migration for a settings-gated extra pass.
 */

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
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
import { BlueprintLeadReviewAdapter } from './role-adapters/blueprint/blueprint-lead-review.adapter'
import { buildLeadReviewPassGoalCondition } from './blueprint-goal-conditions'
import { parseLeadReview } from '../../shared/blueprint-artifact-parsers'
import type { LeadReviewResult, ReviewFinding } from '../../shared/task-review-types'
import { blueprintService, capArtifactForIpc } from './blueprint.service'
import { syncBlueprintDone } from './jira-issue-sync.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import type {
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload
} from '../../shared/blueprint-types'
import type { UnverifiedItem } from '../../shared/gate-types'

const bpLog = log.scope('blueprint-lead-review')

const PASS_TIMEOUT_MS = 30 * 60_000 // 30 min

/** Whole-diff cap. A diff beyond this is truncated, not shipped raw. */
const MAX_DIFF_CHARS = 120_000

/** Hard bound on fix tasks per pass round — mirrors MAX_FIX_TASKS in M7. */
const MAX_FIX_TASKS = 10

export class BlueprintLeadReviewService extends EventEmitter {
  // Error-isolated emit — mirrors safeEmit() in the other phase services.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  /**
   * Run the post-verify lead-review pass. Called from the verify service's
   * success path when `leadReviewPass` is on and the round bound allows.
   *
   * The caller (verify) has ALREADY released the pipeline lock — this method
   * re-acquires it via markPipelineRunning, mirroring the build→verify
   * handoff. On completion the blueprint is marked `complete` here (the
   * verify service skipped its own completion because the pass was dispatched).
   */
  async startLeadReviewPass(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startLeadReviewPass] Blueprint ${blueprintId} — starting lead-review pass`)

    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let cleanupAskUser: (() => void) | undefined
    let syntheticConvId: string | undefined
    // Set when a successor (fix-wave build) took over the pipeline lock.
    let lockHandedOff = false
    // F6 FIX: set when the first terminal event is emitted — a late/re-fired
    // catch must not produce a duplicate phaseComplete or re-complete the blueprint.
    let settled = false

    try {
      // 1. Pipeline + DB state. The blueprint stays in 'verifying' status —
      // the pass is part of verify's umbrella, not a new phase.
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'verify')

      // 2. Assemble the whole-feature diff (same baseline as code-review).
      const diff = this.assembleFeatureDiff(blueprintId, workspacePath)
      if (diff === null) {
        // No git baseline → nothing to review. Record honestly and complete.
        bpLog.warn(
          `[startLeadReviewPass] Blueprint ${blueprintId} — no diff could be assembled; recording unverifiable and completing`
        )
        const ledgerItem: UnverifiedItem = {
          taskId: 'LR',
          gate: 'lead-review-pass',
          reason: 'no_git',
          detail: 'feature diff could not be assembled (no baseline commit)',
          at: new Date().toISOString()
        }
        blueprintRepository.appendUnverified(blueprintId, [ledgerItem])
        this.appendPassArtifact(blueprintId, {
          findings: [],
          verdict: 'changes-required',
          rejected: [],
          note: 'diff unavailable — pass not performed'
        })
        this.completeBlueprint(blueprintId, workspaceId, workspacePath, () => {
          settled = true
        })
        return
      }

      // 3. Phase context (spec/plan/build artifacts — same relevance set as
      // code-review: the lead judges intent against the diff).
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'verify',
        workspacePath,
        blueprintService.resolveWorkspaceContextWindow(workspacePath)
      )

      // 4. Adapter + session
      const verifySummary = this.summarizeVerifyOutcome(blueprintId)
      const adapter = new BlueprintLeadReviewAdapter({
        workspaceId,
        blueprintId,
        phaseContext,
        diff,
        verifySummary
      })
      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(
        buildLeadReviewPassGoalCondition(blueprint?.title ?? 'Unknown'),
        'enforce'
      )

      session = new AgentSessionService(adapter)

      // 5. Progress — the pass runs under the verify umbrella.
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        text: 'Lead review pass: reviewing the whole feature diff against the spec',
        kind: 'system'
      })

      // 6. Streaming + watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'LEAD-REVIEW')

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'verify',
          workspacePath,
          mode: 'plan'
        })
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // Non-interactive pass — auto-respond to ask_user calls.
      cleanupAskUser = wireAskUserAutoResponder(session, 'LEAD-REVIEW')

      // 7. Start session
      await session.start(workspacePath, 'plan')

      syntheticConvId = `blueprint-lead-review-${blueprintId}-${Date.now()}`

      // 8. Timeout + abort race
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('LEAD-REVIEW pass timeout')),
          PASS_TIMEOUT_MS
        )
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) onAbort()
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // 9. Parse findings (existing shared parser — verdict 'approved' requires
      // the stated verdict AND zero findings).
      const text = session.getStreamedContent(syntheticConvId)
      const review = parseLeadReview(text)

      // 10. Persist the pass artifact on the verify phase record.
      this.appendPassArtifact(blueprintId, {
        findings: review.findings,
        verdict: review.verdict,
        rejected: review.rejected
      })

      bpLog.info(
        `[startLeadReviewPass] Blueprint ${blueprintId} — pass complete: ` +
          `${review.findings.length} finding(s), verdict ${review.verdict}`
      )

      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        text:
          review.verdict === 'approved'
            ? 'Lead review pass: approved — no findings'
            : `Lead review pass: ${review.findings.length} finding(s) (${review.rejected.length} rejected as off-rubric)`,
        kind: 'system'
      })

      this.safeEmit('phaseArtifact', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        // A5: cap for IPC — multi-hundred-KB payloads stall the renderer
        artifact: capArtifactForIpc({
          type: 'lead-review-pass',
          contentJson: {
            findings: review.findings,
            verdict: review.verdict,
            rejected: review.rejected
          }
        })
      } satisfies BlueprintPhaseArtifactPayload)

      // 11. Findings → fix tasks (one wave), then build re-enters verify which
      // re-triggers this pass for the round-2 check.
      const fixWaveDispatched = await this.dispatchFixTasks({
        blueprintId,
        workspaceId,
        workspacePath,
        review
      })

      if (fixWaveDispatched) {
        lockHandedOff = true
        return
      }

      // 12. No fix wave (approved, or round bound reached) → complete.
      this.completeBlueprint(blueprintId, workspaceId, workspacePath, () => {
        settled = true
      })
    } catch (err) {
      if (settled) {
        // F6 FIX: the pass already settled (terminal phaseComplete emitted) —
        // a late throw from post-completion work must not re-complete the
        // blueprint or emit a duplicate terminal event.
        bpLog.warn(`[startLeadReviewPass] Post-settlement throw ignored:`, err)
        // F3 FIX: still surface it to the human — a swallowed post-completion
        // failure would otherwise look like a silent stall.
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `⚠️ Post-completion error (phase already settled): ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        return
      }
      bpLog.error(`[startLeadReviewPass] Lead-review pass failed:`, err)

      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        // The pass is a quality layer, not a pipeline phase: a pass failure
        // must not fail an otherwise-verified blueprint. Record it as an
        // unverified ledger entry and complete — the user sees the gap.
        const errorMsg = err instanceof Error ? err.message : String(err)
        blueprintRepository.appendUnverified(blueprintId, [
          {
            taskId: 'LR',
            gate: 'lead-review-pass',
            reason: 'pass_error',
            detail: `lead-review pass failed: ${errorMsg.slice(0, 300)}`,
            at: new Date().toISOString()
          }
        ])
        this.appendPassArtifact(blueprintId, {
          findings: [],
          verdict: 'changes-required',
          rejected: [],
          note: `pass failed: ${errorMsg.slice(0, 300)}`
        })
        this.completeBlueprint(blueprintId, workspaceId, workspacePath, () => {
          settled = true
        })
      }
    } finally {
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop()
      }
      // Only release the pipeline lock when no successor took it over.
      if (!lockHandedOff) {
        blueprintService.markPipelineStopped(workspaceId)
      }
    }
  }

  // ── Diff assembly (same baseline contract as code-review) ──

  private assembleFeatureDiff(blueprintId: string, workspacePath: string): string | null {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    const settings = (blueprint.settingsJson ?? {}) as Record<string, unknown>
    let baseline: string | null =
      typeof settings.buildBaselineCommit === 'string' ? settings.buildBaselineCommit : null

    if (!baseline) {
      const mb = gitSync(['merge-base', 'HEAD', 'main'], workspacePath)
      baseline = mb?.trim() || null
    }

    if (!baseline) return null

    const diff = gitSync(['diff', '--no-color', `${baseline}..HEAD`, '--'], workspacePath)
    if (diff === null) return null
    if (diff.trim() === '') return ''
    return diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + '\n… (diff truncated for review)'
      : diff
  }

  /** Condensed verify outcome for the lead's context. */
  private summarizeVerifyOutcome(blueprintId: string): string {
    const verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
    if (!verifyPhase) return ''
    const artifacts = verifyPhase.artifactsJson ?? []
    const verifyArt = [...artifacts]
      .reverse()
      .find((a) => a.type === 'verify' || a.type === 'verification')
    if (!verifyArt?.contentJson) return ''
    const cj = verifyArt.contentJson as Record<string, unknown>
    const lines = [`overallStatus: ${String(cj.overallStatus ?? 'unknown')}`]
    const findings = Array.isArray(cj.findings) ? cj.findings : []
    if (findings.length > 0) {
      lines.push(`${findings.length} finding(s):`)
      for (const f of findings.slice(0, 10)) {
        if (f && typeof f === 'object') {
          const fo = f as Record<string, unknown>
          lines.push(
            `- ${String(fo.severity ?? '')} ${String(fo.description ?? fo.issue ?? '')}`.trim()
          )
        }
      }
    }
    return lines.join('\n')
  }

  // ── Findings → fix tasks (one wave, bounded) ──

  /**
   * All findings become R-prefixed fix tasks (the lead rubric is closed and
   * every finding is mechanically actionable by construction — there is no
   * severity tier to filter on). Capped at MAX_REVIEW_FINDINGS by the parser
   * and MAX_FIX_TASKS here. Returns true when a fix wave was dispatched (the
   * build service then owns the pipeline lock).
   */
  private async dispatchFixTasks(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    review: LeadReviewResult
  }): Promise<boolean> {
    const { blueprintId, workspaceId, workspacePath, review } = params

    if (review.verdict === 'approved' || review.findings.length === 0) return false

    // Round bound: only one fix round. A second changes-required verdict goes
    // to the ledger, not back into the loop.
    const settings = (blueprintRepository.findById(blueprintId)?.settingsJson ?? {}) as Record<
      string,
      unknown
    >
    const round = typeof settings.leadReviewRound === 'number' ? settings.leadReviewRound : 0
    if (round >= 1) {
      bpLog.info(
        `[lead-review] Blueprint ${blueprintId} — fix round already ran; recording ${review.findings.length} surviving finding(s) as unverified`
      )
      this.recordSurvivingFindings(blueprintId, review.findings)
      return false
    }

    // BP-COLLISION-SAFE-RENUMBER: R-task IDs continue after any existing R-tasks.
    const existing = blueprintTaskRepository.findByBlueprint(blueprintId)
    const maxExistingR = existing
      .filter((t) => /^R\d+$/.test(t.taskId))
      .reduce((max, t) => Math.max(max, parseInt(t.taskId.slice(1), 10)), 0)
    const maxWave = existing.reduce((max, t) => Math.max(max, t.wave), 0)

    const fixTasks = review.findings.slice(0, MAX_FIX_TASKS).map((f, i) => ({
      taskId: `R${String(maxExistingR + 1 + i).padStart(3, '0')}`,
      wave: maxWave + 1,
      description:
        `[lead-review fix] ${f.category}: ${f.issue}` +
        `\nRequired change: ${f.requiredChange}` +
        (f.howVerified ? `\nHow to verify: ${f.howVerified}` : '') +
        `\nFile: ${f.file}${f.location ? ` (${f.location})` : ''}`,
      filePathsJson: [f.file]
    }))

    blueprintTaskRepository.createBulk(blueprintId, fixTasks)
    blueprintRepository.update(blueprintId, {
      settingsJson: { ...settings, leadReviewRound: 1 }
    })

    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'verify',
      text: `Lead review pass: ${fixTasks.length} fix task(s) created — dispatching fix wave`,
      kind: 'system'
    })

    // Dispatch ONE fix wave through the existing build machinery. The build
    // service re-runs only pending tasks (BP-RESUME-01) and its completion
    // re-enters finalizeSuccess → verify → this pass (round-2 check).
    //
    // Lock handoff: release this pass's pipeline lock first — the build
    // service's markPipelineRunning throws unless the machine is idle.
    try {
      const { blueprintBuildService } = await import('./blueprint-build.service')
      blueprintService.markPipelineStopped(workspaceId)
      await blueprintBuildService.startBuildPhase({
        blueprintId,
        workspaceId,
        workspacePath
      })
      return true
    } catch (err) {
      bpLog.error(`[lead-review] Fix wave dispatch failed for ${blueprintId}:`, err)
      this.recordSurvivingFindings(blueprintId, review.findings)
      return false
    }
  }

  /** Findings that survived the fix round → unverified ledger (never block). */
  private recordSurvivingFindings(blueprintId: string, findings: ReviewFinding[]): void {
    if (findings.length === 0) return
    const items: UnverifiedItem[] = findings.map((f) => ({
      taskId: 'LR',
      gate: 'lead-review-pass',
      reason: 'finding_unresolved',
      detail: `${f.category}: ${f.issue} (${f.file}${f.location ? ` ${f.location}` : ''})`,
      at: new Date().toISOString()
    }))
    blueprintRepository.appendUnverified(blueprintId, items)
    bpLog.info(
      `[lead-review] Blueprint ${blueprintId} — ${items.length} finding(s) recorded as unverified`
    )
  }

  // ── Completion ──

  /**
   * Complete the blueprint. The verify service skipped its own completion when
   * it dispatched this pass, so the pass owns the terminal transition —
   * including the memory extraction verify would have enqueued.
   */
  private completeBlueprint(
    blueprintId: string,
    workspaceId: string,
    workspacePath: string,
    // F6 FIX: invoked immediately after the terminal emit so the caller's
    // settled flag flips even if later work here throws.
    onSettled?: () => void
  ): void {
    const currentStatus = blueprintRepository.findById(blueprintId)?.status
    if (currentStatus === 'cancelled') return

    blueprintRepository.updateStatus(blueprintId, 'complete')
    void syncBlueprintDone(blueprintId)

    this.safeEmit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'verify',
      status: 'complete',
      completion: {
        phase: 'verify',
        status: 'complete',
        overallStatus: 'passed',
        leadReviewPass: true
      }
    } satisfies BlueprintPhaseCompletePayload)
    onSettled?.()

    // MEM-BP-COMPLETE-01 parity: enqueue memory extraction (the verify service
    // skipped its own when it dispatched this pass).
    this.enqueueMemoryExtraction(blueprintId, workspaceId, workspacePath)
  }

  /**
   * Memory extraction parity with the verify service. Kept local (rather than
   * calling verify's private method) so the pass never reaches into another
   * service's internals; the payload shape matches MEM-BP-COMPLETE-01.
   */
  private enqueueMemoryExtraction(
    blueprintId: string,
    workspaceId: string,
    workspacePath: string
  ): void {
    try {
      const { workspaceRepository: wsRepo } =
        require('../db/repositories') as typeof import('../db/repositories')
      const wsSettings = wsRepo.getSettings(workspaceId)
      if ((wsSettings as Record<string, unknown>).memoryCaptureBlueprints === false) return

      const { memoryExtractionService } =
        require('./memory-extraction.service') as typeof import('./memory-extraction.service')
      const { blueprintEventRepository } =
        require('../db/repositories/blueprint-event.repository') as typeof import('../db/repositories/blueprint-event.repository')

      const blueprint = blueprintRepository.findById(blueprintId)
      if (!blueprint) return

      const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)

      let clarifyQA: Array<{ question: string; answer: string }> | undefined
      try {
        const events = blueprintEventRepository.findByBlueprint(blueprintId)
        const qaEvents = events.filter((e) => e.type === 'qa' || e.type === 'user')
        if (qaEvents.length > 0) {
          clarifyQA = qaEvents
            .map((e) => {
              const payload = e.payload as Record<string, unknown> | undefined
              return {
                question:
                  typeof payload?.question === 'string'
                    ? payload.question
                    : typeof payload === 'string'
                      ? payload
                      : '',
                answer: typeof payload?.answer === 'string' ? payload.answer : ''
              }
            })
            .filter((qa) => qa.question)
        }
      } catch {
        // Events may not exist — fine
      }

      memoryExtractionService.enqueueBlueprintExtraction({
        blueprintId,
        workspaceId,
        workspacePath,
        title: blueprint.title,
        status: 'complete',
        phases: phases.map((p) => ({
          phase: p.phase,
          artifacts: p.artifactsJson ?? []
        })),
        tasks: tasks.map((t) => ({
          taskId: t.taskId,
          description: t.description,
          status: t.status
        })),
        clarifyQA
      })
    } catch (err) {
      bpLog.warn(`[enqueueMemoryExtraction] Failed to enqueue: ${err}`)
    }
  }

  /** Append the pass artifact to the verify phase record. */
  private appendPassArtifact(
    blueprintId: string,
    contentJson: Record<string, unknown>
  ): void {
    const verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
    if (!verifyPhase) return
    try {
      blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
        type: 'lead-review-pass',
        contentJson
      })
    } catch (err) {
      bpLog.warn(`[appendPassArtifact] Failed to append: ${err}`)
    }
  }

  /** One-shot — no session map to clean up. */
  async cancelBlueprint(_blueprintId: string): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** Run a git subcommand in the workspace (sync, best-effort). */
function gitSync(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return null
  }
}

export const blueprintLeadReviewService = new BlueprintLeadReviewService()

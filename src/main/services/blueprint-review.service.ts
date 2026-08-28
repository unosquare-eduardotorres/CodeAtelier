/**
 * BlueprintReviewService — orchestrates the REVIEW phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the review request,
 * parses the completion block with findings/recommendation, saves the artifact,
 * and emits an approval gate event. Does NOT auto-advance to BUILD.
 *
 * Advancement to BUILD happens via BLUEPRINT_APPROVAL_RESPOND handler.
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
import { BlueprintReviewAdapter } from './role-adapters/blueprint/blueprint-review.adapter'
import { buildReviewGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, parseDiscoveriesBlock } from './blueprint-artifact-parsers'
import { blueprintService, capArtifactForIpc } from './blueprint.service'
import { modelConfigService } from './model-config.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { conversationRepository } from '../db/repositories'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintApprovalNeededPayload
} from '../../shared/blueprint-types'
import { runPreflightChecks } from './blueprint-preflight.service'
import type { ApprovalPreflightData } from '../../shared/preflight-types'

const bpLog = log.scope('blueprint-review')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintReviewService extends EventEmitter {
  // BP-PHASE-RAW-EMIT-01: Error-isolated emit prevents listener throws from
  // crashing the pipeline. Mirrors safeEmit() in BlueprintBuildService/VerifyService.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  async startReviewPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startReviewPhase] Blueprint ${blueprintId} — starting REVIEW`)

    // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
    // finally's markPipelineStopped() is guaranteed to run.
    let reviewPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined
    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let cleanupAskUser: (() => void) | undefined
    // BP-CATCH-SCOPE-01: Hoisted outside try so the catch block (partial-output save) can read it.
    let syntheticConvId: string | undefined

    try {
      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'review')

      reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
      if (reviewPhase) {
        blueprintPhaseRepository.updateStatus(reviewPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'reviewing')
      blueprintRepository.update(blueprintId, { currentPhase: 'review' })

      // 2. Assemble context (includes spec + clarify + plan + tasks artifacts + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'review',
        workspacePath
      )

      // 3. Create adapter + session
      const adapter = new BlueprintReviewAdapter({ workspaceId, blueprintId, phaseContext })

      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(buildReviewGoalCondition(blueprint?.title ?? 'Unknown'), 'enforce')

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'review',
        goal: buildReviewGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming — named handlers for cleanup + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'REVIEW')

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

      // B4-FIX: Auto-respond to ask_user calls — review is non-interactive
      cleanupAskUser = wireAskUserAutoResponder(session, 'REVIEW')

      // 6. Start session + send with timeout + stall watchdog + abort race
      await session.start(workspacePath, 'plan')

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const reviewPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
      const priorConvId = reviewPhaseRec?.conversationId
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
          bpLog.info(`[startReviewPhase] Resuming conversation ${priorConvId} from failed attempt`)
        } else {
          syntheticConvId = `blueprint-review-${blueprintId}-${Date.now()}`
          bpLog.info(`[startReviewPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-review-${blueprintId}-${Date.now()}`
      }

      // BP-CONV-ENSURE: persist the conversation row so setConversation's FK
      // guard passes and crash recovery can correlate the phase to its transcript.
      blueprintService.ensurePhaseConversation(workspaceId, blueprintId, 'review', syntheticConvId)

      // Persist conversation ID early so retries can find it
      if (reviewPhaseRec) {
        try {
          blueprintPhaseRepository.setConversation(reviewPhaseRec.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
      }

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('REVIEW phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      // BP-ABORT-TOCTOU-02: Attach listener BEFORE checking aborted status to
      // close the race window where the signal fires between check and addEventListener.
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) {
          onAbort()
        }
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // 7. Parse output
      const text = session.getStreamedContent(syntheticConvId)
      const completion = parsePhaseCompletionBlock(text, 'review') ?? undefined

      // 8. Save phase artifact
      if (reviewPhase) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'review',
          contentMd: text,
          contentJson: completion ?? undefined
        })
        blueprintPhaseRepository.setConversation(reviewPhase.id, syntheticConvId)

        // 8b. Save discoveries artifact (if emitted)
        const discoveries = parseDiscoveriesBlock(text)
        if (discoveries?.length) {
          blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
            type: 'discoveries',
            contentJson: { phase: 'review', entries: discoveries }
          })
        }

        blueprintPhaseRepository.updateStatus(reviewPhase.id, 'complete')
        // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
        if (reviewPhase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(reviewPhase.id, null)
        }
      }

      bpLog.info(
        `[startReviewPhase] Blueprint ${blueprintId} — review complete, recommendation: ${completion?.recommendation ?? 'unknown'}`
      )

      // 9. Emit phaseComplete
      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'review',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (reviewPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'review',
          artifact: capArtifactForIpc({ type: 'review', contentMd: text })
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // 10. Run environment preflight checks (cheap, <5s — G5: no new machine states)
      let preflightData: ApprovalPreflightData | undefined
      try {
        const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
        const taskDescriptions = tasks.map((t) => t.description)
        const preflightResult = await runPreflightChecks(workspacePath, taskDescriptions)

        // A6+R2-2 fix: atomic replace — avoids stale-read hazard from step 1
        if (reviewPhase) {
          blueprintPhaseRepository.replaceArtifactOfType(reviewPhase.id, 'preflight', {
            type: 'preflight',
            contentJson: preflightResult as unknown as Record<string, unknown>
          })
        }

        preflightData = { result: preflightResult, overridden: false }
        this.safeEmit('preflightResult', { blueprintId, workspaceId, result: preflightResult })
        bpLog.info(
          `[startReviewPhase] Preflight: ${preflightResult.checks.length} checks — ` +
            `${preflightResult.hasBlockers ? 'HAS BLOCKERS' : 'no blockers'}`
        )
      } catch (preflightErr) {
        // Preflight failure should never block the approval gate (premortem #4)
        bpLog.warn(`[startReviewPhase] Preflight failed (non-fatal):`, preflightErr)
      }

      // 11. Emit approval gate — human must approve before BUILD
      // Drive state machine: phase-running → awaiting-approval
      const machine = blueprintService.getMachine(workspaceId)
      machine.transition('approvalNeeded')

      const planSummary = this.buildApprovalSummary(completion ?? null)
      // M2: Track approval state for snapshot sync
      blueprintService.setPendingApproval(workspaceId, {
        blueprintId,
        planSummary,
        completion: completion ? (completion as Record<string, unknown>) : undefined,
        reviewMarkdown: text || undefined,
        ...(preflightData
          ? {
              preflight: {
                result: preflightData.result as unknown as Record<string, unknown>,
                overridden: preflightData.overridden
              }
            }
          : {})
      })
      this.safeEmit('approvalNeeded', {
        blueprintId,
        workspaceId,
        phase: 'review',
        planSummary,
        completion: completion ?? undefined,
        reviewMarkdown: text || undefined,
        ...(preflightData ? { preflight: preflightData } : {})
      } as BlueprintApprovalNeededPayload & { preflight?: ApprovalPreflightData })

      // NOTE: Does NOT advance to BUILD. That happens in BLUEPRINT_APPROVAL_RESPOND handler.
    } catch (err) {
      bpLog.error(`[startReviewPhase] REVIEW phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (reviewPhase) {
          blueprintPhaseRepository.updateStatus(reviewPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent(syntheticConvId)
      if (partialText && reviewPhase) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'review-partial',
          contentMd: partialText
        })
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try {
        blueprintService.saveRetryContext(blueprintId, 'review', { error: errorMsg })
      } catch {
        /* best effort */
      }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId,
        workspaceId,
        workspacePath,
        phase: 'review',
        error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'review',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop()
      }
      blueprintService.markPipelineStopped(workspaceId)
    }
  }

  // ── Approval Summary Builder ──

  /**
   * Build a human-readable summary for the approval gate from the completion payload.
   */
  private buildApprovalSummary(completion: Record<string, unknown> | null): string {
    if (!completion) return 'Review completed — no structured findings available.'

    const findings = completion.findings as
      { critical?: number; high?: number; medium?: number; low?: number } | undefined
    const recommendation =
      typeof completion.recommendation === 'string' ? completion.recommendation : 'unknown'
    const coverage = completion.coveragePercent as number | undefined

    const lines: string[] = []
    if (coverage !== undefined) {
      lines.push(`Coverage: ${coverage}% of requirements have implementation tasks`)
    }
    if (findings) {
      const parts: string[] = []
      if (findings.critical) parts.push(`${findings.critical} critical`)
      if (findings.high) parts.push(`${findings.high} high`)
      if (findings.medium) parts.push(`${findings.medium} medium`)
      if (findings.low) parts.push(`${findings.low} low`)
      lines.push(`Findings: ${parts.join(', ') || 'none'}`)
    }
    lines.push(`Recommendation: ${recommendation.replace(/_/g, ' ')}`)

    return lines.join('\n')
  }

  /** Cancel (one-shot — handled by AbortController in blueprintService.cancel()). */
  async cancelBlueprint(_blueprintId: string): Promise<void> {
    // One-shot — no session map to clean up.
  }

  async shutdown(): Promise<void> {
    // One-shot — no persistent sessions to clean up.
  }
}

export const blueprintReviewService = new BlueprintReviewService()

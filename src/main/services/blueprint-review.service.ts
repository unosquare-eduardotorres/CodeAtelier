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
import { AgentSessionService } from './agent-session.service'
import { BlueprintReviewAdapter } from './role-adapters/blueprint/blueprint-review.adapter'
import { buildReviewGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintApprovalNeededPayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-review')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintReviewService extends EventEmitter {
  async startReviewPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startReviewPhase] Blueprint ${blueprintId} — starting REVIEW`)

    // 1. Pipeline + DB state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'review')

    const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
    if (reviewPhase) {
      blueprintPhaseRepository.updateStatus(reviewPhase.id, 'active')
    }

    blueprintRepository.updateStatus(blueprintId, 'reviewing')
    blueprintRepository.update(blueprintId, { currentPhase: 'review' })

    // 2. Assemble context (includes spec + clarify + plan + tasks artifacts)
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'review')

    // 3. Create adapter + session
    const adapter = new BlueprintReviewAdapter({ workspaceId, blueprintId, phaseContext })

    const blueprint = blueprintService.getBlueprint(blueprintId)
    adapter.setGoalCondition(buildReviewGoalCondition(blueprint?.title ?? 'Unknown'))

    const session = new AgentSessionService(adapter)

    // 4. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'review'
    } satisfies BlueprintPhaseStartPayload)

    // 5. Wire streaming — named handlers for cleanup
    const onChunk = (chunk: StreamChunk): void => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'review',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    }
    const onStatus = (status: AgentStatus): void => {
      this.emit('status', { workspaceId, status })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    try {
      // 6. Start session + send with timeout + abort race
      await session.start(workspacePath, 'plan')

      const syntheticConvId = `blueprint-review-${blueprintId}-${Date.now()}`

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('REVIEW phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('Phase cancelled'))
          return
        }
        abortSignal?.addEventListener('abort', () => reject(new Error('Phase cancelled')), {
          once: true
        })
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text)

      // 8. Save phase artifact
      if (reviewPhase) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'review',
          contentMd: text,
          contentJson: completion ?? undefined
        })
        blueprintPhaseRepository.setConversation(reviewPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(reviewPhase.id, 'complete')
      }

      bpLog.info(
        `[startReviewPhase] Blueprint ${blueprintId} — review complete, recommendation: ${completion?.recommendation ?? 'unknown'}`
      )

      // 9. Emit phaseComplete
      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'review',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (reviewPhase) {
        this.emit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'review',
          artifact: { type: 'review', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // 10. Emit approval gate — human must approve before BUILD
      const planSummary = this.buildApprovalSummary(completion)
      this.emit('approvalNeeded', {
        blueprintId,
        workspaceId,
        phase: 'review',
        planSummary
      } satisfies BlueprintApprovalNeededPayload)

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

      const partialText = session.getStreamedContent()
      if (partialText && reviewPhase) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'review-partial',
          contentMd: partialText
        })
      }

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'review',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      session.removeListener('chunk', onChunk)
      session.removeListener('statusUpdate', onStatus)
      await session.stop()
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
      | { critical?: number; high?: number; medium?: number; low?: number }
      | undefined
    const recommendation = (completion.recommendation as string) ?? 'unknown'
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

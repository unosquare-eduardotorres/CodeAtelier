/**
 * BlueprintPlanService — orchestrates the PLAN phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the planning request,
 * parses both the blueprint-plan artifact and the phase completion block.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { AgentSessionService } from './agent-session.service'
import { BlueprintPlanAdapter } from './role-adapters/blueprint/blueprint-plan.adapter'
import { buildPlanGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, parseBlueprintPlan } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-plan')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintPlanService extends EventEmitter {
  async startPlanPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startPlanPhase] Blueprint ${blueprintId} — starting PLAN`)

    // 1. Pipeline + DB state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'plan')

    const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
    if (planPhase) {
      blueprintPhaseRepository.updateStatus(planPhase.id, 'active')
    }

    blueprintRepository.updateStatus(blueprintId, 'planning')
    blueprintRepository.update(blueprintId, { currentPhase: 'plan' })

    // 2. Assemble context (includes spec + clarify artifacts from prior phases)
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'plan')

    // 3. Create adapter + session
    const adapter = new BlueprintPlanAdapter({ workspaceId, blueprintId, phaseContext })

    const blueprint = blueprintService.getBlueprint(blueprintId)
    adapter.setGoalCondition(buildPlanGoalCondition(blueprint?.title ?? 'Unknown'))

    const session = new AgentSessionService(adapter)

    // 4. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'plan'
    } satisfies BlueprintPhaseStartPayload)

    // 5. Wire streaming
    session.on('chunk', (chunk: StreamChunk) => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'plan',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    })

    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId, status })
    })

    try {
      // 6. Start session + send with timeout
      await session.start(workspacePath, 'plan')

      const syntheticConvId = `blueprint-plan-${blueprintId}-${Date.now()}`

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('PLAN phase timeout')), PHASE_TIMEOUT_MS)
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
        await Promise.race([sendPromise, timeoutPromise, abortPromise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined
      const planJson = parseBlueprintPlan(text)

      // 8. Save artifacts
      if (planPhase) {
        blueprintPhaseRepository.appendArtifact(planPhase.id, {
          type: 'plan',
          contentMd: text,
          contentJson: planJson ?? undefined
        })
        blueprintPhaseRepository.setConversation(planPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(planPhase.id, 'complete')
      }

      // 9. Advance to TASKS phase
      // BP-04: Use correct status 'tasking' (not 'planning') for tasks phase
      blueprintRepository.updateStatus(blueprintId, 'tasking')
      blueprintRepository.update(blueprintId, { currentPhase: 'tasks' })

      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'tasks')
      if (tasksPhase) {
        blueprintPhaseRepository.updateStatus(tasksPhase.id, 'active')
      }

      bpLog.info(`[startPlanPhase] Blueprint ${blueprintId} — plan complete, advancing to TASKS`)

      // 10. Emit events
      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'plan',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (planPhase) {
        this.emit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'plan',
          artifact: { type: 'plan', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }
    } catch (err) {
      bpLog.error(`[startPlanPhase] PLAN phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status set by blueprintService.cancel()
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (planPhase) {
          blueprintPhaseRepository.updateStatus(planPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session.getStreamedContent()
      if (partialText && planPhase) {
        blueprintPhaseRepository.appendArtifact(planPhase.id, {
          type: 'plan-partial',
          contentMd: partialText
        })
      }

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'plan',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      await session.stop()
      blueprintService.markPipelineStopped(workspaceId)
    }
  }

  /** Cancel active PLAN session for a blueprint (called from IPC cancel handler). */
  async cancelBlueprint(_blueprintId: string): Promise<void> {
    // PLAN is one-shot — cancellation is handled by the AbortController
    // in blueprintService.cancel(). No session map to clean up.
  }

  async shutdown(): Promise<void> {
    // One-shot — no persistent sessions to clean up.
  }
}

export const blueprintPlanService = new BlueprintPlanService()

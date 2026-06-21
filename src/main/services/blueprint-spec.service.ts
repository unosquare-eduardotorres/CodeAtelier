/**
 * BlueprintSpecService — orchestrates the SPECIFY and CLARIFY phases of the Blueprint pipeline.
 *
 * Follows the MpaOrchestrationService pattern: EventEmitter, per-workspace state,
 * AgentSessionService-backed phase execution, structured output parsing.
 *
 * SPECIFY: one-shot — sends one message, parses completion block.
 * CLARIFY: interactive — keeps session alive for multi-turn Q&A.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { AgentSessionService } from './agent-session.service'
import { BlueprintSpecifyAdapter } from './role-adapters/blueprint/blueprint-specify.adapter'
import { BlueprintClarifyAdapter } from './role-adapters/blueprint/blueprint-clarify.adapter'
import { buildSpecifyGoalCondition, buildClarifyGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import type {
  BlueprintPhaseCompletion,
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  GrillDecisionForBlueprint
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-spec')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min per phase

// ── Per-Blueprint Session State ──

interface BlueprintSessionState {
  session: AgentSessionService
  conversationId: string
  blueprintId: string
  workspaceId: string
}

// ── Service ──

export class BlueprintSpecService extends EventEmitter {
  /** Active CLARIFY sessions keyed by blueprintId — needed for follow-up sends. */
  private clarifySessions = new Map<string, BlueprintSessionState>()

  // ═══════════════════════════════════════════════════════════════════════════
  //  SPECIFY Phase — One-Shot
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the SPECIFY phase for a blueprint. Non-blocking — emits events.
   * Creates a fresh AgentSessionService, sends the specification request,
   * parses the completion block, and stores the spec artifact.
   */
  async startSpecifyPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    description: string
    grillDecisions?: GrillDecisionForBlueprint[]
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath, description, grillDecisions } = params

    bpLog.info(`[startSpecifyPhase] Blueprint ${blueprintId} — starting SPECIFY`)

    // 1. Update blueprint status → 'specifying'
    const blueprint = blueprintService.getBlueprint(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    // Update pipeline state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'specify')

    // 2. Update phase record → 'active'
    const specifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'specify')
    if (specifyPhase) {
      blueprintPhaseRepository.updateStatus(specifyPhase.id, 'active')
    }

    // Update blueprint status
    blueprintRepository.updateStatus(blueprintId, 'specifying')
    blueprintRepository.update(blueprintId, { currentPhase: 'specify' })

    // 3. Assemble phase context
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'specify')

    // 4. Create adapter
    const adapter = new BlueprintSpecifyAdapter({
      workspaceId,
      blueprintId,
      description,
      grillDecisions,
      phaseContext
    })

    // 5. Set goal condition
    adapter.setGoalCondition(buildSpecifyGoalCondition(blueprint.title))

    // 6. Create session
    const session = new AgentSessionService(adapter)

    // 7. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'specify'
    } satisfies BlueprintPhaseStartPayload)

    // 8. Wire streaming events
    session.on('chunk', (chunk: StreamChunk) => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'specify',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    })

    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId, status })
    })

    try {
      // 9. Start session in plan mode (read-only)
      await session.start(workspacePath, 'plan')

      // 10. Create synthetic conversation ID and send
      const syntheticConvId = `blueprint-specify-${blueprintId}-${Date.now()}`

      // Timeout + abort race
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('SPECIFY phase timeout')), PHASE_TIMEOUT_MS)
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

      // 11. Get accumulated text and parse completion
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined

      // 12. Save spec artifact to phase
      if (specifyPhase) {
        blueprintPhaseRepository.appendArtifact(specifyPhase.id, {
          type: 'spec',
          contentMd: text,
          contentJson: completion ? (completion as unknown as Record<string, unknown>) : undefined
        })

        blueprintPhaseRepository.setConversation(specifyPhase.id, syntheticConvId)
      }

      // 13. Advance to CLARIFY phase (both needs_clarification and complete go here)
      if (specifyPhase) {
        blueprintPhaseRepository.updateStatus(specifyPhase.id, 'complete')
      }
      blueprintRepository.updateStatus(blueprintId, 'clarifying')
      blueprintRepository.update(blueprintId, { currentPhase: 'clarify' })

      const clarifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'clarify')
      if (clarifyPhase) {
        blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'active')
      }

      const needsClarification = completion?.status === 'needs_clarification'
      bpLog.info(
        `[startSpecifyPhase] Blueprint ${blueprintId} — spec ${needsClarification ? 'needs clarification' : 'complete'}, advancing to CLARIFY`
      )

      // 14. Emit phaseComplete
      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'specify',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      // Emit artifact event
      if (specifyPhase) {
        this.emit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'specify',
          artifact: {
            type: 'spec',
            contentMd: text
          }
        } satisfies BlueprintPhaseArtifactPayload)
      }
    } catch (err) {
      bpLog.error(`[startSpecifyPhase] SPECIFY phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status set by blueprintService.cancel()
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (specifyPhase) {
          blueprintPhaseRepository.updateStatus(specifyPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      // Still save partial output regardless of cancel/fail
      const partialText = session.getStreamedContent()
      if (partialText && specifyPhase) {
        blueprintPhaseRepository.appendArtifact(specifyPhase.id, {
          type: 'spec-partial',
          contentMd: partialText
        })
      }

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'specify',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      await session.stop()

      // Clean up pipeline state
      blueprintService.markPipelineStopped(workspaceId)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CLARIFY Phase — Interactive Multi-Turn
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the CLARIFY phase for a blueprint. Interactive — user answers questions.
   * The first turn triggers gap analysis; follow-up turns are user answers via sendClarifyAnswer().
   */
  async startClarifyPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startClarifyPhase] Blueprint ${blueprintId} — starting CLARIFY`)

    // Mark pipeline running so getPipelineStatus() reflects CLARIFY activity
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'clarify')

    // 1. Update blueprint status → 'clarifying'
    blueprintRepository.updateStatus(blueprintId, 'clarifying')

    // 2. Update phase record → 'active'
    const clarifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'clarify')
    if (clarifyPhase && clarifyPhase.status !== 'active') {
      blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'active')
    }

    // 3. Assemble phase context (includes spec from SPECIFY)
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'clarify')

    // 4. Create adapter
    const adapter = new BlueprintClarifyAdapter({
      workspaceId,
      blueprintId,
      phaseContext
    })

    // 5. Set goal condition
    adapter.setGoalCondition(buildClarifyGoalCondition())

    // 6. Create session
    const session = new AgentSessionService(adapter)
    const syntheticConvId = `blueprint-clarify-${blueprintId}-${Date.now()}`

    // Store session reference for follow-up user messages
    this.clarifySessions.set(blueprintId, {
      session,
      conversationId: syntheticConvId,
      blueprintId,
      workspaceId
    })

    // 7. Wire streaming events
    session.on('chunk', (chunk: StreamChunk) => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'clarify',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    })

    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId, status })
    })

    // 8. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'clarify'
    } satisfies BlueprintPhaseStartPayload)

    try {
      // 9. Start session and send first message (triggers gap analysis)
      await session.start(workspacePath, 'plan')
      await session.send(adapter.getPhaseMessage(), syntheticConvId)

      // Check if the first turn already produced a completion block
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined

      if (completion) {
        // Clarify completed in first turn (no gaps found)
        await this.finalizeClarifyPhase(blueprintId, workspaceId, text, completion)
      }
      // Otherwise, session stays alive waiting for sendClarifyAnswer()
    } catch (err) {
      bpLog.error(`[startClarifyPhase] CLARIFY phase failed:`, err)
      this.clarifySessions.delete(blueprintId)

      if (clarifyPhase) {
        blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'failed')
      }
      blueprintRepository.updateStatus(blueprintId, 'failed')
      blueprintService.markPipelineStopped(workspaceId)

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'clarify',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)

      await session.stop()
    }
  }

  /**
   * Send a user answer during the CLARIFY phase.
   * Continues the interactive Q&A session.
   */
  async sendClarifyAnswer(params: {
    blueprintId: string
    workspaceId: string
    message: string
  }): Promise<void> {
    const { blueprintId, workspaceId, message } = params

    const sessionState = this.clarifySessions.get(blueprintId)
    if (!sessionState) {
      throw new Error(`No active CLARIFY session for blueprint ${blueprintId}`)
    }

    bpLog.info(`[sendClarifyAnswer] Blueprint ${blueprintId} — sending user answer`)

    try {
      // Send user answer to the existing session
      await sessionState.session.send(message, sessionState.conversationId)

      // Check accumulated text for completion block
      const text = sessionState.session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined

      if (completion) {
        // Clarify phase complete — agent is satisfied
        await this.finalizeClarifyPhase(blueprintId, workspaceId, text, completion)
      }
      // Otherwise, session stays alive for more Q&A
    } catch (err) {
      bpLog.error(`[sendClarifyAnswer] Failed to send answer:`, err)
      throw err
    }
  }

  /**
   * Skip the CLARIFY phase (spec is clear enough).
   * Delegates to blueprintService.skipPhase().
   */
  async skipClarifyPhase(blueprintId: string): Promise<void> {
    bpLog.info(`[skipClarifyPhase] Blueprint ${blueprintId} — skipping CLARIFY`)

    // Clean up any active session
    const sessionState = this.clarifySessions.get(blueprintId)
    if (sessionState) {
      await sessionState.session.stop()
      this.clarifySessions.delete(blueprintId)
      blueprintService.markPipelineStopped(sessionState.workspaceId)
    }
    blueprintService.skipPhase(blueprintId, 'clarify')

    this.emit('phaseComplete', {
      blueprintId,
      workspaceId: sessionState?.workspaceId ?? '',
      phase: 'clarify',
      status: 'skipped'
    } satisfies BlueprintPhaseCompletePayload)
  }

  // ── Internal Helpers ──

  /**
   * Finalize the CLARIFY phase: save artifacts, clean up session, advance status.
   */
  private async finalizeClarifyPhase(
    blueprintId: string,
    workspaceId: string,
    text: string,
    completion: BlueprintPhaseCompletion
  ): Promise<void> {
    bpLog.info(`[finalizeClarifyPhase] Blueprint ${blueprintId} — CLARIFY complete`)

    // Save clarify artifacts
    const clarifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'clarify')
    if (clarifyPhase) {
      blueprintPhaseRepository.appendArtifact(clarifyPhase.id, {
        type: 'clarify-qa',
        contentMd: text,
        contentJson: completion as unknown as Record<string, unknown>
      })
      blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'complete')
    }

    // Clean up session
    const sessionState = this.clarifySessions.get(blueprintId)
    if (sessionState) {
      if (clarifyPhase) {
        blueprintPhaseRepository.setConversation(clarifyPhase.id, sessionState.conversationId)
      }
      await sessionState.session.stop()
      this.clarifySessions.delete(blueprintId)
    }

    blueprintService.markPipelineStopped(workspaceId)

    // Advance to next phase (plan)
    blueprintService.advancePhase(blueprintId)

    // Emit events
    this.emit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'clarify',
      status: 'complete',
      completion
    } satisfies BlueprintPhaseCompletePayload)

    this.emit('phaseArtifact', {
      blueprintId,
      workspaceId,
      phase: 'clarify',
      artifact: {
        type: 'clarify-qa',
        contentMd: text
      }
    } satisfies BlueprintPhaseArtifactPayload)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle & Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a CLARIFY session is active for a blueprint.
   */
  hasClarifySession(blueprintId: string): boolean {
    return this.clarifySessions.has(blueprintId)
  }

  /**
   * Cancel any active sessions for a blueprint.
   */
  async cancelBlueprint(blueprintId: string): Promise<void> {
    const sessionState = this.clarifySessions.get(blueprintId)
    if (!sessionState) return

    const { workspaceId } = sessionState
    await sessionState.session.stop()
    this.clarifySessions.delete(blueprintId)
    blueprintService.markPipelineStopped(workspaceId)

    this.emit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'clarify',
      status: 'failed'
    } satisfies BlueprintPhaseCompletePayload)
  }

  /**
   * Shut down all active sessions.
   */
  async shutdown(): Promise<void> {
    for (const [blueprintId, state] of this.clarifySessions) {
      bpLog.info(`[shutdown] Stopping CLARIFY session for blueprint ${blueprintId}`)
      await state.session.stop()
    }
    this.clarifySessions.clear()
  }
}

// ── Singleton Export ──

export const blueprintSpecService = new BlueprintSpecService()

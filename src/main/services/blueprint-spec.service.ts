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
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
  STALL_TIMEOUT_MS,
  wireAskUserAutoResponder
} from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintSpecifyAdapter } from './role-adapters/blueprint/blueprint-specify.adapter'
import {
  buildReferenceDocsBlock,
  loadAllReferenceDocuments,
  splitBinaryDocs
} from './blueprint-document-loader'
import { memoryExtractionService } from './memory-extraction.service'
import { BlueprintClarifyAdapter } from './role-adapters/blueprint/blueprint-clarify.adapter'
import { buildSpecifyGoalCondition, buildClarifyGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, parseDiscoveriesBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import { modelConfigService } from './model-config.service'
import { blueprintPlanService } from './blueprint-plan.service'
import { codeGraphService } from './code-graph.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import { workspaceRepository, conversationRepository } from '../db/repositories'
import {
  parseClarifyFindings,
  parseClarifyQuestions,
  parseClarifyCompletion,
  deduplicateClarifyQuestions,
  clarifyQuestionKey,
  grillQuestionsToClarifyBlock
} from '../../shared/blueprint-clarify-parsers'
import type {
  ClarifyFindingsBlock,
  ClarifyQuestionsBlock,
  ClarifyQuestion
} from '../../shared/blueprint-clarify-parsers'
import type {
  BlueprintPhaseCompletion,
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  GrillDecisionForBlueprint
} from '../../shared/blueprint-types'
import type { GrillQuestion } from '../../shared/types'

const bpLog = log.scope('blueprint-spec')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min per phase

const RESOLVED_CLARIFICATIONS_HEADING = '## Resolved Clarifications'

/**
 * Strip a previously-appended "## Resolved Clarifications" block from a spec markdown string.
 * This makes re-running finalizeClarifyPhase idempotent — no duplicate blocks.
 * Exported for testing.
 */
export function stripClarificationsSection(md: string): string {
  const idx = md.indexOf(RESOLVED_CLARIFICATIONS_HEADING)
  if (idx === -1) return md
  return md.slice(0, idx).trimEnd()
}

/**
 * Corrective nudge sent when the model's turn yields zero parseable fenced blocks.
 * Uses the EXACT fence names the parsers expect (blueprint-clarify-findings, etc.).
 * Exported so unit tests can validate fence-name alignment with the parser regexes.
 */
export const CLARIFY_CORRECTION_MESSAGE =
  'Your last turn contained none of the required fenced blocks. ' +
  'Re-emit the findings block (```blueprint-clarify-findings) and either a questions block ' +
  '(```blueprint-clarify-questions) or the completion block (```blueprint-phase-complete).'

// ── Per-Blueprint Session State ──

interface BlueprintSessionState {
  session: AgentSessionService
  conversationId: string
  blueprintId: string
  workspaceId: string
  /** Mutable stall watchdog — set before each send, cleared after. */
  activeWatchdog: PhaseActivityWatchdog | null
  /** B2-FIX: Pending ask_user requestId — set when the model calls ask_user during clarify. */
  pendingAskUserRequestId: string | null
}

// ── Service ──

/** Pending gate state: completion + findings stored when clarify completes, pending user "proceed" action. */
interface ClarifyGateState {
  completion: BlueprintPhaseCompletion
  findings: ClarifyFindingsBlock | null
  workspaceId: string
  text: string
}

export class BlueprintSpecService extends EventEmitter {
  /** Active CLARIFY sessions keyed by blueprintId — needed for follow-up sends. */
  private clarifySessions = new Map<string, BlueprintSessionState>()
  /** Gate states: completion arrived but user hasn't clicked "Continue to Plan" yet. */
  private pendingGates = new Map<string, ClarifyGateState>()
  /**
   * B1-FIX: Cache the latest findings per blueprint so the completion turn
   * (which may omit the findings block) can still populate the gate payload.
   */
  private latestFindingsByBlueprint = new Map<string, ClarifyFindingsBlock>()
  /**
   * B2-FIX: Track the last-emitted clarify UI state per blueprint so
   * getPipelineStatus can hydrate the renderer after reload.
   */
  private clarifyUiState = new Map<
    string,
    {
      questions: ClarifyQuestionsBlock | null
      awaitingInput: boolean
    }
  >()
  /** Track all previously asked questions per blueprint (bookkeeping / diagnostics). */
  private previouslyAskedQuestions = new Map<string, ClarifyQuestion[]>()
  /**
   * RE-SURFACE-FIX: questions the user has actually ANSWERED, per blueprint.
   * Dedupe runs against this rather than `previouslyAskedQuestions` because the
   * clarify prompt tells the model to re-emit still-unanswered questions on
   * resume ("Session Resume" section). Deduping those away dropped every
   * question, degraded the turn to the free-text fallback, and left the user
   * with no route back to the option cards.
   */
  private answeredQuestions = new Map<string, ClarifyQuestion[]>()
  /** M4: Track whether a corrective nudge has been attempted for the current turn. */
  private correctionAttempted = new Map<string, boolean>()

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

  /**
   * M9: Push clarify UI state to blueprintService for snapshot assembly.
   * Eliminates the require() hack in getSnapshot().
   */
  private pushClarifyState(blueprintId: string, workspaceId: string): void {
    const uiState = this.clarifyUiState.get(blueprintId)
    const findings = this.latestFindingsByBlueprint.get(blueprintId) ?? null
    const questions = uiState?.questions ?? null
    blueprintService.setClarifyState(workspaceId, { findings, questions })
  }

  /**
   * Append questions to the per-blueprint "asked" ledger without duplicating
   * entries — a re-surfaced question is asked twice but recorded once.
   */
  private mergeAsked(blueprintId: string, incoming: ClarifyQuestion[]): ClarifyQuestion[] {
    const prev = this.previouslyAskedQuestions.get(blueprintId) ?? []
    const seen = new Set(prev.map(clarifyQuestionKey))
    return [...prev, ...incoming.filter((q) => !seen.has(clarifyQuestionKey(q)))]
  }

  /**
   * RE-SURFACE-FIX: record the questions currently on screen as answered.
   * Called when the user submits an answer — from that point on, a verbatim
   * re-emission of those questions is a genuine duplicate and gets dropped,
   * while anything still outstanding stays eligible to re-surface.
   */
  private markPendingAnswered(blueprintId: string): void {
    const pending = this.clarifyUiState.get(blueprintId)?.questions?.questions ?? []
    if (pending.length === 0) return
    const answered = this.answeredQuestions.get(blueprintId) ?? []
    const seen = new Set(answered.map(clarifyQuestionKey))
    this.answeredQuestions.set(blueprintId, [
      ...answered,
      ...pending.filter((q) => !seen.has(clarifyQuestionKey(q)))
    ])
  }

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
    referenceDocuments?: Array<{ type: string; path: string; name?: string }>
  }): Promise<void> {
    const {
      blueprintId,
      workspaceId,
      workspacePath,
      description,
      grillDecisions,
      referenceDocuments
    } = params

    bpLog.info(`[startSpecifyPhase] Blueprint ${blueprintId} — starting SPECIFY`)

    // 1. Update blueprint status → 'specifying'
    const blueprint = blueprintService.getBlueprint(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
    // finally's markPipelineStopped() is guaranteed to run.
    let specifyPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> =
      undefined
    let session: AgentSessionService | null = null
    // BP-CHAIN-SPECIFY-CLARIFY: Method-local (not instance field) to avoid race across concurrent workspaces.
    let pendingClarifyDispatch: {
      blueprintId: string
      workspaceId: string
      workspacePath: string
    } | null = null
    let cleanupAskUser: (() => void) | undefined
    // BP-CATCH-SCOPE-01: Hoisted outside try so the catch block (partial-output save) can read it.
    let syntheticConvId: string | undefined

    try {
      // Update pipeline state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'specify')

      // 2. Update phase record → 'active'
      specifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'specify')
      if (specifyPhase) {
        blueprintPhaseRepository.updateStatus(specifyPhase.id, 'active')
      }

      // Update blueprint status
      blueprintRepository.updateStatus(blueprintId, 'specifying')
      blueprintRepository.update(blueprintId, { currentPhase: 'specify' })

      // 3. Assemble phase context (includes pre-loaded workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'specify',
        workspacePath
      )

      // 3b. Surface code-graph index status — warn when repomap is enabled
      // but no persisted index exists. The agent will still start, but its
      // code-graph tool calls will return empty results and it will fall back
      // to Glob/Read for codebase exploration.
      const wsSettings = workspaceRepository.getSettings(workspaceId)
      const repomapEnabled = wsSettings.repomapEnabled !== false
      if (repomapEnabled && !codeGraphService.hasPersistedIndex(workspaceId)) {
        bpLog.warn(
          `[startSpecifyPhase] Blueprint ${blueprintId} — code-graph index not built for workspace ${workspaceId}. ` +
            `Agent will fall back to file reads. Build the index in Code Intelligence.`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'specify',
          text: '⚠️ Code graph index not built — agent will fall back to file reads. Build it in Code Intelligence for better results.'
        })
      }

      // 3c. Load reference documents (if provided)
      const mappedDocs = referenceDocuments?.map((d) => ({
        type: d.type as 'file' | 'workspace-file' | 'url',
        path: d.path,
        name: d.name
      }))
      const docsResult = mappedDocs?.length
        ? await buildReferenceDocsBlock(workspacePath, mappedDocs)
        : undefined
      const referenceDocsBlock = docsResult?.block

      // Phase 5.3: Surface reference doc failures as visible warnings
      if (docsResult?.failedDocs.length) {
        const failedNames = docsResult.failedDocs.join(', ')
        bpLog.warn(`[startSpecifyPhase] Reference docs unavailable: ${failedNames}`)
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'specify',
          text: `⚠️ Reference documents unavailable: ${failedNames} — proceeding without them.`
        })
      }

      // 3d. MEM-DOC-SPECIFY-01: Extract memories from reference documents.
      // Moved here from BLUEPRINT_CREATE — covers create, createFromIdea, resume, and retry paths.
      // Uses loadAllReferenceDocuments (already loaded by buildReferenceDocsBlock internally,
      // cheap for text; URLs may double-fetch but extraction is async/queued anyway).
      // Gated by captureDocumentsOnAttach setting (default ON).
      const docAttachEnabled = (wsSettings as any).memoryCaptureDocumentsOnAttach !== false
      if (docAttachEnabled && mappedDocs && mappedDocs.length > 0) {
        const { textDocs } = splitBinaryDocs(mappedDocs)
        if (textDocs.length > 0) {
          const loaded = await loadAllReferenceDocuments(workspacePath, textDocs)
          for (const ld of loaded) {
            if (ld.content.length < 20) continue
            memoryExtractionService.enqueue(async () => {
              try {
                await memoryExtractionService.extractFromContent(
                  workspaceId,
                  workspacePath,
                  ld.doc.name ?? ld.doc.path,
                  ld.content,
                  undefined,
                  { tags: ['blueprint', `blueprint:${blueprintId}`] }
                )
              } catch (err) {
                bpLog.warn(
                  `[startSpecifyPhase] Failed to extract memory from doc "${ld.doc.name}": ${err}`
                )
              }
            })
          }
          bpLog.info(
            `[startSpecifyPhase] Enqueued memory extraction for ${textDocs.length} reference doc(s)`
          )
        }
      }

      // 4. Create adapter
      const adapter = new BlueprintSpecifyAdapter({
        workspaceId,
        blueprintId,
        description,
        grillDecisions,
        phaseContext,
        referenceDocsBlock
      })

      // 5. Set goal condition
      adapter.setGoalCondition(buildSpecifyGoalCondition(blueprint.title))

      // 6. Create session
      session = new AgentSessionService(adapter)

      // 7. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'specify',
        goal: buildSpecifyGoalCondition(blueprint.title)
      } satisfies BlueprintPhaseStartPayload)

      // 8. Wire streaming events + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'SPECIFY')

      session.on('chunk', (chunk: StreamChunk) => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'specify',
          workspacePath,
          mode: 'plan'
        })
      })

      session.on('statusUpdate', (status: AgentStatus) => {
        this.safeEmit('status', { workspaceId, status })
      })

      // B4-FIX: Auto-respond to ask_user calls — specify is non-interactive
      cleanupAskUser = wireAskUserAutoResponder(session, 'SPECIFY')

      // 9. Start session in plan mode (read-only)
      await session.start(workspacePath, 'plan')

      // 10. Create or reuse synthetic conversation ID
      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const specPhaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(
        blueprintId,
        'specify'
      )
      const priorConvId = specPhaseRecord?.conversationId
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        // Guard: if model/provider changed between attempts, session resume is invalid
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
          bpLog.info(`[startSpecifyPhase] Resuming conversation ${priorConvId} from failed attempt`)
        } else {
          syntheticConvId = `blueprint-specify-${blueprintId}-${Date.now()}`
          bpLog.info(`[startSpecifyPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-specify-${blueprintId}-${Date.now()}`
      }

      // Persist conversation ID early so retries can find it
      if (specPhaseRecord) {
        try {
          blueprintPhaseRepository.setConversation(specPhaseRecord.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
      }

      // Timeout + stall watchdog + abort race
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
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // 11. Get accumulated text and parse completion
      const text = session.getStreamedContent(syntheticConvId)
      const completion = parsePhaseCompletionBlock(text, 'specify') ?? undefined

      // 12. Save spec artifact to phase
      if (specifyPhase) {
        blueprintPhaseRepository.appendArtifact(specifyPhase.id, {
          type: 'spec',
          contentMd: text,
          contentJson: completion ? (completion as unknown as Record<string, unknown>) : undefined
        })

        blueprintPhaseRepository.setConversation(specifyPhase.id, syntheticConvId)

        // 12b. Save discoveries artifact (if emitted)
        const discoveries = parseDiscoveriesBlock(text)
        if (discoveries?.length) {
          blueprintPhaseRepository.appendArtifact(specifyPhase.id, {
            type: 'discoveries',
            contentJson: { phase: 'specify', entries: discoveries }
          })
        }
      }

      // 13. Advance to CLARIFY phase (both needs_clarification and complete go here)
      if (specifyPhase) {
        blueprintPhaseRepository.updateStatus(specifyPhase.id, 'complete')
        // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
        if (specifyPhase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(specifyPhase.id, null)
        }
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
      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'specify',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      // Emit artifact event
      if (specifyPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'specify',
          artifact: {
            type: 'spec',
            contentMd: text
          }
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // BP-CHAIN-SPECIFY-CLARIFY: Auto-dispatch CLARIFY after SPECIFY completes.
      // Release pipeline lock first (in finally), then dispatch non-blocking.
      // Guard: skip dispatch if blueprint was cancelled during the phase.
      pendingClarifyDispatch = {
        blueprintId,
        workspaceId,
        workspacePath
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
      const partialText = session?.getStreamedContent(syntheticConvId)
      if (partialText && specifyPhase) {
        blueprintPhaseRepository.appendArtifact(specifyPhase.id, {
          type: 'spec-partial',
          contentMd: partialText
        })
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try {
        blueprintService.saveRetryContext(blueprintId, 'specify', { error: errorMsg })
      } catch {
        /* best effort — don't let context capture block error reporting */
      }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId,
        workspaceId,
        workspacePath,
        phase: 'specify',
        error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'specify',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      cleanupAskUser?.()
      if (session) {
        await session.stop()
      }

      // Clean up pipeline state
      blueprintService.markPipelineStopped(workspaceId)

      // BP-CHAIN-SPECIFY-CLARIFY: Dispatch clarify AFTER releasing the pipeline lock
      // so markPipelineRunning() in startClarifyPhase doesn't throw.
      if (pendingClarifyDispatch) {
        const pendingClarify = pendingClarifyDispatch
        const currentStatus = blueprintRepository.findById(pendingClarify.blueprintId)?.status
        if (currentStatus !== 'cancelled') {
          try {
            this.startClarifyPhase(pendingClarify).catch((err) => {
              bpLog.error('[specify→clarify] Clarify phase failed:', err)
            })
          } catch (syncErr) {
            bpLog.error('[specify→clarify] Clarify startup failed (sync):', syncErr)
          }
        }
      }
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

    // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
    // markPipelineStopped() is guaranteed to run on failure.
    let clarifyPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> =
      undefined
    let session: AgentSessionService | null = null

    try {
      // Mark pipeline running so getPipelineStatus() reflects CLARIFY activity
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'clarify')

      // 1. Update blueprint status → 'clarifying'
      blueprintRepository.updateStatus(blueprintId, 'clarifying')

      // 2. Update phase record → 'active'
      clarifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'clarify')
      if (clarifyPhase && clarifyPhase.status !== 'active') {
        blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'active')
      }

      // 3. Assemble phase context (includes spec from SPECIFY + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'clarify',
        workspacePath
      )

      // 4. Create adapter
      const adapter = new BlueprintClarifyAdapter({
        workspaceId,
        blueprintId,
        phaseContext
      })

      // 5. Set goal condition
      adapter.setGoalCondition(buildClarifyGoalCondition())

      // 6. Create session
      session = new AgentSessionService(adapter)

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const clarifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(
        blueprintId,
        'clarify'
      )
      const priorClarifyConvId = clarifyPhaseRec?.conversationId
      let syntheticConvId: string
      if (priorClarifyConvId && conversationRepository.getSessionId(priorClarifyConvId)) {
        const priorConv = conversationRepository.findById(priorClarifyConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorClarifyConvId
          bpLog.info(
            `[startClarifyPhase] Resuming conversation ${priorClarifyConvId} from failed attempt`
          )
        } else {
          syntheticConvId = `blueprint-clarify-${blueprintId}-${Date.now()}`
          bpLog.info(`[startClarifyPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-clarify-${blueprintId}-${Date.now()}`
      }

      // Persist conversation ID early so retries can find it
      if (clarifyPhaseRec) {
        try {
          blueprintPhaseRepository.setConversation(clarifyPhaseRec.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
      }

      // Store session reference for follow-up user messages
      this.clarifySessions.set(blueprintId, {
        session,
        conversationId: syntheticConvId,
        blueprintId,
        workspaceId,
        activeWatchdog: null,
        pendingAskUserRequestId: null
      })

      // 7. Wire streaming events — chunk handler touches active watchdog
      session.on('chunk', (chunk: StreamChunk) => {
        const state = this.clarifySessions.get(blueprintId)
        state?.activeWatchdog?.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'clarify',
          workspacePath,
          mode: 'plan'
        })
      })

      session.on('statusUpdate', (status: AgentStatus) => {
        this.safeEmit('status', { workspaceId, status })
      })

      // B2-FIX: Bridge ask_user → structured question card.
      // When the local LLM calls ask_user (via control-actions MCP), intercept it
      // and drive the same question card UI as the fenced-block path.
      session.on('askQuestion', (data: { questions: GrillQuestion[]; requestId?: string }) => {
        const state = this.clarifySessions.get(blueprintId)
        if (!state || !data.requestId) return

        bpLog.info(
          `[askQuestion bridge] Blueprint ${blueprintId} — model called ask_user with ${data.questions.length} questions`
        )

        // Convert GrillQuestion[] → ClarifyQuestionsBlock
        const clarifyBlock = grillQuestionsToClarifyBlock(data.questions)

        // RE-SURFACE-FIX: dedupe against ANSWERED questions only, so re-asking
        // something still outstanding re-opens the card instead of being dropped.
        const answered = this.answeredQuestions.get(blueprintId) ?? []
        const newQuestions = deduplicateClarifyQuestions(clarifyBlock.questions, answered)
        if (newQuestions.length === 0) {
          // Everything here was already answered — auto-respond to unblock the turn
          state.session.respondToAskUser(
            data.requestId,
            'All questions were already answered in previous turns. Proceed with the information you have.'
          )
          return
        }

        // Store requestId so sendClarifyAnswer can route the response back
        state.pendingAskUserRequestId = data.requestId

        // Pause watchdog — user is being prompted
        state.activeWatchdog?.pause()

        // Drive the same UI flow as the fenced-block path
        const questionsBlock: ClarifyQuestionsBlock = { questions: newQuestions }
        this.previouslyAskedQuestions.set(
          blueprintId,
          this.mergeAsked(blueprintId, newQuestions)
        )
        this.clarifyUiState.set(blueprintId, { questions: questionsBlock, awaitingInput: false })
        this.pushClarifyState(blueprintId, workspaceId)
        this.safeEmit('clarifyQuestions', { blueprintId, workspaceId, questions: questionsBlock })
      })

      // 8. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'clarify',
        goal: buildClarifyGoalCondition()
      } satisfies BlueprintPhaseStartPayload)

      // 9. Start session and send first message (triggers gap analysis)
      await session.start(workspacePath, 'plan')

      const clarifyWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'CLARIFY')
      const clarifyState = this.clarifySessions.get(blueprintId)
      if (clarifyState) clarifyState.activeWatchdog = clarifyWatchdog

      try {
        const abortSignal = blueprintService.getAbortSignal(workspaceId)
        const abortPromise = new Promise<void>((_, reject) => {
          const onAbort = (): void => reject(new Error('Phase cancelled'))
          abortSignal?.addEventListener('abort', onAbort, { once: true })
          if (abortSignal?.aborted) onAbort()
        })
        await Promise.race([
          session.send(adapter.getPhaseMessage(), syntheticConvId),
          clarifyWatchdog.promise,
          abortPromise
        ])
      } finally {
        clarifyWatchdog.dispose()
        if (clarifyState) clarifyState.activeWatchdog = null
      }

      // Parse structured blocks from the response
      const text = session.getStreamedContent(syntheticConvId)
      await this.handleClarifyTurnEnd(blueprintId, workspaceId, text)
    } catch (err) {
      bpLog.error(`[startClarifyPhase] CLARIFY phase failed:`, err)
      this.clarifySessions.delete(blueprintId)

      // Guard: don't overwrite 'cancelled' status set by blueprintService.cancel()
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (clarifyPhase) {
          blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try {
        blueprintService.saveRetryContext(blueprintId, 'clarify', { error: errorMsg })
      } catch {
        /* best effort */
      }

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'clarify',
        status: 'failed',
        error: errorMsg
      } satisfies BlueprintPhaseCompletePayload)

      if (session) {
        await session.stop()
      }
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

    // RE-SURFACE-FIX: whatever was on screen has now been answered. Recorded
    // before both the ask_user and session.send paths so either route counts.
    this.markPendingAnswered(blueprintId)

    // Drive state machine: awaiting-clarify-questions/input → phase-running
    const machine = blueprintService.getMachine(workspaceId)
    if (!machine.transition('answerReceived')) {
      bpLog.warn(
        `[sendClarifyAnswer] Machine rejected answerReceived (state=${machine.currentState}) — proceeding anyway`
      )
    }

    // B2-FIX: If the model called ask_user, route the answer via respondToAskUser
    // instead of session.send() — the original turn is still in-flight.
    if (sessionState.pendingAskUserRequestId) {
      const requestId = sessionState.pendingAskUserRequestId
      sessionState.pendingAskUserRequestId = null
      sessionState.activeWatchdog?.resume()

      bpLog.info(`[sendClarifyAnswer] Routing answer via respondToAskUser (requestId=${requestId})`)
      sessionState.session.respondToAskUser(requestId, message)

      // The original send() promise is still being awaited in startClarifyPhase.
      // It will resolve when the model continues its turn after receiving our response.
      // The chunk handler + handleClarifyTurnEnd will process the continuation normally.
      return
    }

    const answerWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'CLARIFY')
    sessionState.activeWatchdog = answerWatchdog

    try {
      // M9: Race send against abort signal + stall watchdog
      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) onAbort()
      })

      const sendPromise = sessionState.session.send(message, sessionState.conversationId)
      await Promise.race([sendPromise, abortPromise, answerWatchdog.promise])

      // Parse structured blocks from the response
      const text = sessionState.session.getStreamedContent(sessionState.conversationId)
      await this.handleClarifyTurnEnd(blueprintId, workspaceId, text)
    } catch (err) {
      bpLog.error(`[sendClarifyAnswer] Failed to send answer:`, err)

      // M5: Recover machine state before rethrowing.
      // If session is dead, fail the pipeline. Otherwise restore to an awaiting state.
      const machine = blueprintService.getMachine(workspaceId)
      if (!this.clarifySessions.has(blueprintId) || !sessionState.session) {
        // Session is dead — fail pipeline
        const errorMsg = err instanceof Error ? err.message : String(err)
        blueprintService.failPipeline(workspaceId, errorMsg)
      } else if (machine.currentState === 'phase-running') {
        // Machine stuck in phase-running after send failure — restore to awaiting
        machine.transition('awaitingInput')
      }
      throw err
    } finally {
      answerWatchdog.dispose()
      sessionState.activeWatchdog = null
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

    const skipWorkspaceId = sessionState?.workspaceId ?? ''
    this.safeEmit('phaseComplete', {
      blueprintId,
      workspaceId: skipWorkspaceId,
      phase: 'clarify',
      status: 'skipped'
    } satisfies BlueprintPhaseCompletePayload)

    // BP-CHAIN-CLARIFY-PLAN: Auto-dispatch PLAN after CLARIFY is skipped.
    const resolvedWorkspaceId =
      skipWorkspaceId || blueprintRepository.findById(blueprintId)?.workspaceId
    if (resolvedWorkspaceId) {
      this.dispatchPlanPhase(blueprintId, resolvedWorkspaceId)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Gate Logic — User-Driven Clarify → Plan Transition
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle the end of a CLARIFY turn (first turn or answer turn).
   * Parses findings/questions/completion blocks, drives machine transitions,
   * and emits appropriate events.
   */
  private async handleClarifyTurnEnd(
    blueprintId: string,
    workspaceId: string,
    text: string
  ): Promise<void> {
    const machine = blueprintService.getMachine(workspaceId)

    // 1. Parse & emit findings (always emitted if present)
    const findings = parseClarifyFindings(text)
    if (findings) {
      // B1-FIX: Cache findings so completion turns that omit findings still have them
      this.latestFindingsByBlueprint.set(blueprintId, findings)
      this.safeEmit('clarifyFindings', { blueprintId, workspaceId, findings })
    }

    // 2. Parse questions (dedupe against questions the user has ALREADY ANSWERED).
    //    RE-SURFACE-FIX: previously this deduped against every question ever
    //    displayed, so the re-emission the prompt asks for on resume ("re-emit
    //    ... any unanswered questions block") was dropped wholesale and the turn
    //    silently degraded to the free-text panel.
    let questions = parseClarifyQuestions(text)
    if (questions && questions.questions.length > 0) {
      const answered = this.answeredQuestions.get(blueprintId) ?? []
      const deduped = deduplicateClarifyQuestions(questions.questions, answered)
      if (deduped.length < questions.questions.length) {
        bpLog.warn(
          `[handleClarifyTurnEnd] Blueprint ${blueprintId} — dropped ${questions.questions.length - deduped.length} already-answered question(s)`
        )
      }
      if (deduped.length === 0) {
        bpLog.warn(
          `[handleClarifyTurnEnd] Blueprint ${blueprintId} — every question was already answered; treating as no new questions`
        )
        questions = null
      } else {
        questions = { questions: deduped }
        // Track for diagnostics; re-surfaced questions are recorded once.
        this.previouslyAskedQuestions.set(blueprintId, this.mergeAsked(blueprintId, deduped))
      }
    }

    // 3. Check for completion
    const completionRaw = parseClarifyCompletion(text)
    const completion = completionRaw
      ? (parsePhaseCompletionBlock(text, 'clarify') ??
        (completionRaw as unknown as BlueprintPhaseCompletion))
      : null

    // M5 (nudge restructure): Hoist the no-next-action check ABOVE the emit cascade.
    // Nudge while still in 'phase-running' — no state transition needed.
    // Only emit awaitingInput after the 1-retry cap is exhausted.
    //
    // NUDGE-FINDINGS-FIX: a findings block alone is NOT a valid way to end a
    // clarify turn — the contract is findings PLUS either questions or the
    // completion block. Keying this check on findings meant a findings-only turn
    // skipped the nudge entirely and fell through to the free-text fallback,
    // which is the very degradation the nudge exists to prevent.
    if (!questions && !completion) {
      const alreadyAttempted = this.correctionAttempted.get(blueprintId) ?? false
      if (!alreadyAttempted) {
        bpLog.warn(
          `[handleClarifyTurnEnd] Blueprint ${blueprintId} — no questions or completion block, sending corrective nudge`
        )
        this.correctionAttempted.set(blueprintId, true)

        const sessionState = this.clarifySessions.get(blueprintId)
        if (sessionState) {
          try {
            // Machine is still in 'phase-running' — no reverse-dance needed
            const correctionMsg = CLARIFY_CORRECTION_MESSAGE

            await sessionState.session.send(correctionMsg, sessionState.conversationId)
            const retryText = sessionState.session.getStreamedContent(sessionState.conversationId)

            // Parse the retry response (recursive but capped by correctionAttempted flag)
            return this.handleClarifyTurnEnd(blueprintId, workspaceId, retryText)
          } catch (err) {
            bpLog.error(`[handleClarifyTurnEnd] Corrective nudge failed:`, err)
            // Fall through to awaitingInput below
          }
        }
      } else {
        bpLog.warn(
          `[handleClarifyTurnEnd] Blueprint ${blueprintId} — still no questions or completion after correction; falling back to awaitingInput`
        )
      }
      // Reset correction flag for next turn
      this.correctionAttempted.delete(blueprintId)

      // Nudge exhausted — fall through to awaitingInput emit
      machine.transition('awaitingInput')
      this.clarifyUiState.set(blueprintId, { questions: null, awaitingInput: true })
      this.pushClarifyState(blueprintId, workspaceId)
      this.safeEmit('clarifyAwaitingInput', { blueprintId, workspaceId })
      return
    }

    // Successful parse — reset correction flag
    this.correctionAttempted.delete(blueprintId)

    // 4. Drive state machine + emit events based on parsed content
    if (completion) {
      // Drive state machine: phase-running → awaiting-clarify-gate
      machine.transition('gateParsed')

      // B1-FIX: Use cached findings when completion turn omits findings block
      const gateFindings = findings ?? this.latestFindingsByBlueprint.get(blueprintId) ?? null
      // Gate: store completion but DON'T finalize — wait for user "proceed"
      this.pendingGates.set(blueprintId, { completion, findings: gateFindings, workspaceId, text })
      // B2-FIX: Clear UI state — gate supersedes questions/awaitingInput
      this.clarifyUiState.set(blueprintId, { questions: null, awaitingInput: false })
      this.pushClarifyState(blueprintId, workspaceId)
      this.safeEmit('clarifyGateReady', {
        blueprintId,
        workspaceId,
        findings: gateFindings,
        questions: null // Completion supersedes pending questions
      })
    } else if (questions && questions.questions.length > 0) {
      // Drive state machine: phase-running → awaiting-clarify-questions
      machine.transition('questionsParsed')

      // Questions block parsed — emit questions (this is the primary input signal)
      // B2-FIX: Track for reload hydration
      this.clarifyUiState.set(blueprintId, { questions, awaitingInput: false })
      this.pushClarifyState(blueprintId, workspaceId)
      this.safeEmit('clarifyQuestions', { blueprintId, workspaceId, questions })
    } else {
      // Drive state machine: phase-running → awaiting-clarify-input
      machine.transition('awaitingInput')

      // Fallback: no structured block parsed — awaiting free-text input
      // B2-FIX: Track for reload hydration
      this.clarifyUiState.set(blueprintId, { questions: null, awaitingInput: true })
      this.pushClarifyState(blueprintId, workspaceId)
      this.safeEmit('clarifyAwaitingInput', { blueprintId, workspaceId })
    }
  }

  /**
   * User clicked "Continue to Plan" — proceed through the gate.
   * Pops gate state → finalizeClarifyPhase → dispatchPlanPhase.
   */
  async proceedClarifyGate(blueprintId: string): Promise<void> {
    const gate = this.pendingGates.get(blueprintId)
    if (!gate) {
      throw new Error(`No pending clarify gate for blueprint ${blueprintId}`)
    }

    // Drive state machine: awaiting-clarify-gate → idle (clarify done)
    const machine = blueprintService.getMachine(gate.workspaceId)
    machine.transition('proceedGate')

    bpLog.info(`[proceedClarifyGate] Blueprint ${blueprintId} — user proceeding to plan`)
    this.pendingGates.delete(blueprintId)
    // M9: Clean up all map lifecycle entries on gate proceed
    this.correctionAttempted.delete(blueprintId)
    this.previouslyAskedQuestions.delete(blueprintId)
    this.answeredQuestions.delete(blueprintId)

    await this.finalizeClarifyPhase(blueprintId, gate.workspaceId, gate.text, gate.completion)
  }

  /**
   * User clicked "Ask more questions" — iterate another round of clarification.
   * Sends an iteration message on the live session.
   */
  async iterateClarify(blueprintId: string): Promise<void> {
    const sessionState = this.clarifySessions.get(blueprintId)
    if (!sessionState) {
      throw new Error(`No active CLARIFY session for blueprint ${blueprintId} — cannot iterate`)
    }

    // Drive state machine: awaiting-clarify-gate → phase-running
    const machine = blueprintService.getMachine(sessionState.workspaceId)
    if (!machine.transition('iterate')) {
      bpLog.warn(
        `[iterateClarify] Machine rejected iterate (state=${machine.currentState}) — proceeding anyway`
      )
    }

    bpLog.info(`[iterateClarify] Blueprint ${blueprintId} — user requesting more rounds`)

    // Clear any pending gate (user chose to continue asking)
    this.pendingGates.delete(blueprintId)

    const iterationMessage =
      'Continue with up to 3 more rounds of clarification. Re-emit the findings block with updated statuses and ask new questions for any remaining outstanding gaps.'

    try {
      // M9: Race send against abort signal
      const abortSignal = blueprintService.getAbortSignal(sessionState.workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) onAbort()
      })

      const sendPromise = sessionState.session.send(iterationMessage, sessionState.conversationId)
      await Promise.race([sendPromise, abortPromise])

      const text = sessionState.session.getStreamedContent(sessionState.conversationId)
      await this.handleClarifyTurnEnd(blueprintId, sessionState.workspaceId, text)
    } catch (err) {
      bpLog.error(`[iterateClarify] Failed:`, err)

      // M5: Recover machine state before rethrowing.
      const machine = blueprintService.getMachine(sessionState.workspaceId)
      if (!this.clarifySessions.has(blueprintId)) {
        // Session is dead — fail pipeline
        const errorMsg = err instanceof Error ? err.message : String(err)
        blueprintService.failPipeline(sessionState.workspaceId, errorMsg)
      } else if (machine.currentState === 'phase-running') {
        // Restore to gate state since iterate came from there
        machine.transition('gateParsed')
      }
      throw err
    }
  }

  /**
   * Get the pending gate state for a blueprint (used by getPipelineStatus for D4).
   */
  getPendingGate(blueprintId: string): ClarifyGateState | undefined {
    return this.pendingGates.get(blueprintId)
  }

  /**
   * Get the latest findings for a blueprint (B1-FIX: uses cached map first).
   */
  getLatestFindings(blueprintId: string): ClarifyFindingsBlock | null {
    // B1-FIX: Check cached findings first (survives across turns)
    const cached = this.latestFindingsByBlueprint.get(blueprintId)
    if (cached) return cached

    const gate = this.pendingGates.get(blueprintId)
    if (gate?.findings) return gate.findings

    const sessionState = this.clarifySessions.get(blueprintId)
    if (!sessionState) return null

    const text = sessionState.session.getStreamedContent(sessionState.conversationId)
    return parseClarifyFindings(text)
  }

  /**
   * B2-FIX: Get the clarify UI state for reload hydration.
   */
  getClarifyUiState(blueprintId: string): {
    awaitingGate: boolean
    latestFindings: ClarifyFindingsBlock | null
    pendingQuestions: ClarifyQuestionsBlock | null
    awaitingInput: boolean
  } {
    const uiState = this.clarifyUiState.get(blueprintId)
    return {
      awaitingGate: this.pendingGates.has(blueprintId),
      latestFindings: this.getLatestFindings(blueprintId),
      pendingQuestions: uiState?.questions ?? null,
      awaitingInput: uiState?.awaitingInput ?? false
    }
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

    // B1/B2-FIX: Clean up cached state for this blueprint
    this.latestFindingsByBlueprint.delete(blueprintId)
    this.clarifyUiState.delete(blueprintId)
    blueprintService.setClarifyState(workspaceId, null)

    // Save clarify artifacts
    const clarifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'clarify')
    if (clarifyPhase) {
      blueprintPhaseRepository.appendArtifact(clarifyPhase.id, {
        type: 'clarify-qa',
        contentMd: text,
        contentJson: completion as unknown as Record<string, unknown>
      })
      blueprintPhaseRepository.updateStatus(clarifyPhase.id, 'complete')
      // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
      if (clarifyPhase.contextSnapshot) {
        blueprintPhaseRepository.saveContextSnapshot(clarifyPhase.id, null)
      }
    }

    // Plan B: Merge resolved clarifications into the specify phase's spec artifact in-place.
    // This makes `plan → [spec]` genuinely correct — the spec becomes the single source of truth.
    const specifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'specify')
    if (specifyPhase) {
      const artifacts = specifyPhase.artifactsJson.map((a) => {
        if (a.type !== 'spec') return a
        // Idempotent: strip any prior clarifications block before re-appending
        const base = stripClarificationsSection(a.contentMd ?? '')
        return {
          ...a,
          contentMd: `${base}\n\n${RESOLVED_CLARIFICATIONS_HEADING}\n\n${text}`.trim()
        }
      })
      blueprintPhaseRepository.saveArtifacts(specifyPhase.id, artifacts)
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
    this.safeEmit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'clarify',
      status: 'complete',
      completion
    } satisfies BlueprintPhaseCompletePayload)

    this.safeEmit('phaseArtifact', {
      blueprintId,
      workspaceId,
      phase: 'clarify',
      artifact: {
        type: 'clarify-qa',
        contentMd: text
      }
    } satisfies BlueprintPhaseArtifactPayload)

    // BP-CHAIN-CLARIFY-PLAN: Auto-dispatch PLAN after CLARIFY completes.
    this.dispatchPlanPhase(blueprintId, workspaceId)
  }

  // ── Chain Dispatch Helpers ──

  /**
   * BP-CHAIN-CLARIFY-PLAN: Dispatch PLAN phase after CLARIFY completes or is skipped.
   * Non-blocking — errors are logged, not thrown. Guards against cancelled status.
   */
  private dispatchPlanPhase(blueprintId: string, workspaceId: string): void {
    const currentStatus = blueprintRepository.findById(blueprintId)?.status
    if (currentStatus === 'cancelled') return

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) {
      bpLog.error(`[clarify→plan] Workspace not found: ${workspaceId}`)
      return
    }

    try {
      blueprintPlanService
        .startPlanPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[clarify→plan] Plan phase failed:', err)
        })
    } catch (syncErr) {
      bpLog.error('[clarify→plan] Plan startup failed (sync):', syncErr)
    }
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
    this.pendingGates.delete(blueprintId)
    // B1/B2-FIX: Clean up cached state
    this.latestFindingsByBlueprint.delete(blueprintId)
    this.clarifyUiState.delete(blueprintId)
    this.correctionAttempted.delete(blueprintId)
    this.previouslyAskedQuestions.delete(blueprintId)
    this.answeredQuestions.delete(blueprintId)

    const sessionState = this.clarifySessions.get(blueprintId)
    if (sessionState) {
      blueprintService.setClarifyState(sessionState.workspaceId, null)
    }
    if (!sessionState) return

    const { workspaceId } = sessionState
    await sessionState.session.stop()
    this.clarifySessions.delete(blueprintId)
    blueprintService.markPipelineStopped(workspaceId)

    this.safeEmit('phaseComplete', {
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
    this.pendingGates.clear()
    // B1/B2-FIX: Clean up all cached state
    this.latestFindingsByBlueprint.clear()
    this.clarifyUiState.clear()
    this.correctionAttempted.clear()
    this.previouslyAskedQuestions.clear()
    this.answeredQuestions.clear()
  }
}

// ── Singleton Export ──

export const blueprintSpecService = new BlueprintSpecService()

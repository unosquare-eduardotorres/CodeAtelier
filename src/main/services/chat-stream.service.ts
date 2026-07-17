import type { BrowserWindow } from 'electron'
import { conversationRepository, messageRepository, workspaceRepository } from '../db/repositories'
import { chatAgentService, fileService } from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  ConversationPhase,
  ElicitationEvent,
  AgentIntent,
  GrillQuestion,
  ImageAttachment,
  PlanDetectedEvent
} from '../../shared/types'
import { memoryExtractionService } from './memory-extraction.service'
import { memoryRetrievalService } from './memory-retrieval.service'
import { eventLoggerService } from './event-logger.service'
import { forwardChunkToRenderer, notifyChunkTaps } from '../ipc/chat-shared'
import {
  flushTextBatcher,
  getAndClearToolActivities,
  recordExternalToolActivity,
  startStreamMetrics,
  completeStreamMetrics
} from '../ipc/chunk-router'
import {
  createTextChunk,
  createToolActivityChunk,
  createCompleteMessage,
  createCompactNeeded,
  type CompactNeededMessage
} from '../ipc/chat-protocol'
import { chatIpcLogger } from '../logger'
import { getSessionEventRouter } from './session-event-router'
import { IntentRouter } from './intent-router'
import { conversationStateMachine } from './conversation-state-machine'
import { lifecycleRegistry, type ConversationLifecycle } from './conversation-lifecycle'
import { hookEngine } from './hook-engine.service'
import { planRegistryService } from './plan-registry.service'
import { promptOptimizerService } from './prompt-optimizer.service'

const log = chatIpcLogger

// ── StreamContext — explicit per-stream state bag ──

/** Immutable per-stream context — replaces the ad-hoc closure state bag. */
interface StreamContext {
  readonly conversationId: string
  readonly requestId: string
  readonly streamingRole: 'specialist'
  readonly phase: ConversationPhase
  readonly specialistMeta: { specialist: string; taskId?: string } | undefined
  readonly adapterAgentId: string
  readonly workspacePath: string | undefined
  /** HEAD sha captured at stream start — for memory extraction git delta. */
  readonly startSha: string | undefined
  /** Accumulated streamed content — mutable, shared across listeners. */
  streamedContent: string
  /** Guards against duplicate plan injection within a single stream. */
  planInjected: boolean
}

// ── Pipeline Callbacks (strategy object) ──
//
// The pipeline callbacks interface is kept to satisfy the legacy
// initChatStream(mainWindow, callbacks) signature but is effectively empty.
// Remove in a future cleanup if no new lifecycle callbacks are added.

export interface PipelineCallbacks {
  onStopPipeline: () => Promise<void>
}

/**
 * Handle returned from stream() — makes the IPC handler lifecycle-aware.
 * Callers can optionally await `done` to know when the entire pipeline
 * the streaming pipeline completes, or call `abort()` to cancel.
 */
export interface StreamHandle {
  /** Resolves when the entire streaming pipeline completes */
  done: Promise<void>
  /** Abort the stream and all sub-operations */
  abort: () => void
  /** The request ID for this stream */
  requestId: string
}

// ── Stream Service ──

export class ChatStreamService {
  private mainWindow: BrowserWindow
  private callbacks: PipelineCallbacks
  private intentRouter: IntentRouter

  /** Per-conversation stop flags — prevents duplicate message saves when stop is called mid-stream */
  private stoppedConversations = new Set<string>()

  /** Per-conversation streaming locks — rejects if that conversation is already streaming */
  private streamingLocks = new Set<string>()
  /** Per-conversation active request IDs */
  private activeRequestIds = new Map<string, string>()

  /** Per-conversation set of already-injected memory fact IDs (prevents re-injection). */
  private injectedFactIds = new Map<string, Set<string>>()

  /** Per-stream identity — set at stream() start, cleared on cleanup. */
  private currentStreamingRole: 'specialist' = 'specialist'

  /**
   * Keepalive timer — sends periodic IPC events to the renderer during streaming.
   * MCP tools (e.g. Maestro run_flow_files) can block the SDK message loop for
   * minutes. Without this, the renderer's 2-minute safety timer fires and
   * disconnects the UI while the backend is still working.
   */
  private keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>()

  /** Cleanup functions for all persistent event listeners registered in registerEventForwarders(). */
  private eventCleanups: Array<() => void> = []

  // CHAT-LEAK-01: Guard against callbacks firing after service disposal.
  // If dispose() runs while a queued callback is in the event loop, the
  // callback would execute against stale state without this flag.
  private isDisposed = false

  // N14: Track hook lifecycle listener for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hookLifecycleHandler?: ((...args: any[]) => void) | undefined

  constructor(mainWindow: BrowserWindow, callbacks: PipelineCallbacks) {
    this.mainWindow = mainWindow
    this.callbacks = callbacks
    this.intentRouter = new IntentRouter(mainWindow)
    this.registerEventForwarders()
  }

  /**
   * Guard all IPC sends against destroyed windows.
   * During streaming the user may close the window — without this guard
   * every webContents.send() throws an unhandled exception.
   * The keepalive timer (30s interval) is particularly dangerous as it
   * fires repeatedly after window destruction.
   */
  private safeWindowSend(channel: string, ...args: unknown[]): void {
    try {
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, ...args)
      }
    } catch (error) {
      log.warn(`Failed to send IPC ${channel}:`, error)
    }
  }

  // ── Persistent Event Forwarders ──

  /**
   * Register once-at-startup event forwarders from agent → renderer.
   *
   * The typed 'intent' event handles all control actions (plan, askUser,
   * grill events) via IntentRouter. Legacy events (plan, grillQuestion,
   * grillComplete, grillEvaluation) are still emitted by the MCP control callbacks
   * for backward compat — their forwarders remain to handle the immediate MCP path.
   *
   * The IntentRouter handles post-stream regex-fallback intents + grill events
   * (which have no MCP tool equivalent and are always regex-detected).
   */
  /** Resolve a workspace name from its ID (for permission toast labels). */
  private resolveWorkspaceName(workspaceId: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load avoids db/repositories circular dependency
      const { workspaceRepository } = require('../db/repositories')
      const workspace = workspaceRepository.findById(workspaceId)
      return workspace?.name ?? workspaceId.slice(0, 8)
    } catch {
      return workspaceId.slice(0, 8)
    }
  }

  private registerEventForwarders(): void {
    // compactNeeded is not an intent — keep as direct forwarder
    const onCompactNeeded = (data: CompactNeededMessage['compactNeeded']): void => {
      if (this.isDisposed) return
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createCompactNeeded({
          conversationId: chatAgentService.getCurrentConversationId() || '',
          requestId: this.activeRequestId ?? undefined,
          role: this.currentStreamingRole,
          compactNeeded: data
        })
      )
    }
    chatAgentService.on('compactNeeded', onCompactNeeded)
    this.eventCleanups.push(() => chatAgentService.off('compactNeeded', onCompactNeeded))

    // Legacy forwarders for MCP-triggered events (fire during streaming)
    // These handle the immediate path when control tools fire via MCP callbacks.
    const onAskQuestion = (data: {
      questions: GrillQuestion[]
      action?: string
      requestId?: string
    }): void => {
      if (this.isDisposed) return
      this.safeWindowSend(IPC_CHANNELS.CHAT_ASK_QUESTION, {
        conversationId: chatAgentService.getCurrentConversationId() || '',
        questions: data.questions,
        action: data.action,
        requestId: data.requestId
      })
    }
    chatAgentService.on('askQuestion', onAskQuestion)
    this.eventCleanups.push(() => chatAgentService.off('askQuestion', onAskQuestion))

    // Elicitation — MCP server user input requests forwarded to renderer
    const onElicitation = (data: ElicitationEvent): void => {
      if (this.isDisposed) return
      this.safeWindowSend(IPC_CHANNELS.ELICITATION_REQUEST, {
        conversationId: chatAgentService.getCurrentConversationId() || '',
        ...data
      })
    }
    chatAgentService.on('elicitation', onElicitation)
    this.eventCleanups.push(() => chatAgentService.off('elicitation', onElicitation))

    // Budget cap reached — forward as a CHAT_MESSAGE_CHUNK with budgetCapReached field
    const onBudgetCapReached = (data: { conversationId: string; message: string }): void => {
      if (this.isDisposed) return
      this.safeWindowSend(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId: data.conversationId,
        requestId: this.activeRequestId ?? undefined,
        budgetCapReached: {
          message: 'Turn budget reached — your work is safe.',
          canContinue: true
        }
      })
    }
    chatAgentService.on('budgetCapReached', onBudgetCapReached)
    this.eventCleanups.push(() => chatAgentService.off('budgetCapReached', onBudgetCapReached))

    // NOTE: The persistent 'plan' listener was removed to prevent duplicate delivery.
    // Plan events are now handled exclusively by the per-message onPlanEvent listener
    // in stream(), which both forwards to the renderer AND injects into streamedContent
    // for DB persistence. The CHAT_PLAN IPC is still sent by the IntentRouter below
    // for regex-fallback detected plans.

    // Multi-workspace permission routing for background workspaces
    this.registerMultiWorkspaceForwarders()

    // Typed intent handler — routes post-stream intents (regex fallback + grill events)
    // via IntentRouter. Skips plan/askUser if they were already sent by MCP forwarders above.
    const onIntent = (intent: AgentIntent): void => {
      if (this.isDisposed) return
      const conversationId = chatAgentService.getCurrentConversationId() || ''

      // Skip types that were already forwarded by MCP legacy listeners
      // (plan, askUser are emitted both by MCP callbacks and post-stream detection,
      // but IntentDetector.detectAll() already filters out MCP-fired types, so these
      // intents only arrive here when they're regex-fallback detected)
      this.intentRouter.route(conversationId, intent)
    }
    chatAgentService.on('intent', onIntent)
    this.eventCleanups.push(() => chatAgentService.off('intent', onIntent))

    // F7: Wire hook lifecycle events to the stream pipeline.
    // The HookEngine emits 'hookLifecycle' events when hooks start/complete/fail.
    // Forward these as StreamChunks so the renderer can show hook execution status.
    // N14: Store handler reference for cleanup in dispose().
    this.hookLifecycleHandler = (event: {
      hookId: string
      hookName: string
      hookEvent: string
      phase: 'started' | 'response'
      output?: string
      outcome?: string
    }) => {
      // HOOK-LIFECYCLE-NOISOL-01: Wrap in try-catch to prevent listener errors
      // from propagating through EventEmitter.emit() and crashing the hook
      // execution pipeline.
      try {
        const conversationId = chatAgentService.getCurrentConversationId() || ''
        if (!conversationId) return
        const chunk: StreamChunk = {
          type: 'hook_lifecycle',
          content: '',
          hookInfo: {
            hookId: event.hookId,
            hookName: event.hookName,
            hookEvent: event.hookEvent,
            phase: event.phase as 'started' | 'progress' | 'response',
            output: event.output,
            outcome: event.outcome as 'success' | 'error' | 'cancelled' | undefined
          }
        }
        forwardChunkToRenderer(
          this.mainWindow,
          conversationId,
          this.currentStreamingRole,
          chunk,
          { value: '' }, // hook chunks don't accumulate content
          chatAgentService.getWorkspacePath() ?? undefined,
          undefined,
          'specialist-responding',
          this.activeRequestId ?? undefined,
          chatAgentService.getMode()
        )
      } catch (error) {
        log.warn('[STREAM:hook-lifecycle-handler] Error forwarding hook event:', error)
      }
    }
    hookEngine.on('hookLifecycle', this.hookLifecycleHandler)
  }

  /**
   * Register event forwarders for multi-workspace permission routing.
   * When a non-active workspace emits elicitation/askQuestion, routes through
   * SessionEventRouter so the NotificationStack can show a permission toast.
   * Extracted from registerEventForwarders() — structurally identical pair.
   */
  private registerMultiWorkspaceForwarders(): void {
    const onElicitationWs = (workspaceId: string, data: ElicitationEvent): void => {
      if (workspaceId !== chatAgentService.activeWorkspaceId) {
        try {
          const router = getSessionEventRouter()
          router.sendPermissionRequest({
            id: `elicit-${data.elicitationId ?? Date.now()}`,
            workspaceId,
            workspaceName: this.resolveWorkspaceName(workspaceId),
            type: 'elicitation',
            summary: data.message || 'Permission request from MCP server',
            isSimple: data.mode !== 'form',
            payload: data,
            receivedAt: Date.now()
          })
        } catch {
          // SessionEventRouter not yet initialized — fall through to legacy path
        }
      }
    }
    chatAgentService.on('elicitation:ws', onElicitationWs)
    this.eventCleanups.push(() => chatAgentService.off('elicitation:ws', onElicitationWs))

    const onAskQuestionWs = (
      workspaceId: string,
      data: { questions: GrillQuestion[]; action?: string; requestId?: string }
    ): void => {
      if (workspaceId !== chatAgentService.activeWorkspaceId) {
        try {
          const router = getSessionEventRouter()
          router.sendPermissionRequest({
            id: `ask-${data.requestId ?? Date.now()}`,
            workspaceId,
            workspaceName: this.resolveWorkspaceName(workspaceId),
            type: 'askQuestion',
            summary: data.questions?.[0]?.question || 'Question from agent',
            isSimple: false,
            payload: data,
            receivedAt: Date.now()
          })
        } catch {
          // SessionEventRouter not yet initialized — fall through to legacy path
        }
      }
    }
    chatAgentService.on('askQuestion:ws', onAskQuestionWs)
    this.eventCleanups.push(() => chatAgentService.off('askQuestion:ws', onAskQuestionWs))
  }

  // ── Extracted Lifecycle Methods ──

  /**
   * Acquire the streaming lock, transition the state machine, and begin
   * the conversation lifecycle. Throws if already streaming.
   */
  private acquireStreamLock(conversationId: string): {
    requestId: string
    signal: AbortSignal
    lifecycle: ConversationLifecycle
    resolveDone: () => void
    rejectDone: (err: Error) => void
    done: Promise<void>
  } {
    // Per-conversation lock: only reject if THIS conversation is already streaming
    if (this.streamingLocks.has(conversationId) || !conversationStateMachine.isIdle(conversationId)) {
      log.warn(`[STREAM:concurrent-rejected] Conversation ${conversationId} is already streaming`)
      throw new Error(
        'A message is already being processed in this chat. Please wait for it to complete or stop it first.'
      )
    }
    this.streamingLocks.add(conversationId)
    // CHAT-SM-TRANSITION-UNCHECKED-01: If state machine rejects the transition,
    // release the lock immediately to prevent a permanent streaming block.
    if (!conversationStateMachine.transition('sendMessage', conversationId)) {
      this.streamingLocks.delete(conversationId)
      throw new Error(
        `State machine rejected sendMessage — current state: ${conversationStateMachine.getState(conversationId)}`
      )
    }

    const lifecycle = lifecycleRegistry.begin(conversationId)
    const requestId = lifecycle.requestId!
    this.activeRequestIds.set(conversationId, requestId)
    this.stoppedConversations.delete(conversationId)

    // C3-FIX: Register lock-release disposer immediately at acquisition time.
    // This guarantees Stop (abort) during Stage 6.5's async optimization
    // releases the lock — even though registerStreamDisposers runs later (Stage 8).
    lifecycle.onDispose(() => {
      this.streamingLocks.delete(conversationId)
      this.activeRequestIds.delete(conversationId)
    })

    let resolveDone!: () => void
    let rejectDone!: (err: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    return { requestId, signal: lifecycle.signal!, lifecycle, resolveDone, rejectDone, done }
  }

  /**
   * Snapshot the adapter identity for this stream turn.
   * Returns role, phase, and specialist metadata.
   */
  private resolveStreamIdentity(): {
    streamingRole: 'specialist'
    phase: ConversationPhase
    specialistMeta: { specialist: string; taskId?: string } | undefined
    adapterAgentId: string
  } {
    const messageRole = chatAgentService.getActiveMessageRole()
    const adapterAgentId = chatAgentService.getActiveAgentId()

    // Persona overlay (specialist impersonating a named specialist) — when active, the
    // adapter uses the base specialist internally, but both streaming chunks AND the
    // persisted DB message use the specialist's identity (role + agentId) so
    // the avatar is consistent across streaming, finalization, and DB reload.
    const persona = chatAgentService.getActivePersona()
    const streamingRole: 'specialist' = persona ? 'specialist' : messageRole
    const phase: ConversationPhase =
      streamingRole === 'specialist' ? 'specialist-executing' : 'specialist-responding'
    const specialistMeta = persona
      ? { specialist: persona.agentId, taskId: '' }
      : messageRole === 'specialist'
        ? { specialist: adapterAgentId }
        : undefined

    return { streamingRole, phase, specialistMeta, adapterAgentId }
  }

  /**
   * Start keepalive and safety timers for a stream.
   * Registers dispose handlers on the lifecycle — no manual cleanup needed.
   */
  private setupStreamTimers(
    conversationId: string,
    requestId: string,
    rejectDone: (err: Error) => void
  ): void {
    // Keepalive — prevents renderer's 2-min safety timer from firing.
    // Checks isDestroyed() to self-clear after window close — without this
    // the timer fires every 30s throwing unhandled exceptions.
    this.keepaliveTimer = setInterval(() => {
      if (this.mainWindow.isDestroyed()) {
        clearInterval(this.keepaliveTimer!)
        this.keepaliveTimer = null
        return
      }
      // CHAT-KEEPALIVE-STALE-01: Validate the timer still references the current
      // lifecycle. If the lifecycle completed and a new stream started before this
      // interval fires, the captured conversationId/requestId are stale.
      if (conversationLifecycle.requestId !== requestId) {
        clearInterval(this.keepaliveTimer!)
        this.keepaliveTimer = null
        return
      }
      this.safeWindowSend(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        requestId,
        keepalive: true
      })
    }, 30_000)

    // Main-process safety timeout (5 min) — last-resort recovery
    // CHAT-TIMER-01: Added safetyCleared flag for idempotent safety. If an earlier
    // disposer throws and the clearTimeout disposer doesn't run, the flag prevents
    // the timer from firing on an already-completed stream.
    const MAIN_PROCESS_SAFETY_TIMEOUT_MS = 5 * 60 * 1000
    let safetyCleared = false
    const safetyTimer = setTimeout(() => {
      if (!safetyCleared && this.streamingLock) {
        log.error(
          '[STREAM:main-safety-timeout] Streaming lock stuck for 5 minutes — force-resetting. ' +
            `conversationId=${conversationId} requestId=${requestId}`
        )
        completeStreamMetrics(conversationId, 'timeout')
        conversationLifecycle.abort('safety-timeout')
        rejectDone(new Error('Streaming timed out — safety recovery triggered'))
      }
    }, MAIN_PROCESS_SAFETY_TIMEOUT_MS)

    conversationLifecycle.onDispose(() => {
      safetyCleared = true
      clearTimeout(safetyTimer)
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer)
        this.keepaliveTimer = null
      }
    })
  }

  /**
   * Run prompt optimization if guards pass.
   * Returns the (possibly optimized) dispatch text, or null if aborted during the async call.
   */
  private async runPromptOptimization(params: {
    text: string
    conversationId: string
    requestId: string
    signal: AbortSignal
    streamingRole: 'specialist'
    workspaceId: string
    mode: 'plan' | 'build'
    attachments?: string[]
  }): Promise<string | null> {
    const { text, conversationId, requestId, signal, streamingRole, workspaceId, mode, attachments } = params

    const guardReason = promptOptimizerService.checkGuards({ text, workspaceId })
    if (guardReason) return text // guarded — use original

    const optimizerToolId = `prompt-optimizer-${Date.now()}`
    const inputPreview = text.length > 500 ? text.slice(0, 500) + '…' : text
    const startedAt = Date.now()

    /** Emit + record a tool-activity card to the renderer. */
    const emitCard = (card: {
      status: 'running' | 'completed' | 'error'
      result?: string
      resultDetail?: string
    }): void => {
      const activity = {
        id: optimizerToolId,
        toolName: 'Prompt Optimizer',
        status: card.status,
        input: inputPreview,
        ...(card.result != null ? { result: card.result } : {}),
        ...(card.resultDetail != null ? { resultDetail: card.resultDetail } : {}),
        startedAt,
        ...(card.status !== 'running' ? { completedAt: Date.now() } : {}),
        operationType: 'other' as const
      }
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createToolActivityChunk({ conversationId, requestId, role: streamingRole, toolActivity: activity })
      )
      recordExternalToolActivity(conversationId, activity)
    }

    emitCard({ status: 'running' })

    // R6-B2: Notify chunk taps so E2E transcripts capture the optimizer run
    notifyChunkTaps(requestId, {
      type: 'tool_use',
      toolName: 'Prompt Optimizer',
      toolId: optimizerToolId,
      toolInput: inputPreview
    })

    const optimizeResult = await promptOptimizerService.optimize({
      text, workspaceId, conversationId, mode
    })

    if (signal.aborted) {
      log.info('[PIPELINE:prompt-optimizer] Aborted after optimization')
      return null
    }

    if (optimizeResult.changed) {
      const attachNote = attachments?.length
        ? `\n\n(${attachments.length} file attachment${attachments.length > 1 ? 's' : ''} appended after optimization)`
        : ''
      emitCard({
        status: 'completed',
        result: 'Prompt optimized for clarity',
        resultDetail: optimizeResult.optimizedText + attachNote
      })
      // R6-B2: Emit tool_result tap so transcripts show the rewritten prompt
      notifyChunkTaps(requestId, {
        type: 'tool_result',
        toolName: 'Prompt Optimizer',
        toolId: optimizerToolId,
        content: optimizeResult.optimizedText
      })
      log.info('[PIPELINE:prompt-optimizer] Prompt optimized')
      return optimizeResult.optimizedText
    }

    if (optimizeResult.skippedReason === 'error') {
      emitCard({ status: 'error', result: 'Optimization skipped — original prompt sent' })
      notifyChunkTaps(requestId, {
        type: 'tool_result',
        toolName: 'Prompt Optimizer',
        toolId: optimizerToolId,
        content: 'Error — original prompt sent'
      })
      log.warn('[PIPELINE:prompt-optimizer] Error — using original prompt')
    } else if (optimizeResult.skippedReason) {
      // parse-error | empty-output | oversize — surface the real failure
      const reason = optimizeResult.skippedReason
      emitCard({ status: 'error', result: `Optimization failed (${reason}) — original prompt sent` })
      notifyChunkTaps(requestId, {
        type: 'tool_result',
        toolName: 'Prompt Optimizer',
        toolId: optimizerToolId,
        content: `Optimization failed (${reason}) — original prompt sent`
      })
      log.warn(`[PIPELINE:prompt-optimizer] Failed (${reason}) — using original prompt`)
    } else {
      emitCard({ status: 'completed', result: 'No changes needed' })
      notifyChunkTaps(requestId, {
        type: 'tool_result',
        toolName: 'Prompt Optimizer',
        toolId: optimizerToolId,
        content: 'No changes needed'
      })
    }

    return text // unchanged — use original
  }

  /**
   * Register centralized cleanup disposers — runs on both complete() and abort().
   */
  private registerStreamDisposers(
    onChunk: (chunk: StreamChunk) => void,
    onComplete: () => void,
    onIntent: (intent: AgentIntent) => Promise<void>,
    onPlanEvent: (data: PlanDetectedEvent) => void
  ): void {
    // NOTE: Lock release (streamingLock + activeRequestId) is registered in
    // acquireStreamLock() so it's active before any async stages. Do not
    // duplicate it here. conversationLifecycle.onDispose is idempotent-safe
    // but re-registering would double-fire.

    // COMPACT-ABORT-01: Clear per-conversation adapter state (pending compaction,
    // pending context injection) on lifecycle abort. Without this, stale state
    // from an aborted stream is consumed by the next message.
    // Only clears adapter pending state — not the session map (conversation should
    // still be resumable after stop).
    const streamConvId = conversationLifecycle.conversationId
    if (streamConvId) {
      conversationLifecycle.onDispose(() => {
        chatAgentService.clearConversationPendingState(streamConvId)
      })

      // CHAT-TEXTBATCHER-ORPHAN-01: Flush/drain the text delta batcher on lifecycle
      // abort. Without this, buffered text fires 33ms later into an aborted
      // conversation — stale text appears in UI after the "stopped" indicator.
      conversationLifecycle.onDispose(() => {
        flushTextBatcher(streamConvId)
      })

      // F-19: Clear accumulated tool activities on lifecycle abort.
      // Without this, tool activities from an aborted stream sit in memory
      // until the next stream() call clears them. Defense-in-depth cleanup.
      // CHAT-TOOLACTIVITY-DOUBLECLEAR-01: Only clear if stop() hasn't
      // already cleared (isStopped means stop() handled it). The double-call
      // resets the clearedConversations 10s timer, blocking tool activity
      // accumulation for new streams started within that window.
      conversationLifecycle.onDispose(() => {
        if (!this.isStopped) {
          getAndClearToolActivities(streamConvId)
        }
      })

      // N1-FIX: The C3 disposer was removed because conversationLifecycle.complete()
      // fires at the end of every stream (not just on conversation end), which wiped
      // the dedupe set every turn. Cleanup now happens in dispose() and
      // clearConversationMemoryState().
    }

    // Remove per-stream listeners
    conversationLifecycle.onDispose(() => {
      chatAgentService.removeListener('chunk', onChunk)
      chatAgentService.removeListener('complete', onComplete)
      chatAgentService.removeListener('intent', onIntent)
      chatAgentService.removeListener('plan', onPlanEvent)
    })

    // Invoke caller-supplied stop pipeline hook on lifecycle dispose.
    // onStopPipeline is required to be idempotent — the duplicate call is harmless.
    conversationLifecycle.onDispose(() => {
      this.callbacks.onStopPipeline().catch((e) => {
        log.warn('[STREAM] Lifecycle dispose: onStopPipeline failed:', e)
      })
    })
  }

  /**
   * Send the empty identity chunk to renderer so the avatar matches from frame one.
   */
  private announceStreamStart(
    conversationId: string,
    requestId: string,
    streamingRole: 'specialist',
    phase: ConversationPhase,
    specialistMeta: { specialist: string; taskId?: string } | undefined
  ): void {
    this.safeWindowSend(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: '',
        role: streamingRole,
        phase,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  }

  /**
   * Process attachments and return text content + image data.
   */
  private prepareUserMessage(
    text: string,
    attachments?: string[]
  ): { fullContent: string; imageAttachments: ImageAttachment[] } {
    let fullContent = text
    let imageAttachments: ImageAttachment[] = []

    if (attachments && attachments.length > 0) {
      const result = this.processAttachments(attachments)
      fullContent += result.textContent
      imageAttachments = result.images
    }

    return { fullContent, imageAttachments }
  }

  /**
   * Wire listeners, do mode switch, call chatAgentService.send(), handle catch.
   */
  private async dispatchToAgent(
    conversationId: string,
    fullContent: string,
    imageAttachments: ImageAttachment[],
    listeners: {
      onChunk: (chunk: StreamChunk) => void
      onComplete: () => void
      onIntent: (intent: AgentIntent) => Promise<void>
      onPlanEvent: (data: PlanDetectedEvent) => void
    },
    ctx: StreamContext,
    requestId: string,
    rejectDone: (err: Error) => void
  ): Promise<void> {
    try {
      const conversation = conversationRepository.findById(conversationId)
      if (conversation && conversation.mode !== chatAgentService.getMode()) {
        log.info(`Deferred mode switch: ${chatAgentService.getMode()} → ${conversation.mode}`)
        await chatAgentService.switchMode(conversation.mode as ConversationMode)
      }

      chatAgentService.on('chunk', listeners.onChunk)
      chatAgentService.on('complete', listeners.onComplete)
      chatAgentService.on('intent', listeners.onIntent)
      chatAgentService.on('plan', listeners.onPlanEvent)

      // Per-turn memory injection: prepend relevant facts to the user message
      let enrichedContent = fullContent
      try {
        const workspace = ctx.workspacePath ? workspaceRepository.findByPath(ctx.workspacePath) : undefined
        if (workspace) {
          // Get or create the dedupe set for this conversation
          if (!this.injectedFactIds.has(conversationId)) {
            // N1-FIX: LRU cap — evict oldest entry when the map exceeds 50
            // conversations. Backstop against unbounded growth when dispose()
            // doesn't run (e.g. long-lived singleton).
            if (this.injectedFactIds.size >= 50) {
              const oldest = this.injectedFactIds.keys().next().value
              if (oldest) this.injectedFactIds.delete(oldest)
            }
            this.injectedFactIds.set(conversationId, new Set())
          } else {
            // L1-FIX: True LRU — refresh Map insertion order so the most
            // recently accessed conversation is evicted last.
            const existing = this.injectedFactIds.get(conversationId)!
            this.injectedFactIds.delete(conversationId)
            this.injectedFactIds.set(conversationId, existing)
          }
          const dedupeSet = this.injectedFactIds.get(conversationId)!
          const memoryContext = await memoryRetrievalService.getContextForTurn(
            workspace.id,
            fullContent,
            'medium',
            dedupeSet
          )
          if (memoryContext) {
            enrichedContent = `[Relevant Workspace Knowledge]\n${memoryContext}\n\n---\n\n${fullContent}`
          }
        }
      } catch (memErr) {
        log.debug('Per-turn memory retrieval failed (non-fatal):', memErr)
      }

      await chatAgentService.send(
        enrichedContent,
        conversationId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      )
    } catch (error) {
      // Lifecycle abort handles: streamingLock, listener removal, state machine force-reset
      conversationLifecycle.abort('streamError')
      completeStreamMetrics(conversationId, 'error')

      eventLoggerService.logSessionFailed({
        conversationId,
        agentId: ctx.adapterAgentId,
        error: (error as Error).message
      })

      const roleLabel = 'Specialist'
      log.error(`${roleLabel} send failed:`, (error as Error).message)
      const errorMsg = `**${roleLabel} Error:** ${(error as Error).message}\n\nMake sure Claude CLI is installed and a workspace is open.`
      const savedMessage = messageRepository.create(
        conversationId,
        ctx.streamingRole,
        errorMsg,
        ctx.specialistMeta?.specialist ?? ctx.adapterAgentId
      )

      // Persist any tool activities accumulated before the error
      const errorToolActivities = getAndClearToolActivities(conversationId)
      if (errorToolActivities.length > 0) {
        try {
          messageRepository.updateToolActivities(savedMessage.id, errorToolActivities)
        } catch (toolErr) {
          log.error(
            `[PIPELINE:tool-activities-lost] messageId=${savedMessage.id} count=${errorToolActivities.length}:`,
            toolErr
          )
        }
      }

      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId,
          requestId,
          text: errorMsg,
          role: ctx.streamingRole
        })
      )
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
        createCompleteMessage({
          conversationId,
          messageId: savedMessage.id,
          requestId
        })
      )
      // Note: lifecycle.abort('streamError') already force-reset the state machine to idle
      rejectDone(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Persist the streamed message to DB, process memory blocks, and notify renderer.
   * Extracted from the onComplete closure — all error paths transition the state machine.
   */
  private async finalizeStreamMessage(ctx: StreamContext): Promise<void> {
    // CHAT-STOP-COMPLETE-RACE-01: Re-check after the async gap between onComplete's
    // guard and this method's DB write. If stop() ran between the guard passing and
    // this point, it already saved a "stopped" message — skip to avoid duplicates.
    if (this.isStopped) {
      log.info('[PIPELINE:finalize-skipped] Stream was stopped during finalization')
      return
    }

    // CHAT-FINALIZE-ORPHAN-01: Verify this finalization still belongs to the
    // current lifecycle. If a new stream started (superseding this one), the
    // lifecycle's requestId will have changed. Skip to avoid corrupting the
    // new stream's state machine.
    if (conversationLifecycle.requestId !== ctx.requestId) {
      log.info(
        `[PIPELINE:finalize-orphaned] requestId mismatch ` +
        `(lifecycle=${conversationLifecycle.requestId} ctx=${ctx.requestId}) — skipping`
      )
      return
    }

    try {
      log.info('Agent complete — saving to DB:', { contentLen: ctx.streamedContent.length })
      const cleanedContent = ctx.streamedContent.trim()

      if (!cleanedContent) {
        const accumulatedText = chatAgentService.getStreamedContent()
        log.error(
          `[PIPELINE:silent-failure] Agent completed with no streamed content. ` +
            `streamedLen=${ctx.streamedContent.length} ` +
            `accumulatedLen=${accumulatedText?.length ?? 0} ` +
            `executorBackend=${chatAgentService.getExecutorBackend()} ` +
            `role=${ctx.streamingRole} specialist=${ctx.specialistMeta?.specialist ?? 'none'} ` +
            `accumulatedPreview=${(accumulatedText ?? '').slice(0, 200).replace(/\n/g, ' ')}`
        )

        // Surface the failure to the user instead of saving an empty message
        this.safeWindowSend(
          IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
          createTextChunk({
            conversationId: ctx.conversationId,
            requestId: ctx.requestId,
            text: '\n\n**Error:** Agent produced no response. Check the app logs for details.',
            role: ctx.streamingRole
          })
        )
      }

      // FINALIZE-ATOM-01: Wrap message creation + tool activity persistence in a
      // transaction. If the conversation is cascade-deleted between the two calls,
      // both operations roll back together instead of leaving orphaned data.
      const toolActivities = getAndClearToolActivities(ctx.conversationId)
      const contentToSave =
        cleanedContent || '**Error:** Agent produced no response. Check the app logs for details.'
      const agentId = ctx.specialistMeta?.specialist ?? ctx.adapterAgentId

      let savedMessage: { id: string }
      try {
        const { getDatabase } = await import('../db/index')

        // CHAT-STOP-FINALIZE-DOUBLESAVE-01: Re-check after async gap.
        // stop() may have run during the await, saving its own "stopped" message.
        // Without this guard, both stop()'s message AND this finalization's message
        // are saved — creating a duplicate in the conversation.
        if (this.isStopped) {
          log.info('[PIPELINE:finalize-skipped-post-await] Stopped during DB import await')
          return
        }

        const db = getDatabase()
        savedMessage = db.transaction(() => {
          const msg = messageRepository.create(
            ctx.conversationId,
            ctx.streamingRole,
            contentToSave,
            agentId
          )
          if (toolActivities.length > 0) {
            messageRepository.updateToolActivities(msg.id, toolActivities)
            log.info(
              `[PIPELINE:tool-activities-persisted] messageId=${msg.id} count=${toolActivities.length}`
            )
          }
          return msg
        })()
      } catch (txErr) {
        // CHAT-FINALIZE-FALLBACK-01: Distinguish test environment (no DB) from
        // real DB errors. Only fall back to non-transactional insert for expected
        // test/no-DB scenarios. Real errors (disk full, FK violation) should surface.
        // Deterministic check: process.versions.electron is set in packaged Electron
        // but absent under tsx/node test runners — no string-matching needed.
        const isTestEnv = !process.versions.electron
        if (!isTestEnv) {
          log.error('[PIPELINE:finalize-tx-failed] Transaction failed with real DB error:', txErr)
          throw txErr
        }
        // Fallback: non-transactional (test environment without DB)
        savedMessage = messageRepository.create(
          ctx.conversationId,
          ctx.streamingRole,
          contentToSave,
          agentId
        )
        if (toolActivities.length > 0) {
          try {
            messageRepository.updateToolActivities(savedMessage.id, toolActivities)
            log.info(
              `[PIPELINE:tool-activities-persisted] messageId=${savedMessage.id} count=${toolActivities.length}`
            )
          } catch (toolErr) {
            log.error(
              `[PIPELINE:tool-activities-lost] messageId=${savedMessage.id} count=${toolActivities.length}:`,
              toolErr
            )
          }
        }
      }
      log.info('Agent message saved, id:', savedMessage.id)

      // Enqueue memory extraction from transcript + git delta
      this.enqueueMemoryExtraction(ctx)

      log.info(
        `[PIPELINE:agent-message-saved] messageId=${savedMessage.id} contentLen=${cleanedContent.length}`
      )
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
        createCompleteMessage({
          conversationId: ctx.conversationId,
          messageId: savedMessage.id,
          requestId: ctx.requestId
        })
      )
    } catch (error) {
      log.error('Failed to save agent message:', error)
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId: ctx.conversationId,
          requestId: ctx.requestId,
          text: `\n\n**Error saving response:** ${(error as Error).message}`,
          role: ctx.streamingRole
        })
      )
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
        createCompleteMessage({
          conversationId: ctx.conversationId,
          messageId: `error-${Date.now()}`,
          requestId: ctx.requestId
        })
      )
    }

    // ALWAYS transition state machine — regardless of success or failure.
    // This is the single point where streaming → idle happens on the happy path.
    // CHAT-FINALIZE-ORPHAN-01: Re-check before transitioning — the async gap in
    // the try block above may have allowed a new stream to start.
    if (conversationLifecycle.requestId === ctx.requestId) {
      conversationStateMachine.transition('chatAgentComplete')
    } else {
      log.info(
        `[PIPELINE:finalize-orphaned-transition] requestId mismatch after DB write ` +
        `(lifecycle=${conversationLifecycle.requestId} ctx=${ctx.requestId}) — skipping transition`
      )
    }

    // Log stream completion metrics (TTFT, duration, chunk count, chars)
    completeStreamMetrics(ctx.conversationId, 'complete')
  }

  /**
   * Enqueue fact extraction from the completed stream transcript + git delta.
   * Replaces the old processMemoryBlocks regex-based extraction.
   */
  private enqueueMemoryExtraction(ctx: StreamContext): void {
    try {
      const wpPath = ctx.workspacePath
      const workspace = wpPath ? workspaceRepository.findByPath(wpPath) : undefined
      if (workspace && ctx.streamedContent.length > 200) {
        // Gate on sessionCapture setting
        const settings = workspaceRepository.getSettings(workspace.id) as Record<string, unknown>
        if (settings.memorySessionCapture === false) return
        memoryExtractionService.enqueueSessionExtraction({
          workspaceId: workspace.id,
          workspacePath: wpPath ?? null,
          transcript: ctx.streamedContent,
          startSha: ctx.startSha ?? null,
          conversationId: ctx.conversationId
        })
      }
    } catch (err) {
      log.warn('Memory extraction enqueue failed:', err)
    }
  }

  // ── Stream Listener Factory ──

  /**
   * Builds the per-stream event listeners as a cohesive object.
   * Extracted from stream() to reduce its cyclomatic complexity.
   */
  private buildStreamListeners(
    ctx: StreamContext,
    resolveDone: () => void,
    rejectDone: (err: Error) => void
  ): {
    onChunk: (chunk: StreamChunk) => void
    onComplete: () => void
    onIntent: (intent: AgentIntent) => Promise<void>
    onPlanEvent: (data: PlanDetectedEvent) => void
  } {
    // Adapter for forwardChunkToRenderer which still expects { value: string }
    const streamedContentRef = {
      get value() {
        return ctx.streamedContent
      },
      set value(v: string) {
        ctx.streamedContent = v
      }
    }

    const onChunk = (chunk: StreamChunk): void => {
      // CHAT-ONCHUNK-NO-LIFECYCLE-GUARD: Skip chunks after lifecycle abort
      // or supersession. Matches the guard in onComplete (line ~930).
      if (!conversationLifecycle.isActive || conversationLifecycle.requestId !== ctx.requestId) {
        return
      }
      try {
        log.info(
          `[STREAM:chunk] type=${chunk.type} len=${chunk.content?.length ?? 0} convId=${ctx.conversationId.slice(0, 8)}`
        )
        forwardChunkToRenderer(
          this.mainWindow,
          ctx.conversationId,
          ctx.streamingRole,
          chunk,
          streamedContentRef,
          ctx.workspacePath,
          ctx.specialistMeta,
          ctx.phase,
          ctx.requestId,
          chatAgentService.getMode()
        )
      } catch (error) {
        log.error('Failed to forward chunk to renderer:', error)
      }
    }

    const cleanupListeners = (): void => {
      if (conversationLifecycle.isActive) {
        conversationLifecycle.complete()
      }
    }

    const onComplete = (): void => {
      // Flush any pending batched text deltas before finalizing
      flushTextBatcher(ctx.conversationId)

      // CHAT-FINALIZE-DELETE-01: After lifecycle.abort(), the abortController is set
      // to null, making signal null and signal?.aborted undefined (falsy). Using
      // !conversationLifecycle.isActive correctly catches both abort-then-complete
      // and delete-then-complete scenarios. isActive is false when abortController
      // is null — which happens after both abort() and complete().
      if (this.isStopped || !conversationLifecycle.isActive) {
        // CHAT-METRICS-ABORT-ORPHAN-01: Clean up metrics on abort-triggered completion.
        // Idempotent if stop() already called completeStreamMetrics.
        completeStreamMetrics(ctx.conversationId, 'aborted')
        cleanupListeners()
        resolveDone()
        return
      }

      this.finalizeStreamMessage(ctx)
        .then(() => {
          cleanupListeners()
          resolveDone()
        })
        .catch((err) => {
          log.error('[PIPELINE:complete] Finalize failed:', err)
          // STREAM-METRICS-STORE-LEAK-01: If finalizeStreamMessage crashed before
          // calling completeStreamMetrics, clean up the orphaned metrics entry.
          // Idempotent — harmless if already called inside finalizeStreamMessage.
          completeStreamMetrics(ctx.conversationId, 'error')
          // Safety net: if finalizeStreamMessage's inner catch block threw before
          // reaching the transition (e.g. mainWindow destroyed), ensure the state
          // machine still moves to idle. Idempotent when already idle.
          // CHAT-FINALIZE-ORPHAN-01: Only transition if lifecycle is still ours —
          // a new stream may have started during the failed finalization.
          if (conversationLifecycle.requestId === ctx.requestId) {
            conversationStateMachine.transition('chatAgentComplete')
          }
          cleanupListeners()
          rejectDone(err instanceof Error ? err : new Error(String(err)))
        })
    }

    const onIntent = async (_intent: AgentIntent): Promise<void> => {
      // No-op — handled by IntentRouter's persistent listener
    }

    const onPlanEvent = (data: PlanDetectedEvent): void => {
      if (ctx.planInjected) {
        log.warn('[PIPELINE:plan-skipped] Plan already injected this stream — skipping duplicate')
        return
      }
      ctx.planInjected = true

      const planBlock = `\n\n\`\`\`plan\n${data.rawContent}\n\`\`\`\n\n`
      ctx.streamedContent += planBlock
      this.safeWindowSend(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId: ctx.conversationId,
          requestId: ctx.requestId,
          text: planBlock,
          role: ctx.streamingRole
        })
      )
      // Dual-write: register plan in Plan Hub registry (non-critical)
      try {
        const workspaceId = chatAgentService.activeWorkspaceId
        if (workspaceId && data.structuredPlan) {
          planRegistryService.registerChatPlan({
            workspaceId,
            conversationId: ctx.conversationId,
            messageId: ctx.requestId,
            plan: data.structuredPlan,
            rawContent: data.rawContent
          })
        }
      } catch (err) {
        log.warn('[PIPELINE:plan-registry-failed] Non-critical:', err)
      }

      log.info(
        '[PIPELINE:plan-injected] Plan block injected into streamed content and forwarded to renderer'
      )
    }

    return { onChunk, onComplete, onIntent, onPlanEvent }
  }

  // ── Stream Lifecycle ──

  /**
   * Full streaming lifecycle — orchestrates the decomposed stages.
   */
  async stream(
    conversationId: string,
    text: string,
    attachments?: string[],
    opts?: { optimizePrompt?: boolean }
  ): Promise<StreamHandle> {
    // Stage 1: Acquire lock + lifecycle
    const { requestId, signal, resolveDone, rejectDone, done } =
      this.acquireStreamLock(conversationId)

    // Stage 2: Ensure workspace session is live
    const conv = conversationRepository.findById(conversationId)
    try {
      const ws = conv ? workspaceRepository.findById(conv.workspaceId) : undefined
      if (ws?.repoPath) await chatAgentService.ensureStarted(ws.id, ws.repoPath)
    } catch (error) {
      conversationLifecycle.abort('streamError')
      throw error
    }

    // Stage 3: Resolve identity
    const { streamingRole, phase, specialistMeta, adapterAgentId } = this.resolveStreamIdentity()
    this.currentStreamingRole = streamingRole

    // Stage 4: Announce streaming identity to renderer
    this.announceStreamStart(conversationId, requestId, streamingRole, phase, specialistMeta)

    // Stage 5: Setup timers (keepalive + safety)
    this.setupStreamTimers(conversationId, requestId, rejectDone)

    // Clear any stale tool activities from a previous crashed stream
    getAndClearToolActivities(conversationId)

    // Start stream metrics tracking (TTFT, chunk count, total chars, duration)
    startStreamMetrics(conversationId)

    // Stage 6: Save original user message + run prompt optimization
    const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]'
    messageRepository.create(conversationId, 'user', text, undefined, attachmentsJson)
    log.info('User message saved to DB')

    // Stage 6.5: Prompt Optimization (chat plan/build only — skipped for programmatic callers)
    let dispatchText = text
    const convMode = (conv?.mode ?? chatAgentService.getMode()) as 'plan' | 'build'
    if (opts?.optimizePrompt !== false && conv && (convMode === 'plan' || convMode === 'build')) {
      const result = await this.runPromptOptimization({
        text, conversationId, requestId, signal, streamingRole,
        workspaceId: conv.workspaceId, mode: convMode, attachments
      })
      if (result === null) {
        // H1-FIX: settle the done promise before returning
        resolveDone()
        return { done, abort: () => conversationLifecycle.abort('external'), requestId }
      }
      dispatchText = result
    }

    // Stage 6.9: Prepare dispatch content (uses optimized text if changed)
    const { fullContent, imageAttachments } = this.prepareUserMessage(dispatchText, attachments)

    // Stage 7: Build context + listeners
    // Capture HEAD sha for memory extraction (async to avoid blocking main thread)
    let startSha: string | undefined
    const wpPath = chatAgentService.getWorkspacePath()
    if (wpPath) {
      try {
        const { exec } = require('node:child_process')
        startSha = await new Promise<string | undefined>((resolve) => {
          exec('git rev-parse HEAD 2>/dev/null || true', {
            cwd: wpPath, encoding: 'utf-8', timeout: 2000
          }, (err: Error | null, stdout: string) => {
            resolve(err ? undefined : (stdout?.trim() || undefined))
          })
        })
      } catch { /* no git — fine */ }
    }

    const ctx: StreamContext = {
      conversationId,
      requestId,
      streamingRole,
      phase,
      specialistMeta,
      adapterAgentId,
      workspacePath: wpPath ?? undefined,
      startSha,
      streamedContent: '',
      planInjected: false
    }

    const { onChunk, onComplete, onIntent, onPlanEvent } = this.buildStreamListeners(
      ctx,
      resolveDone,
      rejectDone
    )

    // Stage 8: Register disposers (needs listener refs)
    this.registerStreamDisposers(onChunk, onComplete, onIntent, onPlanEvent)

    // Stage 9: Dispatch to agent
    await this.dispatchToAgent(
      conversationId,
      fullContent,
      imageAttachments,
      { onChunk, onComplete, onIntent, onPlanEvent },
      ctx,
      requestId,
      rejectDone
    )

    // Return StreamHandle — callers can optionally await `done` for full pipeline completion
    return { done, abort: () => conversationLifecycle.abort('external'), requestId }
  }

  /**
   * Process file attachments into text content and image data.
   * Detects images vs text files, reads content, estimates tokens.
   * Extracted from stream() — pure data-transformation concern.
   */
  private processAttachments(attachments: string[]): {
    textContent: string
    images: ImageAttachment[]
  } {
    const images: ImageAttachment[] = []
    const parts: string[] = []

    for (const filePath of attachments) {
      try {
        if (fileService.isImageFile(filePath)) {
          const { base64, mimeType } = fileService.readImageAsBase64(filePath)
          const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
          images.push({ base64, mimeType, fileName })
          parts.push(
            `\n---\n**Attached image: ${fileName}** (${mimeType}) — visible in the conversation\n`
          )
        } else {
          const content = fileService.readFileContent(filePath)
          const tokens = fileService.estimateTokens(content)
          parts.push(
            `\n---\n**Attached file: ${filePath}** (${tokens} tokens)\n\`\`\`\n${content}\n\`\`\`\n`
          )
        }
      } catch (error) {
        parts.push(`\n---\n**Failed to read: ${filePath}**: ${(error as Error).message}\n`)
      }
    }

    return { textContent: parts.join(''), images }
  }

  // ── Stop ──

  async stop(): Promise<void> {
    this.isStopped = true

    // Stop keepalive timer immediately on user stop
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }

    const conversationId = chatAgentService.getCurrentConversationId()
    const requestId =
      this.activeRequestId ?? conversationLifecycle.requestId ?? `req-stop-${Date.now()}`

    // Stop specialist pool via callback
    await this.callbacks.onStopPipeline()

    try {
      // Save partial content
      if (conversationId) {
        try {
          const partialContent = chatAgentService.getStreamedContent()
          const contentToSave = partialContent
            ? partialContent + '\n\n---\n\n⏹ *Generation stopped by user.*'
            : '⏹ *Generation stopped by user.*'

          // Snapshot the active adapter for the stop path — runs from a different
          // IPC entry point and has no per-turn snapshot in scope.
          // Check persona directly since stream-level streamingRole/specialistMeta
          // aren't available in this separate IPC entry point.
          const stopPersona = chatAgentService.getActivePersona()
          const stopRole = stopPersona ? 'specialist' : chatAgentService.getActiveMessageRole()
          const stopAgentId = stopPersona?.agentId ?? chatAgentService.getActiveAgentId()
          const savedMessage = messageRepository.create(
            conversationId,
            stopRole,
            contentToSave,
            stopAgentId
          )
          log.info('Stopped message saved to DB, id:', savedMessage.id)

          // Persist tool activities accumulated before user stopped
          const stopToolActivities = getAndClearToolActivities(conversationId)
          if (stopToolActivities.length > 0) {
            try {
              messageRepository.updateToolActivities(savedMessage.id, stopToolActivities)
              log.info(
                `[PIPELINE:tool-activities-persisted-on-stop] count=${stopToolActivities.length}`
              )
            } catch (toolErr) {
              log.error(
                `[PIPELINE:tool-activities-lost] messageId=${savedMessage.id} count=${stopToolActivities.length}:`,
                toolErr
              )
            }
          }

          this.safeWindowSend(
            IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
            createCompleteMessage({
              conversationId,
              messageId: savedMessage.id,
              requestId
            })
          )
        } catch (error) {
          log.error('Failed to save stopped message:', error)
        }
      }
    } finally {
      // ALWAYS cancel and abort — even if save/send fails.
      // Prevents orphaned CLI processes and stuck streaming locks.
      if (conversationId) {
        completeStreamMetrics(conversationId, 'stopped')
      }
      chatAgentService.cancelCurrentQuery()
      conversationLifecycle.abort('userStop')
    }
  }

  // ── Compact ──

  async compact(extractNuance = false): Promise<void> {
    log.info(`Compact requested (nuance=${extractNuance})`)
    await chatAgentService.compact(extractNuance)
  }

  /**
   * Force-reset streaming state if switching away from a workspace with a stuck stream.
   * Called by the workspace switch IPC handler to prevent cross-workspace lock contamination.
   */
  forceResetIfStuck(): void {
    const lockStuck = this.streamingLock
    const smStuck = !conversationStateMachine.isIdle()
    if (lockStuck || smStuck) {
      log.warn(
        `[STREAM:force-reset] lock=${lockStuck} smState=${conversationStateMachine.currentState} — force-resetting`
      )
      // CHAT-METRICS-ABORT-ORPHAN-01: Clean up metrics before abort to prevent leak.
      const wsConvId = conversationLifecycle.conversationId
      if (wsConvId) completeStreamMetrics(wsConvId, 'aborted')
      conversationLifecycle.abort('workspace-switch')
    }
  }

  /**
   * N1-FIX: Clear injected-fact dedupe state for a conversation.
   * Called from conversation-delete IPC paths so facts can be re-injected
   * if the user starts a new conversation about the same topics.
   */
  clearConversationMemoryState(conversationId: string): void {
    this.injectedFactIds.delete(conversationId)
  }

  // N14: Clean up all persistent listeners when the service is replaced
  dispose(): void {
    this.isDisposed = true

    // N1-FIX: Clear all per-conversation memory dedupe state on service replacement
    this.injectedFactIds.clear()

    // Clean up all persistent event forwarders registered in registerEventForwarders()
    for (const cleanup of this.eventCleanups) {
      cleanup()
    }
    this.eventCleanups = []

    // hookLifecycle cleanup (stored separately as named handler)
    if (this.hookLifecycleHandler) {
      hookEngine.off('hookLifecycle', this.hookLifecycleHandler)
      this.hookLifecycleHandler = undefined
    }
  }
}

// ── Singleton with lazy initialization ──

let _instance: ChatStreamService | null = null

export function initChatStream(
  mainWindow: BrowserWindow,
  callbacks: PipelineCallbacks
): ChatStreamService {
  // N14: Dispose previous instance to remove stale listeners
  _instance?.dispose()
  _instance = new ChatStreamService(mainWindow, callbacks)
  return _instance
}

export const chatStreamService = new Proxy({} as ChatStreamService, {
  get(_target, prop) {
    if (!_instance)
      throw new Error(
        'ChatStreamService not initialized — call initChatStream(mainWindow, callbacks) first'
      )
    return (_instance as unknown as Record<string, unknown>)[prop as string]
  }
})

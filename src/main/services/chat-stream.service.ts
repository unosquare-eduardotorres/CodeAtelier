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
import { memoryService } from './memory.service'
import { eventLoggerService } from './event-logger.service'
import { forwardChunkToRenderer } from '../ipc/chat-shared'
import {
  flushTextBatcher,
  getAndClearToolActivities,
  startStreamMetrics,
  completeStreamMetrics
} from '../ipc/chunk-router'
import {
  createTextChunk,
  createCompleteMessage,
  createCompactNeeded,
  type CompactNeededMessage
} from '../ipc/chat-protocol'
import { chatIpcLogger } from '../logger'
import { getSessionEventRouter } from './session-event-router'
import { IntentRouter } from './intent-router'
import { conversationStateMachine } from './conversation-state-machine'
import { conversationLifecycle } from './conversation-lifecycle'
import { hookEngine } from './hook-engine.service'
import { planRegistryService } from './plan-registry.service'

const log = chatIpcLogger

// ── StreamContext — explicit per-stream state bag ──

/** Immutable per-stream context — replaces the ad-hoc closure state bag. */
interface StreamContext {
  readonly conversationId: string
  readonly requestId: string
  readonly streamingRole: 'da-vinci' | 'specialist'
  readonly phase: ConversationPhase
  readonly specialistMeta: { specialist: string; taskId?: string } | undefined
  readonly adapterAgentId: string
  readonly workspacePath: string | undefined
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
 * (generalist + specialists) completes, or call `abort()` to cancel.
 */
export interface StreamHandle {
  /** Resolves when the entire pipeline (generalist + specialists) completes */
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

  /** Instance-level flag to prevent duplicate message saves when stop is called mid-stream */
  private isStopped = false

  /** Prevents concurrent stream() calls — rejects if already streaming */
  private streamingLock = false
  private activeRequestId: string | null = null

  /** Per-stream identity — set at stream() start, cleared on cleanup. */
  private currentStreamingRole: 'da-vinci' | 'specialist' = 'da-vinci'

  /**
   * Keepalive timer — sends periodic IPC events to the renderer during streaming.
   * MCP tools (e.g. Maestro run_flow_files) can block the SDK message loop for
   * minutes. Without this, the renderer's 2-minute safety timer fires and
   * disconnects the UI while the backend is still working.
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null

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
   * Register once-at-startup event forwarders from generalist → renderer.
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
        'da-vinci-responding',
        this.activeRequestId ?? undefined,
        chatAgentService.getMode()
      )
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
    resolveDone: () => void
    rejectDone: (err: Error) => void
    done: Promise<void>
  } {
    if (this.streamingLock || !conversationStateMachine.isIdle()) {
      log.warn('[STREAM:concurrent-rejected] Already streaming or state machine not idle')
      throw new Error(
        'A message is already being processed. Please wait for it to complete or stop it first.'
      )
    }
    this.streamingLock = true
    conversationStateMachine.transition('sendMessage', conversationId)

    const signal = conversationLifecycle.begin(conversationId)
    const requestId = conversationLifecycle.requestId!
    this.activeRequestId = requestId
    this.isStopped = false

    let resolveDone!: () => void
    let rejectDone!: (err: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    return { requestId, signal, resolveDone, rejectDone, done }
  }

  /**
   * Snapshot the adapter identity for this stream turn.
   * Returns role, phase, and specialist metadata.
   */
  private resolveStreamIdentity(): {
    streamingRole: 'da-vinci' | 'specialist'
    phase: ConversationPhase
    specialistMeta: { specialist: string; taskId?: string } | undefined
    adapterAgentId: string
  } {
    const messageRole = chatAgentService.getActiveMessageRole()
    const adapterAgentId = chatAgentService.getActiveAgentId()

    // Persona overlay (Da Vinci impersonating a Specialist) — when active, the
    // adapter is still Da Vinci internally, but both streaming chunks AND the
    // persisted DB message use the specialist's identity (role + agentId) so
    // the avatar is consistent across streaming, finalization, and DB reload.
    const persona = chatAgentService.getActivePersona()
    const streamingRole: 'da-vinci' | 'specialist' = persona ? 'specialist' : messageRole
    const phase: ConversationPhase =
      streamingRole === 'specialist' ? 'specialist-executing' : 'da-vinci-responding'
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
   * Register centralized cleanup disposers — runs on both complete() and abort().
   */
  private registerStreamDisposers(
    onChunk: (chunk: StreamChunk) => void,
    onComplete: () => void,
    onIntent: (intent: AgentIntent) => Promise<void>,
    onPlanEvent: (data: PlanDetectedEvent) => void
  ): void {
    // Release lock + clear request ID
    conversationLifecycle.onDispose(() => {
      this.streamingLock = false
      this.activeRequestId = null
      // Don't reset currentStreamingRole to a hardcoded 'da-vinci' —
      // it should retain the per-stream value until the next stream starts.
      // Resetting to 'da-vinci' corrupts any event forwarders that fire
      // between dispose and the next stream() call (e.g. compactNeeded).
    })

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
    streamingRole: 'da-vinci' | 'specialist',
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
      await chatAgentService.send(
        fullContent,
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

      const roleLabel = ctx.streamingRole === 'specialist' ? 'Specialist' : 'Generalist'
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
      const { getDatabase } = await import('../db/index')
      const db = getDatabase()
      const savedMessage = db.transaction(() => {
        const msg = messageRepository.create(
          ctx.conversationId,
          ctx.streamingRole,
          cleanedContent ||
            '**Error:** Agent produced no response. Check the app logs for details.',
          ctx.specialistMeta?.specialist ?? ctx.adapterAgentId
        )
        if (toolActivities.length > 0) {
          messageRepository.updateToolActivities(msg.id, toolActivities)
          log.info(
            `[PIPELINE:tool-activities-persisted] messageId=${msg.id} count=${toolActivities.length}`
          )
        }
        return msg
      })()
      log.info('Agent message saved, id:', savedMessage.id)

      // Process memory blocks
      this.processMemoryBlocks(ctx)

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
      log.error('Failed to save generalist message:', error)
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
    conversationStateMachine.transition('chatAgentComplete')

    // Log stream completion metrics (TTFT, duration, chunk count, chars)
    completeStreamMetrics(ctx.conversationId, 'complete')
  }

  /**
   * Extract and persist memory blocks from agent response content.
   */
  private processMemoryBlocks(ctx: StreamContext): void {
    try {
      const wpPath = chatAgentService.getWorkspacePath()
      const allWorkspaces = wpPath ? workspaceRepository.findAll() : []
      const workspace = allWorkspaces.find((w) => w.repoPath === wpPath)
      if (workspace) {
        const memoriesCreated = memoryService.processMemoryBlocks(
          ctx.streamedContent,
          ctx.conversationId,
          ctx.adapterAgentId,
          workspace.id
        )
        if (memoriesCreated > 0) {
          log.info(`Created ${memoriesCreated} memories from agent response`)
        }
      }
    } catch (memErr) {
      log.warn('Memory block processing failed:', memErr)
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

      // CHAT-DUP-01 + CHAT-RACE-01: Use the lifecycle abort signal (set atomically
      // by lifecycle.abort()) instead of the isStopped boolean flag. This prevents
      // the TOCTOU race where isStopped is checked here but stop() sets it between
      // this check and the first await inside finalizeStreamMessage(). The signal
      // is set once and stays aborted — no race window.
      const signal = conversationLifecycle.signal
      if (this.isStopped || signal?.aborted) {
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
          // Safety net: if finalizeStreamMessage's inner catch block threw before
          // reaching the transition (e.g. mainWindow destroyed), ensure the state
          // machine still moves to idle. Idempotent when already idle.
          conversationStateMachine.transition('chatAgentComplete')
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
   * Full generalist streaming lifecycle — orchestrates the decomposed stages.
   */
  async stream(
    conversationId: string,
    text: string,
    attachments?: string[]
  ): Promise<StreamHandle> {
    // Stage 1: Acquire lock + lifecycle
    const { requestId, signal, resolveDone, rejectDone, done } =
      this.acquireStreamLock(conversationId)

    // Stage 2: Ensure workspace session is live
    try {
      const conv = conversationRepository.findById(conversationId)
      const ws = conv ? workspaceRepository.findById(conv.workspaceId) : undefined
      if (ws?.repoPath) await chatAgentService.ensureStarted(ws.id, ws.repoPath)
    } catch (error) {
      conversationLifecycle.abort('streamError')
      throw error
    }

    // Stage 3: Resolve identity
    const { streamingRole, phase, specialistMeta, adapterAgentId } = this.resolveStreamIdentity()
    this.currentStreamingRole = streamingRole

    void signal // AbortSignal available for future cooperative cancellation

    // Stage 4: Announce streaming identity to renderer
    this.announceStreamStart(conversationId, requestId, streamingRole, phase, specialistMeta)

    // Stage 5: Setup timers (keepalive + safety)
    this.setupStreamTimers(conversationId, requestId, rejectDone)

    // Clear any stale tool activities from a previous crashed stream
    getAndClearToolActivities(conversationId)

    // Start stream metrics tracking (TTFT, chunk count, total chars, duration)
    startStreamMetrics(conversationId)

    // Stage 6: Prepare user message
    const { fullContent, imageAttachments } = this.prepareUserMessage(text, attachments)
    const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]'
    messageRepository.create(conversationId, 'user', text, undefined, attachmentsJson)
    log.info('User message saved to DB')

    // Stage 7: Build context + listeners
    const ctx: StreamContext = {
      conversationId,
      requestId,
      streamingRole,
      phase,
      specialistMeta,
      adapterAgentId,
      workspacePath: chatAgentService.getWorkspacePath() ?? undefined,
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
      conversationLifecycle.abort('workspace-switch')
    }
  }

  // N14: Clean up all persistent listeners when the service is replaced
  dispose(): void {
    this.isDisposed = true

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

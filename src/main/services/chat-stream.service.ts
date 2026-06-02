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
import { flushTextBatcher, getAndClearToolActivities } from '../ipc/chunk-router'
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

const log = chatIpcLogger

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

  // N14: Track hook lifecycle listener for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hookLifecycleHandler?: ((...args: any[]) => void) | undefined

  constructor(mainWindow: BrowserWindow, callbacks: PipelineCallbacks) {
    this.mainWindow = mainWindow
    this.callbacks = callbacks
    this.intentRouter = new IntentRouter(mainWindow)
    this.registerEventForwarders()
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
      this.mainWindow.webContents.send(
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
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
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
      this.mainWindow.webContents.send(IPC_CHANNELS.ELICITATION_REQUEST, {
        conversationId: chatAgentService.getCurrentConversationId() || '',
        ...data
      })
    }
    chatAgentService.on('elicitation', onElicitation)
    this.eventCleanups.push(() => chatAgentService.off('elicitation', onElicitation))

    // Budget cap reached — forward as a CHAT_MESSAGE_CHUNK with budgetCapReached field
    const onBudgetCapReached = (data: { conversationId: string; message: string }): void => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
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
        this.activeRequestId ?? undefined
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
            id: `elicit-${data.requestId ?? Date.now()}`,
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
            summary: data.questions?.[0]?.text || 'Question from agent',
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

  // ── Stream Listener Factory ──

  /**
   * Builds the per-stream event listeners as a cohesive object.
   * Extracted from stream() to reduce its cyclomatic complexity.
   */
  private buildStreamListeners(ctx: {
    conversationId: string
    requestId: string
    streamingRole: 'da-vinci' | 'specialist'
    phase: ConversationPhase
    streamedContent: { value: string }
    planInjected: { value: boolean }
    workspacePath: string | undefined
    specialistMeta: { specialist: string; taskId?: string } | undefined
    adapterAgentId: string
    resolveDone: () => void
    rejectDone: (err: Error) => void
  }): {
    onChunk: (chunk: StreamChunk) => void
    onComplete: () => void
    onIntent: (intent: AgentIntent) => Promise<void>
    onPlanEvent: (data: PlanDetectedEvent) => void
    cleanupListeners: () => void
  } {
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
          ctx.streamedContent,
          ctx.workspacePath,
          ctx.specialistMeta,
          ctx.phase,
          ctx.requestId
        )
      } catch (error) {
        log.error('Failed to forward chunk to renderer:', error)
      }
    }

    const onComplete = (): void => {
      // Flush any pending batched text deltas before finalizing
      flushTextBatcher()

      if (this.isStopped) {
        cleanupListeners()
        ctx.resolveDone()
        return
      }

      const finalize = async (): Promise<void> => {
        try {
          log.info('Agent complete — saving to DB:', {
            contentLen: ctx.streamedContent.value.length
          })
          const cleanedContent = ctx.streamedContent.value.trim()

          if (!cleanedContent) {
            const accumulatedText = chatAgentService.getStreamedContent()
            log.error(
              `[PIPELINE:silent-failure] Agent completed with no streamed content. ` +
                `streamedLen=${ctx.streamedContent.value.length} ` +
                `accumulatedLen=${accumulatedText?.length ?? 0} ` +
                `executorBackend=${chatAgentService.getExecutorBackend()} ` +
                `role=${ctx.streamingRole} specialist=${ctx.specialistMeta?.specialist ?? 'none'} ` +
                `accumulatedPreview=${(accumulatedText ?? '').slice(0, 200).replace(/\n/g, ' ')}`
            )

            // Surface the failure to the user instead of saving an empty message
            this.mainWindow.webContents.send(
              IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
              createTextChunk({
                conversationId: ctx.conversationId,
                requestId: ctx.requestId,
                text: '\n\n**Error:** Agent produced no response. Check the app logs for details.',
                role: ctx.streamingRole
              })
            )
          }

          const savedMessage = messageRepository.create(
            ctx.conversationId,
            ctx.streamingRole,
            cleanedContent ||
              '**Error:** Agent produced no response. Check the app logs for details.',
            ctx.specialistMeta?.specialist ?? ctx.adapterAgentId
          )
          log.info('Agent message saved, id:', savedMessage.id)

          // Persist tool activities accumulated during streaming
          const toolActivities = getAndClearToolActivities(ctx.conversationId)
          if (toolActivities.length > 0) {
            messageRepository.updateToolActivities(savedMessage.id, toolActivities)
            log.info(
              `[PIPELINE:tool-activities-persisted] messageId=${savedMessage.id} count=${toolActivities.length}`
            )
          }

          // Process memory blocks
          try {
            const wpPath = chatAgentService.getWorkspacePath()
            const allWorkspaces = wpPath ? workspaceRepository.findAll() : []
            const workspace = allWorkspaces.find((w) => w.repoPath === wpPath)
            if (workspace) {
              const memoriesCreated = memoryService.processMemoryBlocks(
                ctx.streamedContent.value,
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

          log.info(
            `[PIPELINE:agent-message-saved] messageId=${savedMessage.id} contentLen=${cleanedContent.length}`
          )
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
            createCompleteMessage({
              conversationId: ctx.conversationId,
              messageId: savedMessage.id,
              requestId: ctx.requestId
            })
          )
        } catch (error) {
          log.error('Failed to save generalist message:', error)
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({
              conversationId: ctx.conversationId,
              requestId: ctx.requestId,
              text: `\n\n**Error saving response:** ${(error as Error).message}`,
              role: ctx.streamingRole
            })
          )
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
            createCompleteMessage({
              conversationId: ctx.conversationId,
              messageId: `error-${Date.now()}`,
              requestId: ctx.requestId
            })
          )
        }

        conversationStateMachine.transition('chatAgentComplete')
        cleanupListeners()
        ctx.resolveDone()
      }

      finalize().catch((err) => {
        log.error('[PIPELINE:complete] Finalize failed:', err)
        cleanupListeners()
        ctx.rejectDone(err instanceof Error ? err : new Error(String(err)))
      })
    }

    const onIntent = async (_intent: AgentIntent): Promise<void> => {
      // No-op — handled by IntentRouter's persistent listener
    }

    const onPlanEvent = (data: PlanDetectedEvent): void => {
      if (ctx.planInjected.value) {
        log.warn('[PIPELINE:plan-skipped] Plan already injected this stream — skipping duplicate')
        return
      }
      ctx.planInjected.value = true

      const planBlock = `\n\n\`\`\`plan\n${data.rawContent}\n\`\`\`\n\n`
      ctx.streamedContent.value += planBlock
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId: ctx.conversationId,
          requestId: ctx.requestId,
          text: planBlock,
          role: ctx.streamingRole
        })
      )
      log.info(
        '[PIPELINE:plan-injected] Plan block injected into streamed content and forwarded to renderer'
      )
    }

    const cleanupListeners = (): void => {
      if (conversationLifecycle.isActive) {
        conversationLifecycle.complete()
      }
    }

    return { onChunk, onComplete, onIntent, onPlanEvent, cleanupListeners }
  }

  // ── Stream Lifecycle ──

  /**
   * Full generalist streaming lifecycle.
   */
  async stream(
    conversationId: string,
    text: string,
    attachments?: string[]
  ): Promise<StreamHandle> {
    // Prevent concurrent streams — reject if already streaming
    if (this.streamingLock || !conversationStateMachine.isIdle()) {
      log.warn('[STREAM:concurrent-rejected] Already streaming or state machine not idle')
      throw new Error(
        'A message is already being processed. Please wait for it to complete or stop it first.'
      )
    }
    this.streamingLock = true
    conversationStateMachine.transition('sendMessage', conversationId)

    // Snapshot the active adapter's identity for this turn — adapter cannot change
    // mid-stream because switchPersona / swap require lifecycle stop.
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

    // Snapshot per-stream identity for event forwarders (e.g. compactNeeded)
    this.currentStreamingRole = streamingRole

    // Reset stop flag for new message cycle
    this.isStopped = false

    // Start lifecycle — generates requestId, provides AbortSignal for cooperative cancellation
    const signal = conversationLifecycle.begin(conversationId)
    const requestId = conversationLifecycle.requestId!
    this.activeRequestId = requestId

    // Deferred promise — resolves when the entire pipeline completes
    let resolveDone!: () => void
    let rejectDone!: (err: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    // Register centralized cleanup — runs on both complete() and abort()
    conversationLifecycle.onDispose(() => {
      this.streamingLock = false
      this.activeRequestId = null
      // Don't reset currentStreamingRole to a hardcoded 'da-vinci' —
      // it should retain the per-stream value until the next stream starts.
      // Resetting to 'da-vinci' corrupts any event forwarders that fire
      // between dispose and the next stream() call (e.g. compactNeeded).

      // Stop keepalive timer
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer)
        this.keepaliveTimer = null
      }
    })
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

    void signal // AbortSignal available for future cooperative cancellation

    // ── Step 0: Announce streaming identity ──
    // The renderer's thinking indicator renders as soon as isStreaming=true
    // (set by sendMessage before the IPC invoke resolves). This early chunk
    // sets streamingRole + streamingSpecialist so the avatar matches the
    // active adapter from the first frame — before any content arrives.
    this.mainWindow.webContents.send(
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

    // ── Keepalive ──
    // MCP tools (e.g. Maestro run_flow_files) can block the SDK message loop for
    // minutes. The renderer's 2-minute safety timer would fire and disconnect the UI.
    // This keepalive sends a lightweight IPC event every 30s to keep the timer alive.
    this.keepaliveTimer = setInterval(() => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        requestId,
        keepalive: true
      })
    }, 30_000)

    // Clear any stale tool activities from a previous crashed stream
    getAndClearToolActivities(conversationId)

    // ── Step 1: Process attachments ──
    let fullContent = text
    let imageAttachments: ImageAttachment[] = []

    if (attachments && attachments.length > 0) {
      const result = this.processAttachments(attachments)
      fullContent += result.textContent
      imageAttachments = result.images
    }

    // ── Step 2: Save user message to DB ──
    const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]'
    messageRepository.create(conversationId, 'user', text, undefined, attachmentsJson)
    log.info('User message saved to DB')

    // ── Build per-stream listeners (extracted for reduced complexity) ──
    const streamedContent = { value: '' }
    const planInjected = { value: false }
    const workspacePath = chatAgentService.getWorkspacePath() ?? undefined

    const { onChunk, onComplete, onIntent, onPlanEvent } = this.buildStreamListeners({
        conversationId,
        requestId,
        streamingRole,
        phase,
        streamedContent,
        planInjected,
        workspacePath,
        specialistMeta,
        adapterAgentId,
        resolveDone,
        rejectDone
      })

    // ── Step 3 + 5: Mode switch + send ──
    try {
      const conversation = conversationRepository.findById(conversationId)
      if (conversation && conversation.mode !== chatAgentService.getMode()) {
        log.info(`Deferred mode switch: ${chatAgentService.getMode()} → ${conversation.mode}`)
        await chatAgentService.switchMode(conversation.mode as ConversationMode)
      }

      chatAgentService.on('chunk', onChunk)
      chatAgentService.on('complete', onComplete)
      chatAgentService.on('intent', onIntent)
      chatAgentService.on('plan', onPlanEvent)
      await chatAgentService.send(
        fullContent,
        conversationId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      )
    } catch (error) {
      // Lifecycle abort handles: streamingLock, listener removal, state machine force-reset
      conversationLifecycle.abort('streamError')

      eventLoggerService.logSessionFailed({
        conversationId,
        agentId: adapterAgentId,
        error: (error as Error).message
      })

      const roleLabel = streamingRole === 'specialist' ? 'Specialist' : 'Generalist'
      log.error(`${roleLabel} send failed:`, (error as Error).message)
      const errorMsg = `**${roleLabel} Error:** ${(error as Error).message}\n\nMake sure Claude CLI is installed and a workspace is open.`
      const savedMessage = messageRepository.create(
        conversationId,
        streamingRole,
        errorMsg,
        specialistMeta?.specialist ?? adapterAgentId
      )

      // Persist any tool activities accumulated before the error
      const errorToolActivities = getAndClearToolActivities(conversationId)
      if (errorToolActivities.length > 0) {
        messageRepository.updateToolActivities(savedMessage.id, errorToolActivities)
      }

      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId,
          requestId,
          text: errorMsg,
          role: streamingRole
        })
      )
      this.mainWindow.webContents.send(
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
          messageRepository.updateToolActivities(savedMessage.id, stopToolActivities)
          log.info(
            `[PIPELINE:tool-activities-persisted-on-stop] count=${stopToolActivities.length}`
          )
        }

        this.mainWindow.webContents.send(
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

    // Cancel generalist query
    chatAgentService.cancelCurrentQuery()

    // Lifecycle abort handles: streamingLock, activeRequestId, listener removal, state machine reset
    conversationLifecycle.abort('userStop')
  }

  // ── Compact ──

  async compact(extractNuance = false): Promise<void> {
    log.info(`Compact requested (nuance=${extractNuance})`)
    await chatAgentService.compact(extractNuance)
  }

  // N14: Clean up all persistent listeners when the service is replaced
  dispose(): void {
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

import type { BrowserWindow } from 'electron'
import { conversationRepository, messageRepository, workspaceRepository } from '../db/repositories'
import { chatAgentService, fileService } from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  ElicitationEvent,
  AgentIntent,
  GrillQuestion,
  ImageAttachment,
  PlanDetectedEvent
} from '../../shared/types'
import { memoryService } from './memory.service'
import { eventLoggerService } from './event-logger.service'
import { forwardChunkToRenderer } from '../ipc/chat-shared'
import { createTextChunk, createCompleteMessage, createCompactNeeded } from '../ipc/chat-protocol'
import { chatIpcLogger } from '../logger'
import { IntentRouter } from './intent-router'
import { conversationStateMachine } from './conversation-state-machine'
import { conversationLifecycle } from './conversation-lifecycle'

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
  private registerEventForwarders(): void {
    // compactNeeded is not an intent — keep as direct forwarder
    chatAgentService.on('compactNeeded', (data: { level: string; inputTokens: number }) => {
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createCompactNeeded({
          conversationId: chatAgentService.getCurrentConversationId() || '',
          requestId: this.activeRequestId ?? undefined,
          role: 'da-vinci',
          compactNeeded: data
        })
      )
    })

    // Legacy forwarders for MCP-triggered events (fire during streaming)
    // These handle the immediate path when control tools fire via MCP callbacks.
    chatAgentService.on('askQuestion', (data: { questions: GrillQuestion[]; action?: string }) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
        conversationId: chatAgentService.getCurrentConversationId() || '',
        questions: data.questions,
        action: data.action
      })
    })

    // Elicitation — MCP server user input requests forwarded to renderer
    chatAgentService.on('elicitation', (data: ElicitationEvent) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.ELICITATION_REQUEST, {
        conversationId: chatAgentService.getCurrentConversationId() || '',
        ...data
      })
    })

    // NOTE: The persistent 'plan' listener was removed to prevent duplicate delivery.
    // Plan events are now handled exclusively by the per-message onPlanEvent listener
    // in stream(), which both forwards to the renderer AND injects into streamedContent
    // for DB persistence. The CHAT_PLAN IPC is still sent by the IntentRouter below
    // for regex-fallback detected plans.

    // Typed intent handler — routes post-stream intents (regex fallback + grill events)
    // via IntentRouter. Skips plan/askUser if they were already sent by MCP forwarders above.
    chatAgentService.on('intent', (intent: AgentIntent) => {
      const conversationId = chatAgentService.getCurrentConversationId() || ''

      // Skip types that were already forwarded by MCP legacy listeners
      // (plan, askUser are emitted both by MCP callbacks and post-stream detection,
      // but IntentDetector.detectAll() already filters out MCP-fired types, so these
      // intents only arrive here when they're regex-fallback detected)
      this.intentRouter.route(conversationId, intent)
    })
  }

  // ── Stream Lifecycle ──

  /**
   * Full generalist streaming lifecycle.
   */
  async stream(conversationId: string, text: string, attachments?: string[]): Promise<StreamHandle> {
    // Prevent concurrent streams — reject if already streaming
    if (this.streamingLock || !conversationStateMachine.isIdle()) {
      log.warn('[STREAM:concurrent-rejected] Already streaming or state machine not idle')
      throw new Error(
        'A message is already being processed. Please wait for it to complete or stop it first.'
      )
    }
    this.streamingLock = true
    conversationStateMachine.transition('sendMessage', conversationId)

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

    // ── Step 1: Process attachments ──
    let fullContent = text
    const imageAttachments: ImageAttachment[] = []

    if (attachments && attachments.length > 0) {
      const attachmentContents: string[] = []
      for (const filePath of attachments) {
        try {
          if (fileService.isImageFile(filePath)) {
            const { base64, mimeType } = fileService.readImageAsBase64(filePath)
            const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
            imageAttachments.push({ base64, mimeType, fileName })
            attachmentContents.push(
              `\n---\n**Attached image: ${fileName}** (${mimeType}) — visible in the conversation\n`
            )
          } else {
            const content = fileService.readFileContent(filePath)
            const tokens = fileService.estimateTokens(content)
            attachmentContents.push(
              `\n---\n**Attached file: ${filePath}** (${tokens} tokens)\n\`\`\`\n${content}\n\`\`\`\n`
            )
          }
        } catch (error) {
          attachmentContents.push(
            `\n---\n**Failed to read: ${filePath}**: ${(error as Error).message}\n`
          )
        }
      }
      fullContent += attachmentContents.join('')
    }

    // ── Step 2: Save user message to DB ──
    const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]'
    messageRepository.create(conversationId, 'user', text, undefined, attachmentsJson)
    log.info('User message saved to DB')

    // ── Setup shared state for listeners ──
    const streamedContent = { value: '' }
    const workspacePath = chatAgentService.getWorkspacePath() ?? undefined

    // ── Step 4: Define listeners ──
    const onChunk = (chunk: StreamChunk): void => {
      try {
        log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
        forwardChunkToRenderer(
          this.mainWindow,
          conversationId,
          'da-vinci',
          chunk,
          streamedContent,
          workspacePath,
          undefined,
          'da-vinci-responding',
          requestId
        )
      } catch (error) {
        log.error('Failed to forward chunk to renderer:', error)
      }
    }

    const onComplete = (): void => {
      if (this.isStopped) {
        cleanupListeners()
        resolveDone() // Resolve even on stop — the stop was intentional
        return
      }

      const finalize = async (): Promise<void> => {
        // Persist the generalist response to the DB before finishing the turn.
        try {
          log.info('Agent complete — saving to DB:', {
            contentLen: streamedContent.value.length
          })
          const cleanedContent = streamedContent.value.trim()

          if (!cleanedContent) {
            log.warn('Agent completed with no content — possible silent failure')
          }

          const savedMessage = messageRepository.create(
            conversationId,
            'da-vinci',
            cleanedContent ||
              '_No response received. The agent may have encountered an issue while processing. Try sending your message again._'
          )
          log.info('Agent message saved, id:', savedMessage.id)

          // Process memory blocks
          try {
            const wpPath = chatAgentService.getWorkspacePath()
            const allWorkspaces = wpPath ? workspaceRepository.findAll() : []
            const workspace = allWorkspaces.find((w) => w.repoPath === wpPath)
            if (workspace) {
              const memoriesCreated = memoryService.processMemoryBlocks(
                streamedContent.value,
                conversationId,
                'da-vinci',
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
              conversationId,
              messageId: savedMessage.id,
              requestId
            })
          )
        } catch (error) {
          log.error('Failed to save generalist message:', error)
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({
              conversationId,
              requestId,
              text: `\n\n**Error saving response:** ${(error as Error).message}`,
              role: 'da-vinci'
            })
          )
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
            createCompleteMessage({
              conversationId,
              messageId: `error-${Date.now()}`,
              requestId
            })
          )
        }

        conversationStateMachine.transition('chatAgentComplete')

        cleanupListeners()
        resolveDone()
      }

      finalize().catch((err) => {
        log.error('[PIPELINE:complete] Finalize failed:', err)
        cleanupListeners()
        rejectDone(err instanceof Error ? err : new Error(String(err)))
      })
    }

    // 'intent' events are forwarded by IntentRouter's persistent listener;
    // no per-stream handling is required here.
    const onIntent = async (_intent: AgentIntent): Promise<void> => {
      // No-op.
    }

    // Plan event handler — injects ```plan``` block into streamed content so it's
    // persisted to DB and the renderer's regex renders the TaskPlanCard.
    // Must ALSO send the block as a chunk so the renderer's streamingContent includes it
    // (finalizeStream builds contentMd from renderer-side streamingContent, not the DB).
    const onPlanEvent = (data: PlanDetectedEvent): void => {
      const planBlock = `\n\n\`\`\`plan\n${data.rawContent}\n\`\`\`\n\n`
      streamedContent.value += planBlock
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId,
          requestId,
          text: planBlock,
          role: 'da-vinci'
        })
      )
      log.info(
        '[PIPELINE:plan-injected] Plan block injected into streamed content and forwarded to renderer'
      )
    }

    // cleanupListeners delegates to lifecycle disposers for centralized cleanup
    const cleanupListeners = (): void => {
      // Lifecycle disposers handle: streamingLock, activeRequestId, listener removal
      // If lifecycle is still active, complete it. If already completed/aborted, this is a no-op.
      if (conversationLifecycle.isActive) {
        conversationLifecycle.complete()
      }
    }

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
        agentId: 'da-vinci',
        error: (error as Error).message
      })

      log.error('Generalist send failed:', (error as Error).message)
      const errorMsg = `**Generalist Error:** ${(error as Error).message}\n\nMake sure Claude CLI is installed and a workspace is open.`
      const savedMessage = messageRepository.create(conversationId, 'da-vinci', errorMsg)

      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId,
          requestId,
          text: errorMsg,
          role: 'da-vinci'
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

  // ── Stop ──

  async stop(): Promise<void> {
    this.isStopped = true

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

        const savedMessage = messageRepository.create(conversationId, 'da-vinci', contentToSave)
        log.info('Stopped message saved to DB, id:', savedMessage.id)

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
}

// ── Singleton with lazy initialization ──

let _instance: ChatStreamService | null = null

export function initChatStream(
  mainWindow: BrowserWindow,
  callbacks: PipelineCallbacks
): ChatStreamService {
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

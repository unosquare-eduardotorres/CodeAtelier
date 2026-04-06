import type { BrowserWindow } from 'electron'
import {
  conversationRepository,
  messageRepository,
  workspaceRepository
} from '../db/repositories'
import { generalistService, fileService } from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  GrillEvaluation,
  GrillQuestion,
  HandoffBrief,
  ImageAttachment
} from '../../shared/types'
import { memoryService } from './memory.service'
import { eventLoggerService } from './event-logger.service'
import { forwardChunkToRenderer } from '../ipc/chat-shared'
import { chatIpcLogger } from '../logger'

const log = chatIpcLogger

// ── Pipeline Callbacks (strategy object) ──

export interface PipelineCallbacks {
  onHandoff: (conversationId: string, brief: HandoffBrief) => Promise<void>
  onStopPipeline: () => Promise<void>
}

// ── Stream Service ──

export class GeneralistStreamService {
  private mainWindow: BrowserWindow
  private callbacks: PipelineCallbacks

  /** Instance-level flag to prevent duplicate message saves when stop is called mid-stream */
  private isStopped = false

  constructor(mainWindow: BrowserWindow, callbacks: PipelineCallbacks) {
    this.mainWindow = mainWindow
    this.callbacks = callbacks
    this.registerEventForwarders()
  }

  // ── Persistent Event Forwarders ──

  /**
   * Register once-at-startup event forwarders from generalist → renderer.
   * These fire during any active stream but are independent of per-message lifecycle.
   */
  private registerEventForwarders(): void {
    generalistService.on('compactNeeded', (data: { level: string; inputTokens: number }) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId: generalistService.getCurrentConversationId() || '',
        chunk: '',
        role: 'generalist',
        compactNeeded: data
      })
    })

    generalistService.on('grillQuestion', (data: { questions: GrillQuestion[] }) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_QUESTION, {
        conversationId: generalistService.getCurrentConversationId() || '',
        questions: data.questions
      })
    })

    generalistService.on('askQuestion', (data: { questions: GrillQuestion[] }) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
        conversationId: generalistService.getCurrentConversationId() || '',
        questions: data.questions
      })
    })

    generalistService.on('grillEvaluation', (data: GrillEvaluation) => {
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_EVALUATION, {
        conversationId: generalistService.getCurrentConversationId() || '',
        ...data
      })
    })

    generalistService.on(
      'grillComplete',
      (data: { summary: string; proposedTasks: Array<{ title: string; description: string }> }) => {
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_COMPLETE, {
          conversationId: generalistService.getCurrentConversationId() || '',
          summary: data.summary,
          proposedTasks: data.proposedTasks
        })
      }
    )
  }

  // ── Stream Lifecycle ──

  /**
   * Full generalist streaming lifecycle.
   */
  async stream(
    conversationId: string,
    text: string,
    attachments?: string[]
  ): Promise<void> {
    // Reset stop flag for new message cycle
    this.isStopped = false

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
    let handoffPromise: Promise<void> | null = null
    const workspacePath = generalistService.getWorkspacePath() ?? undefined

    // ── Step 4: Define listeners ──
    const onChunk = (chunk: StreamChunk): void => {
      try {
        log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
        forwardChunkToRenderer(
          this.mainWindow,
          conversationId,
          'generalist',
          chunk,
          streamedContent,
          workspacePath
        )
      } catch (error) {
        log.error('Failed to forward chunk to renderer:', error)
      }
    }

    const onComplete = (): void => {
      if (this.isStopped) {
        cleanupListeners()
        return
      }

      const finalize = async (): Promise<void> => {
        if (handoffPromise) {
          log.info('[PIPELINE:complete] Waiting for handoff to finish before saving message')
          try {
            await handoffPromise
          } catch (err) {
            log.warn('[PIPELINE:complete] Handoff promise failed, continuing:', err)
          }
        }

        try {
          log.info('Generalist complete — saving to DB:', {
            contentLen: streamedContent.value.length
          })
          const cleanedContent = streamedContent.value
            .replace(/```handoff\n[\s\S]*?```/, '')
            .replace(/```(?:json)?\n\{[\s\S]*?"action"\s*:\s*"handoff"[\s\S]*?\}\n```/, '')
            .trim()

          if (!cleanedContent && handoffPromise) {
            log.info(
              '[PIPELINE:generalist-message-skipped] Content was entirely handoff block — no user message to save'
            )
            this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
              conversationId,
              messageId: `handoff-only-${Date.now()}`
            })
            cleanupListeners()
            return
          }

          if (!cleanedContent) {
            log.warn('Generalist completed with no content — possible silent failure')
          }

          const savedMessage = messageRepository.create(
            conversationId,
            'generalist',
            cleanedContent ||
              '_No response received. The agent may have encountered an issue while processing. Try sending your message again._'
          )
          log.info('Generalist message saved, id:', savedMessage.id)

          // Process memory blocks
          try {
            const wpPath = generalistService.getWorkspacePath()
            const allWorkspaces = wpPath ? workspaceRepository.findAll() : []
            const workspace = allWorkspaces.find((w) => w.repoPath === wpPath)
            if (workspace) {
              const memoriesCreated = memoryService.processMemoryBlocks(
                streamedContent.value,
                conversationId,
                'generalist',
                workspace.id
              )
              if (memoriesCreated > 0) {
                log.info(`Created ${memoriesCreated} memories from generalist response`)
              }
            }
          } catch (memErr) {
            log.warn('Memory block processing failed:', memErr)
          }

          log.info(
            `[PIPELINE:generalist-message-saved] messageId=${savedMessage.id} contentLen=${cleanedContent.length}`
          )
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
            conversationId,
            messageId: savedMessage.id
          })
        } catch (error) {
          log.error('Failed to save generalist message:', error)
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: `\n\n**Error saving response:** ${(error as Error).message}`,
            role: 'generalist'
          })
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
            conversationId,
            messageId: `error-${Date.now()}`
          })
        }

        cleanupListeners()
      }

      finalize().catch((err) => {
        log.error('[PIPELINE:complete] Finalize failed:', err)
        cleanupListeners()
      })
    }

    const onHandoff = async (brief: HandoffBrief): Promise<void> => {
      const doHandoff = async (): Promise<void> => {
        log.info('Handoff received from generalist:', brief.summary)
        await this.callbacks.onHandoff(conversationId, brief)
        generalistService.removeListener('handoff', onHandoff)
      }

      handoffPromise = doHandoff()
      await handoffPromise
    }

    const cleanupListeners = (): void => {
      generalistService.removeListener('chunk', onChunk)
      generalistService.removeListener('complete', onComplete)
      generalistService.removeListener('handoff', onHandoff)
    }

    // ── Step 3 + 5: Mode switch + send ──
    try {
      const conversation = conversationRepository.findById(conversationId)
      if (conversation && conversation.mode !== generalistService.getMode()) {
        log.info(`Deferred mode switch: ${generalistService.getMode()} → ${conversation.mode}`)
        await generalistService.switchMode(conversation.mode as ConversationMode)
      }

      generalistService.on('chunk', onChunk)
      generalistService.on('complete', onComplete)
      generalistService.on('handoff', onHandoff)
      await generalistService.send(
        fullContent,
        conversationId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      )
    } catch (error) {
      cleanupListeners()

      eventLoggerService.logSessionFailed({
        conversationId,
        agentId: 'generalist',
        error: (error as Error).message
      })

      log.error('Generalist send failed:', (error as Error).message)
      const errorMsg = `**Generalist Error:** ${(error as Error).message}\n\nMake sure Claude CLI is installed and a workspace is open.`
      const savedMessage = messageRepository.create(conversationId, 'generalist', errorMsg)

      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        chunk: errorMsg,
        role: 'generalist'
      })
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
        conversationId,
        messageId: savedMessage.id
      })
    }
  }

  // ── Stop ──

  async stop(): Promise<void> {
    this.isStopped = true

    const conversationId = generalistService.getCurrentConversationId()

    // Stop specialist pool via callback
    await this.callbacks.onStopPipeline()

    // Save partial content
    if (conversationId) {
      try {
        const partialContent = generalistService.getStreamedContent()
        const contentToSave = partialContent
          ? partialContent + '\n\n---\n\n⏹ *Generation stopped by user.*'
          : '⏹ *Generation stopped by user.*'

        const savedMessage = messageRepository.create(conversationId, 'generalist', contentToSave)
        log.info('Stopped message saved to DB, id:', savedMessage.id)

        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMessage.id
        })
      } catch (error) {
        log.error('Failed to save stopped message:', error)
      }
    }

    // Cancel generalist query
    generalistService.cancelCurrentQuery()
  }

  // ── Compact ──

  async compact(): Promise<void> {
    log.info('Compact requested')
    await generalistService.compact()
  }
}

// ── Singleton with lazy initialization ──

let _instance: GeneralistStreamService | null = null

export function initGeneralistStream(
  mainWindow: BrowserWindow,
  callbacks: PipelineCallbacks
): GeneralistStreamService {
  _instance = new GeneralistStreamService(mainWindow, callbacks)
  return _instance
}

export const generalistStreamService = new Proxy({} as GeneralistStreamService, {
  get(_target, prop) {
    if (!_instance)
      throw new Error(
        'GeneralistStreamService not initialized — call initGeneralistStream(mainWindow, callbacks) first'
      )
    return (_instance as unknown as Record<string, unknown>)[prop as string]
  }
})

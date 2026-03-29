import { ipcMain, type BrowserWindow } from 'electron'
import { extname } from 'node:path'
import {
  conversationRepository,
  messageRepository,
  workspaceRepository
} from '../db/repositories'
import {
  generalistService,
  orchestratorService,
  specialistPoolService,
  fileService
} from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  GrillEvaluation,
  GrillQuestion,
  HandoffBrief
} from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { chatIpcLogger } from '../logger'
import { eventLoggerService } from '../services/event-logger.service'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer } from './chat-shared'
import { runLegacyOrchestrator } from './chat-plan.ipc'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20
/** Maximum number of image attachments per message */
const MAX_IMAGE_ATTACHMENTS = 5

/** Module-level flag to prevent duplicate message saves when stop is called mid-stream */
let isStopped = false

export function registerChatMessageIpc(mainWindow: BrowserWindow): void {
  // Persistent listener: forward compact suggestions to the renderer
  generalistService.on('compactNeeded', (data: { level: string; inputTokens: number }) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId: generalistService.getCurrentConversationId() || '',
      chunk: '',
      role: 'generalist',
      compactNeeded: data
    })
  })

  // Persistent listener: forward grill question events to the renderer
  generalistService.on('grillQuestion', (data: { questions: GrillQuestion[] }) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_QUESTION, {
      conversationId: generalistService.getCurrentConversationId() || '',
      questions: data.questions
    })
  })

  // Persistent listener: forward ask-question events (general chat questions) to the renderer
  generalistService.on('askQuestion', (data: { questions: GrillQuestion[] }) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
      conversationId: generalistService.getCurrentConversationId() || '',
      questions: data.questions
    })
  })

  // Persistent listener: forward grill evaluation events (new structured format) to the renderer
  generalistService.on('grillEvaluation', (data: GrillEvaluation) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_EVALUATION, {
      conversationId: generalistService.getCurrentConversationId() || '',
      ...data
    })
  })

  // Persistent listener: forward grill session complete events to the renderer
  generalistService.on(
    'grillComplete',
    (data: { summary: string; proposedTasks: Array<{ title: string; description: string }> }) => {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_COMPLETE, {
        conversationId: generalistService.getCurrentConversationId() || '',
        summary: data.summary,
        proposedTasks: data.proposedTasks
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND,
    async (event, args: { conversationId: string; text: string; attachments?: string[] }) => {
      validateSender(event)

      // Reset stop flag for new message cycle
      isStopped = false

      // Input validation
      if (!args || typeof args !== 'object') {
        throw new Error('Invalid arguments')
      }

      const { conversationId, text, attachments } = args

      if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
        throw new Error('Invalid conversation ID')
      }

      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Message text cannot be empty')
      }

      if (text.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Message too long: ${text.length} chars (max ${MAX_MESSAGE_LENGTH})`)
      }

      if (attachments !== undefined) {
        if (!Array.isArray(attachments)) {
          throw new Error('Attachments must be an array')
        }
        if (attachments.length > MAX_ATTACHMENTS) {
          throw new Error(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS})`)
        }
        for (const filePath of attachments) {
          if (typeof filePath !== 'string') {
            throw new Error('Each attachment must be a file path string')
          }
        }

        // Count images specifically
        const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
        const imageCount = attachments.filter((p) =>
          imageExtensions.has(extname(p).toLowerCase())
        ).length
        if (imageCount > MAX_IMAGE_ATTACHMENTS) {
          throw new Error(
            `Too many image attachments: ${imageCount} (max ${MAX_IMAGE_ATTACHMENTS})`
          )
        }
      }

      log.info('SEND received:', {
        conversationId,
        textLen: text.length,
        attachments: attachments?.length ?? 0
      })

      // Build message content with attachments
      let fullContent = text

      if (attachments && attachments.length > 0) {
        const attachmentContents: string[] = []
        for (const filePath of attachments) {
          try {
            if (fileService.isImageFile(filePath)) {
              // Images: encode as base64 data URI for the AI
              const { base64, mimeType } = fileService.readImageAsBase64(filePath)
              const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
              attachmentContents.push(
                `\n---\n**Attached image: ${fileName}** (${mimeType})\n` +
                  `![${fileName}](data:${mimeType};base64,${base64})\n`
              )
            } else {
              // Text files: read as utf-8
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

      // Save user message to database
      const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]'
      messageRepository.create(conversationId, 'user', text, undefined, attachmentsJson)
      log.info('User message saved to DB')

      // Route through generalist (default entry point)
      // Define listeners at outer scope so they're accessible in both try and catch
      const streamedContent = { value: '' }

      const onChunk = (chunk: StreamChunk): void => {
        try {
          log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
          forwardChunkToRenderer(mainWindow, conversationId, 'generalist', chunk, streamedContent)
        } catch (error) {
          log.error('Failed to forward chunk to renderer:', error)
        }
      }

      const onComplete = (): void => {
        // If stop was called, the stop handler already saved the message — skip to avoid duplicates
        if (isStopped) {
          cleanupListeners()
          return
        }

        try {
          log.info('Generalist complete — saving to DB:', {
            contentLen: streamedContent.value.length
          })
          // Strip handoff block before saving — it's structural, not user-facing content
          const cleanedContent = streamedContent.value
            .replace(/```handoff\n[\s\S]*?```/, '')
            .replace(/```(?:json)?\n\{[\s\S]*?"action"\s*:\s*"handoff"[\s\S]*?\}\n```/, '')
            .trim()

          // If the generalist used tools but produced no final text, indicate this to the user
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

          // Process memory blocks from accumulated text
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

          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
            conversationId,
            messageId: savedMessage.id
          })
        } catch (error) {
          log.error('Failed to save generalist message:', error)
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: `\n\n**Error saving response:** ${(error as Error).message}`,
            role: 'generalist'
          })
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
            conversationId,
            messageId: `error-${Date.now()}`
          })
        }

        cleanupListeners()
      }

      // Handle handoff events — generalist detected implementation work
      const onHandoff = async (brief: HandoffBrief): Promise<void> => {
        log.info('Handoff received from generalist:', brief.summary)

        // ── Event: handoff detected ──
        eventLoggerService.logHandoffDetected({
          conversationId,
          summary: brief.summary,
          specialists: brief.specialists,
          mode: brief.mode
        })

        // ── Enrich with recent conversation messages ──
        try {
          const allMessages = messageRepository.findByConversation(conversationId)
          brief.recentMessages = allMessages
            .slice(-10) // Last 10 messages (5 user + 5 assistant turns)
            .map((m) => ({ role: m.role, content: m.contentMd.substring(0, 2000) }))
          log.info(`Enriched handoff with ${brief.recentMessages.length} recent messages`)
        } catch (error) {
          log.warn('Failed to enrich handoff with recent messages:', error)
        }

        // Send visual handoff indicator to the renderer
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
          conversationId,
          summary: brief.summary,
          specialists: brief.specialists,
          mode: brief.mode
        })

        // Update conversation mode if needed
        if (brief.mode) {
          try {
            conversationRepository.updateMode(conversationId, brief.mode)
          } catch (error) {
            log.error('Failed to update conversation mode:', error)
          }
        }

        // Decompose the task into sub-tasks via orchestrator with full brief
        try {
          log.info('Decomposing task for specialists:', brief.specialists)
          const taskPlan = await orchestratorService.decompose(brief, conversationId, brief.mode)

          log.info(`Task decomposed into ${taskPlan.tasks.length} sub-tasks`)

          // Send the task plan to the renderer for user choice (sequential vs parallel)
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)
        } catch (error) {
          log.error('Task decomposition failed, falling back to single orchestrator:', error)

          // ── Event: decomposition fallback ──
          eventLoggerService.logDecompositionFailed({
            conversationId,
            error: (error as Error).message,
            fallback: 'legacy'
          })

          // Fallback: run orchestrator in legacy single-process mode
          try {
            await runLegacyOrchestrator(mainWindow, conversationId, brief)
          } catch (fallbackError) {
            log.error('Legacy orchestrator fallback also failed:', fallbackError)
            // Surface error to user — both SDK decompose and legacy orchestrator failed
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: `\n\n**Error:** Task delegation failed. ${(fallbackError as Error).message}`,
              role: 'coordinator'
            })
            const savedMsg = messageRepository.create(
              conversationId,
              'coordinator',
              `**Error:** Both task decomposition and orchestrator fallback failed.\n\n${(error as Error).message}\n${(fallbackError as Error).message}`
            )
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
              conversationId,
              messageId: savedMsg.id
            })
          }
        }

        // Clean up handoff listener (one-shot)
        generalistService.removeListener('handoff', onHandoff)
      }

      // Cleanup helper — removes all listeners for this message cycle.
      // Called from onComplete AND from the catch block to prevent leaks.
      const cleanupListeners = (): void => {
        generalistService.removeListener('chunk', onChunk)
        generalistService.removeListener('complete', onComplete)
        generalistService.removeListener('handoff', onHandoff)
      }

      try {
        // Deferred mode switch: if the conversation's mode differs from the
        // running CLI mode, restart the CLI now (just-in-time) before sending.
        const conversation = conversationRepository.findById(conversationId)
        if (conversation && conversation.mode !== generalistService.getMode()) {
          log.info(`Deferred mode switch: ${generalistService.getMode()} → ${conversation.mode}`)
          await generalistService.switchMode(conversation.mode as ConversationMode)
        }

        // Register listeners before send to avoid race condition
        generalistService.on('chunk', onChunk)
        generalistService.on('complete', onComplete)
        generalistService.on('handoff', onHandoff)
        await generalistService.send(fullContent, conversationId)
      } catch (error) {
        // Clean up listeners to prevent leaks on error
        cleanupListeners()

        // ── Event: generalist send failure ──
        eventLoggerService.logSessionFailed({
          conversationId,
          agentId: 'generalist',
          error: (error as Error).message
        })

        // If generalist isn't running, save error message
        log.error('Generalist send failed:', (error as Error).message)
        const errorMsg = `**Generalist Error:** ${(error as Error).message}\n\nMake sure Claude CLI is installed and a workspace is open.`
        const savedMessage = messageRepository.create(conversationId, 'generalist', errorMsg)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: errorMsg,
          role: 'generalist'
        })
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMessage.id
        })
      }
    }
  )

  // ── Compact conversation context ──
  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event) => {
    validateSender(event)
    log.info('Compact requested')
    await generalistService.compact()
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (event) => {
    validateSender(event)

    // Set flag to prevent onComplete from saving a duplicate message
    isStopped = true

    // Capture context before stopping
    const conversationId = generalistService.getCurrentConversationId()

    // Stop orchestrator if running (ephemeral per-handoff process)
    if (orchestratorService.isRunning()) {
      await orchestratorService.stop()
    }
    // Stop any running specialist pool tasks
    await specialistPoolService.stopAll()

    // Save partial content to DB so it persists across conversation reloads
    if (conversationId) {
      try {
        const partialContent = generalistService.getStreamedContent()
        const contentToSave = partialContent
          ? partialContent + '\n\n---\n\n⏹ *Generation stopped by user.*'
          : '⏹ *Generation stopped by user.*'

        const savedMessage = messageRepository.create(conversationId, 'generalist', contentToSave)
        log.info('Stopped message saved to DB, id:', savedMessage.id)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMessage.id
        })
      } catch (error) {
        log.error('Failed to save stopped message:', error)
      }
    }

    // Cancel any in-flight generalist SDK query
    generalistService.cancelCurrentQuery()
  })
}

import { ipcMain, type BrowserWindow } from 'electron'
import {
  conversationRepository,
  messageRepository,
  fileChangeRepository,
  workspaceRepository
} from '../db/repositories'
import {
  generalistService,
  orchestratorService,
  specialistPoolService,
  fileService
} from '../services'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ConversationMode, GrillQuestion, HandoffBrief } from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer } from './chat-shared'
import { runLegacyOrchestrator } from './chat-plan.ipc'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20

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
        log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
        forwardChunkToRenderer(mainWindow, conversationId, 'generalist', chunk, streamedContent)
      }

      const onComplete = (): void => {
        try {
          log.info('Generalist complete — saving to DB:', {
            contentLen: streamedContent.value.length
          })
          const savedMessage = messageRepository.create(
            conversationId,
            'generalist',
            streamedContent.value || '_No response received._'
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

          // Fallback: run orchestrator in legacy single-process mode
          await runLegacyOrchestrator(mainWindow, conversationId, brief)
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
    // Stop orchestrator if running (ephemeral per-handoff process)
    if (orchestratorService.isRunning()) {
      await orchestratorService.stop()
    }
    // Stop any running specialist pool tasks
    await specialistPoolService.stopAll()
    // Don't kill the generalist process — it persists across messages
    // Just signal that streaming should stop from the UI perspective
  })
}

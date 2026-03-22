import { ipcMain, app, type BrowserWindow } from 'electron'
import { conversationRepository, messageRepository } from '../db/repositories'
import { generalistService, orchestratorService, fileService } from '../services'
import type { StreamChunk } from '../services'
import type { HandoffEvent } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20

export function registerChatIpc(mainWindow: BrowserWindow): void {
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

      log.info('SEND received:', { conversationId, textLen: text.length, attachments: attachments?.length ?? 0 })

      // Build message content with attachments
      let fullContent = text

      if (attachments && attachments.length > 0) {
        const attachmentContents: string[] = []
        for (const filePath of attachments) {
          try {
            const content = fileService.readFileContent(filePath)
            const tokens = fileService.estimateTokens(content)
            attachmentContents.push(
              `\n---\n**Attached file: ${filePath}** (${tokens} tokens)\n\`\`\`\n${content}\n\`\`\`\n`
            )
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
      try {
        let streamedContent = ''

        const onChunk = (chunk: StreamChunk): void => {
          log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
          if (chunk.type === 'text' && chunk.content) {
            streamedContent += chunk.content
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: chunk.content,
              role: 'generalist'
            })
          } else if (chunk.type === 'tool_use') {
            // Forward tool activity start to renderer
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: '',
              role: 'generalist',
              toolActivity: {
                id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                toolName: chunk.toolName ?? 'Unknown',
                status: 'running',
                startedAt: Date.now()
              }
            })
          } else if (chunk.type === 'tool_result') {
            // Forward tool activity completion to renderer
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: '',
              role: 'generalist',
              toolActivity: {
                id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                toolName: chunk.toolName ?? 'Unknown',
                status: 'completed',
                completedAt: Date.now()
              }
            })
          } else if (chunk.type === 'error') {
            streamedContent += `\n\n**Error:** ${chunk.error}`
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: `\n\n**Error:** ${chunk.error}`,
              role: 'generalist'
            })
          }
        }

        const onComplete = (): void => {
          try {
            log.info('Generalist complete — saving to DB:', { contentLen: streamedContent.length })
            const savedMessage = messageRepository.create(
              conversationId,
              'generalist',
              streamedContent || '_No response received._'
            )
            log.info('Generalist message saved, id:', savedMessage.id)

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

          // Clean up listeners
          generalistService.removeListener('chunk', onChunk)
          generalistService.removeListener('complete', onComplete)
        }

        // Handle handoff events — generalist detected implementation work
        const onHandoff = async (handoff: HandoffEvent): Promise<void> => {
          log.info('Handoff received from generalist:', handoff)

          // Send visual handoff indicator to the renderer
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
            conversationId,
            summary: handoff.summary,
            specialists: handoff.specialists,
            mode: handoff.mode
          })

          // Update conversation mode if needed
          if (handoff.mode) {
            try {
              conversationRepository.updateMode(conversationId, handoff.mode)
            } catch (error) {
              log.error('Failed to update conversation mode:', error)
            }
          }

          // Forward the summarized task to the orchestrator
          try {
            let orchestratorContent = ''

            const onOrchestratorChunk = (chunk: StreamChunk): void => {
              if (chunk.type === 'text' && chunk.content) {
                orchestratorContent += chunk.content
                mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
                  conversationId,
                  chunk: chunk.content,
                  role: 'coordinator'
                })
              } else if (chunk.type === 'tool_use') {
                mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
                  conversationId,
                  chunk: '',
                  role: 'coordinator',
                  toolActivity: {
                    id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    toolName: chunk.toolName ?? 'Unknown',
                    status: 'running',
                    startedAt: Date.now()
                  }
                })
              } else if (chunk.type === 'tool_result') {
                mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
                  conversationId,
                  chunk: '',
                  role: 'coordinator',
                  toolActivity: {
                    id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    toolName: chunk.toolName ?? 'Unknown',
                    status: 'completed',
                    completedAt: Date.now()
                  }
                })
              } else if (chunk.type === 'error') {
                orchestratorContent += `\n\n**Error:** ${chunk.error}`
                mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
                  conversationId,
                  chunk: `\n\n**Error:** ${chunk.error}`,
                  role: 'coordinator'
                })
              }
            }

            const onOrchestratorComplete = (): void => {
              const savedMsg = messageRepository.create(
                conversationId,
                'coordinator',
                orchestratorContent || '_No response received from orchestrator._'
              )

              mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
                conversationId,
                messageId: savedMsg.id
              })

              orchestratorService.removeListener('chunk', onOrchestratorChunk)
              orchestratorService.removeListener('complete', onOrchestratorComplete)
            }

            orchestratorService.on('chunk', onOrchestratorChunk)
            orchestratorService.on('complete', onOrchestratorComplete)
            await orchestratorService.send(handoff.summary, conversationId, handoff.mode)
          } catch (error) {
            log.error('Failed to forward handoff to orchestrator:', error)
            const errorMsg = `**Orchestrator Error:** ${(error as Error).message}`
            const savedMsg = messageRepository.create(conversationId, 'coordinator', errorMsg)

            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: errorMsg,
              role: 'coordinator'
            })
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
              conversationId,
              messageId: savedMsg.id
            })
          }

          // Clean up handoff listener (one-shot)
          generalistService.removeListener('handoff', onHandoff)
        }

        // Register listeners before send to avoid race condition
        generalistService.on('chunk', onChunk)
        generalistService.on('complete', onComplete)
        generalistService.on('handoff', onHandoff)
        await generalistService.send(fullContent, conversationId)
      } catch (error) {
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

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_CONVERSATIONS,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)

      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }

      return conversationRepository.findByWorkspace(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
    async (event, args: { workspaceId: string; title?: string; mode?: ConversationMode }) => {
      validateSender(event)

      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }

      if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 500)) {
        throw new Error('Invalid conversation title (max 500 chars)')
      }

      const validModes = ['plan', 'build']
      if (args.mode !== undefined && !validModes.includes(args.mode)) {
        throw new Error('Invalid mode: must be "plan" or "build"')
      }

      return conversationRepository.create(args.workspaceId, args.title, args.mode)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_MESSAGES,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      return messageRepository.findByConversation(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_DELETE_CONVERSATION,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      // Stop orchestrator if it's running for this conversation
      if (orchestratorService.isRunning()) {
        await orchestratorService.stop()
      }
      orchestratorService.clearSession(args.conversationId)

      conversationRepository.delete(args.conversationId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (event) => {
    validateSender(event)
    // Stop orchestrator if running (ephemeral per-handoff process)
    if (orchestratorService.isRunning()) {
      await orchestratorService.stop()
    }
    // Don't kill the generalist process — it persists across messages
    // Just signal that streaming should stop from the UI perspective
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_MODE,
    async (event, args: { conversationId: string; mode: ConversationMode }) => {
      validateSender(event)

      if (!args || typeof args.conversationId !== 'string') {
        throw new Error('Invalid conversation ID')
      }

      const validModes = ['plan', 'build']
      if (!validModes.includes(args.mode)) {
        throw new Error('Invalid mode')
      }

      const updated = conversationRepository.updateMode(args.conversationId, args.mode)
      if (!updated) throw new Error('Conversation not found')
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME,
    async (event, args: { conversationId: string; title: string }) => {
      validateSender(event)

      if (!args || typeof args.conversationId !== 'string' || args.conversationId.trim().length === 0) {
        throw new Error('Invalid conversation ID')
      }
      if (typeof args.title !== 'string' || args.title.trim().length === 0) {
        throw new Error('Title cannot be empty')
      }
      if (args.title.length > 500) {
        throw new Error('Title too long (max 500 chars)')
      }

      const updated = conversationRepository.updateTitle(args.conversationId, args.title.trim())
      if (!updated) throw new Error('Conversation not found')
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE,
    async (event, args: { dataUrl: string }) => {
      validateSender(event)

      if (!args?.dataUrl || typeof args.dataUrl !== 'string') {
        throw new Error('Invalid image data')
      }

      // Extract base64 data from data URL
      const matches = args.dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/)
      if (!matches) {
        throw new Error('Invalid image data URL format')
      }

      const ext = matches[1]
      const base64Data = matches[2]
      const buffer = Buffer.from(base64Data, 'base64')

      // Save to temp directory
      const { join } = await import('node:path')
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const tempDir = join(app.getPath('userData'), 'clipboard-images')
      mkdirSync(tempDir, { recursive: true })

      const filename = `clipboard-${Date.now()}.${ext}`
      const filePath = join(tempDir, filename)
      writeFileSync(filePath, buffer)

      return filePath
    }
  )
}

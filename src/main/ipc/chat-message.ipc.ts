import { ipcMain, type BrowserWindow } from 'electron'
import { extname } from 'node:path'
import {
  conversationRepository,
  messageRepository,
  workspaceRepository,
  specialistRepository
} from '../db/repositories'
import { generalistService, specialistPoolService, fileService } from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  ExecutionStrategy,
  GrillEvaluation,
  GrillQuestion,
  HandoffBrief,
  ImageAttachment,
  TaskPlan
} from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { isInvestigationIntent } from '../services/specialist'
import { chatIpcLogger } from '../logger'
import { eventLoggerService } from '../services/event-logger.service'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer } from './chat-shared'

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

      // Build message content with attachments — images are separated for SDK vision blocks
      let fullContent = text
      const imageAttachments: ImageAttachment[] = []

      if (attachments && attachments.length > 0) {
        const attachmentContents: string[] = []
        for (const filePath of attachments) {
          try {
            if (fileService.isImageFile(filePath)) {
              // Images: collect as structured data for SDK vision content blocks
              const { base64, mimeType } = fileService.readImageAsBase64(filePath)
              const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
              imageAttachments.push({ base64, mimeType, fileName })
              // Also add a text note so the agent knows an image was attached
              attachmentContents.push(
                `\n---\n**Attached image: ${fileName}** (${mimeType}) — visible in the conversation\n`
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
      let handoffPromise: Promise<void> | null = null
      const workspacePath = generalistService.getWorkspacePath() ?? undefined

      const onChunk = (chunk: StreamChunk): void => {
        try {
          log.debug('Chunk received:', { type: chunk.type, len: chunk.content?.length ?? 0 })
          forwardChunkToRenderer(
            mainWindow,
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
        // If stop was called, the stop handler already saved the message — skip to avoid duplicates
        if (isStopped) {
          cleanupListeners()
          return
        }

        const finalize = async (): Promise<void> => {
          // If a handoff is in progress, wait for it to send the task plan
          // before saving/sending the generalist message (preserves visual ordering)
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
            // Strip handoff block before saving — it's structural, not user-facing content
            const cleanedContent = streamedContent.value
              .replace(/```handoff\n[\s\S]*?```/, '')
              .replace(/```(?:json)?\n\{[\s\S]*?"action"\s*:\s*"handoff"[\s\S]*?\}\n```/, '')
              .trim()

            // If the entire generalist response was the handoff block, there's no user-facing
            // message to save. Skip saving to avoid a ghost Da Vinci bubble in the UI.
            if (!cleanedContent && handoffPromise) {
              log.info(
                '[PIPELINE:generalist-message-skipped] Content was entirely handoff block — no user message to save'
              )
              // Still send message-complete so renderer resets streaming state (isStreaming → false)
              mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
                conversationId,
                messageId: `handoff-only-${Date.now()}`
              })
              cleanupListeners()
              return
            }

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

            log.info(
              `[PIPELINE:generalist-message-saved] messageId=${savedMessage.id} contentLen=${cleanedContent.length}`
            )
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

        finalize().catch((err) => {
          log.error('[PIPELINE:complete] Finalize failed:', err)
          cleanupListeners()
        })
      }

      // Handle handoff events — generalist detected implementation work
      const onHandoff = async (brief: HandoffBrief): Promise<void> => {
        const doHandoff = async (): Promise<void> => {
          log.info('Handoff received from generalist:', brief.summary)

          // ── Event: handoff detected ──
          eventLoggerService.logHandoffDetected({
            conversationId,
            summary: brief.summary,
            specialists: brief.specialists,
            mode: brief.mode
          })

          // ── Enrich with recent conversation messages ──
          // Strategy F: Only load recentMessages when decomposition will actually use them.
          // For single-specialist handoffs (which skip decomposition), these messages are
          // loaded from the DB and attached to the brief but never appear in any prompt — pure waste.
          // Saves DB I/O + ~5,700 tokens of unused data loading for single-specialist handoffs.
          if (brief.specialists.length > 1) {
            try {
              const allMessages = messageRepository.findByConversation(conversationId)
              brief.recentMessages = allMessages
                .slice(-10) // Last 10 messages (5 user + 5 assistant turns)
                .map((m) => ({ role: m.role, content: m.contentMd.substring(0, 2000) }))
              log.info(`Enriched handoff with ${brief.recentMessages.length} recent messages`)
            } catch (error) {
              log.warn('Failed to enrich handoff with recent messages:', error)
            }
          } else {
            log.info(
              '[PIPELINE:skip-recent-messages] Single-specialist handoff — skipping recentMessages enrichment (Strategy F)'
            )
          }

          // Send visual handoff indicator to the renderer
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
            conversationId,
            summary: brief.summary,
            specialists: brief.specialists,
            mode: brief.mode
          })
          log.info(`[PIPELINE:handoff-sent-to-renderer] conversationId=${conversationId}`)

          // Switch streaming identity to generalist during decomposition
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: '',
            role: 'generalist'
          })

          // Emit generalist confirmation — "Delegating to .NET Architect for review."
          const specialistNames = brief.specialists
            .map((id) => {
              const spec = specialistRepository.findByAgentId(id)
              return spec?.displayName ?? id
            })
            .join(', ')
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: `Delegating to **${specialistNames}** for ${brief.mode === 'plan' ? 'review' : 'implementation'}.\n\n`,
            role: 'generalist'
          })

          // Detect task intent from the handoff summary.
          // Investigation/review requests should always show the plan card for user review,
          // even when the conversation is in build mode. Implementation requests in build mode
          // auto-execute. The generalist prompt always sets mode="plan" in handoffs, so we
          // use keyword detection to distinguish investigation from implementation intent.
          const conversation = conversationRepository.findById(conversationId)
          const isInvestigation = isInvestigationIntent(brief.summary)
          const effectiveMode: ConversationMode =
            conversation?.mode === 'build' && !isInvestigation ? 'build' : 'plan'
          if (effectiveMode !== brief.mode) {
            log.info(
              `[PIPELINE:mode-resolve] effectiveMode=${effectiveMode} (conversation=${conversation?.mode}, investigation=${isInvestigation}, brief=${brief.mode})`
            )
            brief.mode = effectiveMode
          }
          try {
            conversationRepository.updateMode(conversationId, effectiveMode)
          } catch (error) {
            log.error('Failed to update conversation mode:', error)
          }

          // Strategy E: Unified decomposition — always route through generalist.decompose()
          // which has cost-preference-aware model selection via enrichTasksWithComplexity().
          // Previously, single-specialist handoffs were dispatched directly here with hardcoded
          // 'sonnet' model, bypassing economy-mode haiku selection (6× token overhead bug).
          // The decompose() method already has a fast path for single-specialist handoffs
          // that skips the LLM call — so this consolidation costs nothing extra.
          try {
            log.info(`[PIPELINE:decompose-starting] specialists=${brief.specialists.join(',')}`)
            const taskPlan = await generalistService.decompose(brief, conversationId, brief.mode)

            log.info(`[PIPELINE:decompose-complete] taskCount=${taskPlan.tasks.length}`)

            // Send the task plan to the renderer — auto-execute in build mode
            if (taskPlan.mode === 'build') {
              mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, {
                ...taskPlan,
                autoExecute: 'sequential' as ExecutionStrategy
              })
            } else {
              mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)
            }
            log.info(`[PIPELINE:task-plan-sent-to-renderer] taskCount=${taskPlan.tasks.length} autoExecute=${taskPlan.mode === 'build'}`)
          } catch (error) {
            log.error('Task decomposition failed:', error)
            eventLoggerService.logDecompositionFailed({
              conversationId,
              error: (error as Error).message,
              fallback: 'none'
            })
            // Surface error directly to user — no generalist fallback
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
              conversationId,
              chunk: `\n\n**Error:** Task decomposition failed. ${(error as Error).message}`,
              role: 'generalist'
            })
            const savedMsg = messageRepository.create(
              conversationId,
              'generalist',
              `**Error:** Task decomposition failed.\n\n${(error as Error).message}`
            )
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
              conversationId,
              messageId: savedMsg.id
            })
          }

          // Clean up handoff listener (one-shot)
          generalistService.removeListener('handoff', onHandoff)
        }

        handoffPromise = doHandoff()
        await handoffPromise
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
        await generalistService.send(
          fullContent,
          conversationId,
          imageAttachments.length > 0 ? imageAttachments : undefined
        )
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

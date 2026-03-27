import { ipcMain, app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import simpleGit from 'simple-git'
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
  fileService,
  gitWorktreeService
} from '../services'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import type { HandoffEvent } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  TaskExecutionProgress
} from '../../shared/types'
import { brainService } from '../services/brain.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Eliminates duplicated chunk-handling logic between generalist and orchestrator paths.
 */
function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'generalist' | 'coordinator',
  chunk: StreamChunk,
  contentAccumulator: { value: string }
): void {
  if (chunk.type === 'text' && chunk.content) {
    contentAccumulator.value += chunk.content
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: chunk.content,
      role
    })
  } else if (chunk.type === 'tool_use') {
    // Track file changes for Write/Edit tools
    if ((chunk.toolName === 'Write' || chunk.toolName === 'Edit') && chunk.toolInput) {
      try {
        fileChangeRepository.track(
          conversationId,
          chunk.toolInput,
          chunk.toolName === 'Write' ? 'created' : 'modified'
        )
      } catch (e) {
        log.warn('Failed to track file change:', e)
      }
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      toolActivity: {
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: 'running',
        input: chunk.toolInput,
        startedAt: Date.now()
      }
    })
  } else if (chunk.type === 'tool_result') {
    let toolInputSummary: string | undefined
    if (chunk.content) {
      try {
        const parsed = JSON.parse(chunk.content) as Record<string, unknown>
        toolInputSummary = summarizeToolInput(chunk.toolName ?? '', parsed)
      } catch {
        toolInputSummary = chunk.content.slice(0, 120)
      }
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      toolActivity: {
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: 'completed',
        input: toolInputSummary,
        completedAt: Date.now()
      }
    })
  } else if (chunk.type === 'error') {
    contentAccumulator.value += `\n\n**Error:** ${chunk.error}`
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n**Error:** ${chunk.error}`,
      role
    })
  }
}

/** Check if brain writes are enabled for the given workspace path */
function isBrainEnabled(workspacePath: string): boolean {
  const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
  if (!workspace) return true // default enabled
  try {
    const settings = JSON.parse(workspace.settingsJson || '{}')
    return settings.brainEnabled !== false
  } catch {
    return true
  }
}

export function registerChatIpc(mainWindow: BrowserWindow): void {
  // Persistent listener: forward compact suggestions to the renderer
  generalistService.on('compactNeeded', (data: { level: string; inputTokens: number }) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId: generalistService.getCurrentConversationId() || '',
      chunk: '',
      role: 'generalist',
      compactNeeded: data
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

        // Decompose the task into sub-tasks via orchestrator
        try {
          log.info('Decomposing task for specialists:', handoff.specialists)
          const taskPlan = await orchestratorService.decompose(
            handoff.summary,
            handoff.specialists,
            conversationId,
            handoff.mode
          )

          log.info(`Task decomposed into ${taskPlan.tasks.length} sub-tasks`)

          // Send the task plan to the renderer for user choice (sequential vs parallel)
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)
        } catch (error) {
          log.error('Task decomposition failed, falling back to single orchestrator:', error)

          // Fallback: run orchestrator in legacy single-process mode
          await runLegacyOrchestrator(mainWindow, conversationId, handoff)
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

      const { conversationId } = args

      // Same cleanup as /close — stop agents and clear all data
      if (orchestratorService.isRunning()) {
        await orchestratorService.stop()
      }
      orchestratorService.clearSession(conversationId)
      generalistService.clearSession(conversationId)

      conversationRepository.delete(conversationId)
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

  // ── Execute task plan (user chose sequential or parallel) ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_EXECUTE_PLAN,
    async (
      event,
      args: { conversationId: string; strategy: ExecutionStrategy; tasks: DecomposedTask[] }
    ) => {
      validateSender(event)

      const { conversationId, strategy, tasks } = args
      log.info(
        `Executing plan: strategy=${strategy}, tasks=${tasks.length}, conversation=${conversationId}`
      )

      // Determine mode from conversation
      const conversation = conversationRepository.findById(conversationId)
      const mode: ConversationMode = (conversation?.mode as ConversationMode) ?? 'build'

      // Set workspace path on the pool service
      const workspacePath = generalistService.getWorkspacePath()
      if (!workspacePath) {
        throw new Error('No workspace path — generalist not started')
      }
      specialistPoolService.setWorkspacePath(workspacePath)
      specialistPoolService.setConversationId(conversationId)

      // Forward task progress events to the renderer
      const onTaskProgress = (progress: TaskExecutionProgress): void => {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PROGRESS, progress)

        // Emit agent status updates so the AgentMonitor panel tracks each specialist
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, {
          agentId: `${progress.specialist}-${progress.taskId}`,
          agentType: progress.specialist,
          status:
            progress.status === 'running'
              ? 'writing'
              : progress.status === 'completed'
                ? 'completed'
                : progress.status === 'failed'
                  ? 'failed'
                  : 'idle',
          currentTask: tasks.find((t) => t.id === progress.taskId)?.description,
          elapsedMs: 0,
          tokenUsage: 0,
          model: progress.model,
          complexityTier: progress.complexityTier
        })
      }

      // Forward streaming chunks from each specialist to the chat AND agent monitor
      const onTaskChunk = (data: { taskId: string; specialist: string; chunk: string }): void => {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: data.chunk,
          role: 'coordinator'
        })

        // Also send to agent monitor for live output display
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_CHUNK, {
          agentId: data.specialist,
          taskId: data.taskId,
          text: data.chunk
        })
      }

      const onAllComplete = (): void => {
        log.info('All specialist tasks completed')

        // Save a summary message
        const summaryLines = tasks
          .map((t) => `- **${t.specialist}** (${t.id}): ${t.description}`)
          .join('\n')
        const summaryContent = `## Task Execution Complete (${strategy})\n\n${summaryLines}`
        const savedMsg = messageRepository.create(conversationId, 'coordinator', summaryContent)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })

        // Log task execution to brain
        try {
          const wpPath = generalistService.getWorkspacePath()
          if (wpPath && isBrainEnabled(wpPath)) {
            brainService.logCompletion(wpPath, {
              timestamp: new Date().toISOString(),
              conversationId,
              conversationTitle: 'Task Execution',
              type: 'completion',
              summary: `Executed ${tasks.length} tasks (${strategy})`,
              details: tasks.map((t) => `- ${t.specialist}: ${t.description}`).join('\n')
            })
          }
        } catch (e) {
          log.warn('Brain update on task complete failed:', e)
        }

        // Clean up
        specialistPoolService.removeListener('taskProgress', onTaskProgress)
        specialistPoolService.removeListener('taskChunk', onTaskChunk)
        specialistPoolService.removeListener('taskRetry', onTaskRetry)
        specialistPoolService.removeListener('allComplete', onAllComplete)
      }

      // Forward retry events to renderer
      const onTaskRetry = (data: {
        taskId: string
        specialist: string
        attempt: number
        maxRetries: number
      }): void => {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_RETRY, data)
        // Also send as a chat chunk so the user sees the retry notification
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: `\n> **${data.specialist}** failed — retrying (attempt ${data.attempt + 1}/${data.maxRetries + 1})...\n\n`,
          role: 'coordinator'
        })
      }

      specialistPoolService.on('taskProgress', onTaskProgress)
      specialistPoolService.on('taskChunk', onTaskChunk)
      specialistPoolService.on('taskRetry', onTaskRetry)
      specialistPoolService.on('allComplete', onAllComplete)

      try {
        if (strategy === 'parallel') {
          await specialistPoolService.executeParallel(tasks, mode)
        } else {
          await specialistPoolService.executeSequential(tasks, mode)
        }
      } catch (error) {
        log.error('Plan execution failed:', error)
        const errorMsg = `**Execution Error:** ${(error as Error).message}`
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
    }
  )

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

      // Restart generalist CLI session with the new permission mode
      if (generalistService.getMode() !== args.mode) {
        log.info(`Mode changed to "${args.mode}" — restarting generalist session`)
        await generalistService.switchMode(args.mode)
      }

      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME,
    async (event, args: { conversationId: string; title: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
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

  // ── Get file changes tracked for a conversation ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_FILE_CHANGES,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Invalid conversation ID')
      return fileChangeRepository.findByConversation(args.conversationId)
    }
  )

  // ── /close: delete conversation and all associated data ──
  ipcMain.handle(IPC_CHANNELS.CHAT_CLOSE, async (event, args: { conversationId: string }) => {
    validateSender(event)
    if (!args?.conversationId) throw new Error('Invalid conversation ID')

    const { conversationId } = args

    // Stop running agents for this conversation
    if (orchestratorService.isRunning()) {
      await orchestratorService.stop()
    }
    orchestratorService.clearSession(conversationId)
    generalistService.clearSession(conversationId)

    // Clean up worktrees for this conversation
    const workspacePath = generalistService.getWorkspacePath()
    if (workspacePath) {
      try {
        await gitWorktreeService.pruneAll(workspacePath)
      } catch (error) {
        log.warn('Failed to prune worktrees on close:', error)
      }
    }

    // Summarize and log to brain before deletion
    try {
      if (workspacePath && isBrainEnabled(workspacePath)) {
        const conversation = conversationRepository.findById(conversationId)
        if (conversation) {
          brainService.logCompletion(workspacePath, {
            timestamp: new Date().toISOString(),
            conversationId,
            conversationTitle: conversation.title,
            type: 'context',
            summary: brainService.summarizeConversation(conversationId)
          })
        }
      }
    } catch (e) {
      log.warn('Brain update failed on /close:', e)
    }

    // Delete conversation (cascades: file_changes, messages, attachments, agent_worktrees)
    conversationRepository.delete(conversationId)
  })

  // ── /complete: commit changes, push, and clean up ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPLETE,
    async (event, args: { conversationId: string; commitMessage: string; description: string }) => {
      validateSender(event)

      const { conversationId, commitMessage, description } = args
      if (!conversationId || !commitMessage) throw new Error('Missing required fields')

      // 1. Resolve workspace path
      const conversation = conversationRepository.findById(conversationId)
      if (!conversation) throw new Error('Conversation not found')
      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const git = simpleGit(workspace.repoPath)

      // 1b. Merge any remaining active worktrees before committing
      try {
        const mergeResult = await gitWorktreeService.mergeAll(conversationId)
        if (mergeResult.conflicted) {
          log.warn(
            `Merge conflict during /complete for agent ${mergeResult.conflicted.agentId}:`,
            mergeResult.conflicted.files
          )
          throw new Error(
            `Merge conflict from agent "${mergeResult.conflicted.agentId}" on files: ${mergeResult.conflicted.files.join(', ')}. Resolve conflicts before completing.`
          )
        }
        if (mergeResult.merged.length > 0) {
          log.info(`Merged ${mergeResult.merged.length} worktrees during /complete`)
        }
      } catch (error) {
        if ((error as Error).message.includes('Merge conflict')) {
          throw error
        }
        log.warn('Worktree merge during /complete encountered an issue:', error)
      }

      // 2. Get tracked file changes for this conversation
      const fileChanges = fileChangeRepository.findByConversation(conversationId)
      if (fileChanges.length === 0) throw new Error('No file changes tracked for this conversation')

      // 3. Create feature branch from current HEAD
      const branchName = `chat/${conversation.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)}-${conversationId.slice(0, 8)}`

      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
      await git.checkoutLocalBranch(branchName)

      try {
        // 4. Stage only tracked files (filter to files that actually exist in git status)
        const status = await git.status()
        const changedPaths = new Set([
          ...status.modified,
          ...status.created,
          ...status.not_added,
          ...status.deleted,
          ...status.renamed.map((r) => r.to)
        ])

        const filesToStage = fileChanges
          .map((fc) => fc.filePath)
          .filter((fp) => changedPaths.has(fp))

        if (filesToStage.length === 0) {
          // All tracked files are already committed or reverted — nothing to stage
          await git.checkout(currentBranch)
          await git.deleteLocalBranch(branchName, true)
          throw new Error('No uncommitted changes found for tracked files')
        }

        await git.add(filesToStage)

        // 5. Commit with message + description
        const fullMessage = description ? `${commitMessage}\n\n${description}` : commitMessage
        await git.commit(fullMessage)

        const commitHash = await git.revparse(['HEAD'])

        // 6. Push if remote exists
        let prUrl: string | undefined
        try {
          const remotes = await git.getRemotes(true)
          if (remotes.length > 0) {
            await git.push('origin', branchName, ['--set-upstream'])
          }
        } catch (e) {
          log.warn('Push failed (no remote or auth issue):', e)
          // Local commit still succeeded — that's fine
        }

        // Update brain with completed work
        try {
          if (isBrainEnabled(workspace.repoPath)) {
            brainService.logCompletion(workspace.repoPath, {
              timestamp: new Date().toISOString(),
              conversationId,
              conversationTitle: conversation.title,
              type: 'completion',
              summary: commitMessage,
              details: `Branch: ${branchName}\nCommit: ${commitHash}\nFiles: ${filesToStage.join(', ')}`
            })
          }
        } catch (e) {
          log.warn('Brain update failed on /complete:', e)
        }

        // 7. Cleanup: stop agents, clear DB data, delete conversation
        if (orchestratorService.isRunning()) {
          await orchestratorService.stop()
        }
        orchestratorService.clearSession(conversationId)
        generalistService.clearSession(conversationId)
        fileChangeRepository.clearByConversation(conversationId)
        conversationRepository.delete(conversationId)

        return { branch: branchName, commitHash, prUrl }
      } catch (error) {
        // On failure, switch back to original branch and clean up
        try {
          await git.checkout(currentBranch)
          await git.deleteLocalBranch(branchName, true)
        } catch {
          /* best effort */
        }
        throw error
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE, async (event, args: { dataUrl: string }) => {
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
    const tempDir = join(app.getPath('userData'), 'clipboard-images')
    mkdirSync(tempDir, { recursive: true })

    const filename = `clipboard-${Date.now()}.${ext}`
    const filePath = join(tempDir, filename)
    writeFileSync(filePath, buffer)

    return filePath
  })
}

/**
 * Fallback: runs the orchestrator in single-process mode (legacy behavior)
 * when task decomposition fails.
 */
async function runLegacyOrchestrator(
  mainWindow: BrowserWindow,
  conversationId: string,
  handoff: HandoffEvent
): Promise<void> {
  const orchestratorContent = { value: '' }

  const onOrchestratorChunk = (chunk: StreamChunk): void => {
    forwardChunkToRenderer(mainWindow, conversationId, 'coordinator', chunk, orchestratorContent)
  }

  const onOrchestratorComplete = (): void => {
    const savedMsg = messageRepository.create(
      conversationId,
      'coordinator',
      orchestratorContent.value || '_No response received from orchestrator._'
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
}

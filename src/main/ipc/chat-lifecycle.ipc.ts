import { ipcMain, app, type BrowserWindow } from 'electron'
import { join, resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import simpleGit from 'simple-git'
import {
  conversationRepository,
  conversationSpecialistRepository,
  messageRepository,
  fileChangeRepository,
  workspaceRepository,
  turnUsageRepository
} from '../db/repositories'
import {
  generalistService,
  gitWorktreeService,
  fileService
} from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import { githubService } from '../services/github.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = chatIpcLogger

export function registerChatLifecycleIpc(mainWindow: BrowserWindow): void {
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

      const conversation = conversationRepository.create(args.workspaceId, args.title, args.mode)
      conversationSpecialistRepository.initFromWorkspaceDefaults(conversation.id)
      return conversation
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
      generalistService.clearSession(conversationId)

      conversationRepository.delete(conversationId)
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

      // Mode is persisted to DB — CLI restart is deferred until next message send
      log.info(`Mode updated to "${args.mode}" in DB (CLI restart deferred until next send)`)

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

    // Clean up branches (local + remote if PR was merged)
    try {
      const conv = conversationRepository.findById(conversationId)
      if (conv?.branchName && workspacePath) {
        const git = simpleGit(workspacePath)
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === workspacePath)

        // Delete remote branch if PR was merged/closed
        if (conv.prNumber && ws && githubService.isConfigured(ws.id)) {
          try {
            const status = await githubService.getPullRequestStatus(
              ws.id,
              workspacePath,
              conv.prNumber
            )
            if (status === 'merged' || status === 'closed') {
              await githubService.deleteRemoteBranch(ws.id, workspacePath, conv.branchName)
            }
          } catch (e) {
            log.warn('Remote branch cleanup failed:', e)
          }
        }

        // Always clean up local branch
        try {
          await git.deleteLocalBranch(conv.branchName, true)
        } catch {
          /* branch may already be deleted */
        }
      }
    } catch (e) {
      log.warn('Branch cleanup failed:', e)
    }

    // Delete conversation (cascades: file_changes, messages, attachments, agent_worktrees)
    conversationRepository.delete(conversationId)
  })

  // ── /complete: commit changes, push, create PR, and clean up ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPLETE,
    async (
      event,
      args: {
        conversationId: string
        branchName: string
        commitMessage: string
        description: string
      }
    ) => {
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

      // 3. Create feature branch — use user-provided name or auto-generate
      const branchName =
        args.branchName ||
        `chat/${conversation.title
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

        // 7. Auto-create PR if GitHub is configured
        if (githubService.isConfigured(workspace.id)) {
          try {
            const prResult = await githubService.createPullRequest({
              workspaceId: workspace.id,
              repoPath: workspace.repoPath,
              head: branchName,
              base: currentBranch,
              title: commitMessage,
              body: description
            })
            prUrl = prResult.prUrl
            conversationRepository.updatePrInfo(
              conversationId,
              prResult.prUrl,
              prResult.prNumber,
              branchName
            )
          } catch (e) {
            log.warn('GitHub PR creation failed (push succeeded):', e)
          }
        }

        // 8. Cleanup: stop agents, clear DB data, delete conversation
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

  ipcMain.handle(
    IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE,
    async (event, args: { dataUrl: string; conversationId: string }) => {
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

      // Save to conversation-scoped directory
      const imageDir = join(
        app.getPath('userData'),
        'chat-images',
        args.conversationId || 'unsorted'
      )
      mkdirSync(imageDir, { recursive: true })

      const filename = `clipboard-${Date.now()}.${ext}`
      const filePath = join(imageDir, filename)
      writeFileSync(filePath, buffer)

      return filePath
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.READ_IMAGE_BASE64,
    async (event, args: { filePath: string }) => {
      validateSender(event)

      if (!args?.filePath || typeof args.filePath !== 'string') {
        throw new Error('Invalid file path')
      }

      // Security: only allow reading from chat-images directory
      const chatImagesDir = join(app.getPath('userData'), 'chat-images')
      const resolved = resolve(args.filePath)
      if (!resolved.startsWith(chatImagesDir)) {
        throw new Error('Access denied: file is outside chat-images directory')
      }

      const { base64, mimeType } = fileService.readImageAsBase64(resolved)
      return `data:${mimeType};base64,${base64}`
    }
  )

  // ── Context usage: return token consumption for a conversation ──
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Invalid conversation ID')

      const lastTurn = turnUsageRepository.getLastTurn(args.conversationId)
      const inputTokens = lastTurn?.inputTokens ?? 0
      const contextWindowSize = 200_000
      const percentage = Math.round((inputTokens / contextWindowSize) * 100)
      const level =
        percentage > 50 ? 'critical' : percentage > 40 ? 'red' : percentage > 25 ? 'yellow' : 'green'

      return {
        conversationId: args.conversationId,
        inputTokens,
        contextWindowSize,
        percentage,
        level
      }
    }
  )

  // ── Reorder conversations ──
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_REORDER,
    async (event, args: { orderedIds: string[] }) => {
      validateSender(event)
      if (!args?.orderedIds || !Array.isArray(args.orderedIds)) {
        throw new Error('Invalid orderedIds')
      }
      conversationRepository.reorderConversations(args.orderedIds)
    }
  )
}

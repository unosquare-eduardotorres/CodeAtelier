import { ipcMain, app } from 'electron'
import { join, resolve } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import simpleGit from 'simple-git'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { chatAgentService, fileService } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import { githubService } from '../services/github.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Completion & Images — close, complete, clipboard images, image reading
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerChatCompletionIpc(): void {
  // ── /close: delete conversation and all associated data ──
  ipcMain.handle(IPC_CHANNELS.CHAT_CLOSE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const closeArgs = requireObject(rawArgs, IPC_CHANNELS.CHAT_CLOSE)
    const conversationId = requireString(closeArgs, 'conversationId', IPC_CHANNELS.CHAT_CLOSE)

    // Stop running agents for this conversation
    chatAgentService.clearSession(conversationId)

    // Clean up branches (local + remote if PR was merged)
    const workspacePath = chatAgentService.getWorkspacePath()
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

    // Clean up clipboard images for this conversation
    try {
      const imageDir = join(app.getPath('userData'), 'chat-images', conversationId)
      rmSync(imageDir, { recursive: true, force: true })
    } catch {
      /* best effort — directory may not exist */
    }
  })

  // ── /complete: commit changes, push, create PR, and clean up ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPLETE,
    async (event, rawArgs: unknown) => {
      validateSender(event)

      const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_COMPLETE)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_COMPLETE)
      const commitMessage = requireString(args, 'commitMessage', IPC_CHANNELS.CHAT_COMPLETE)
      const description = optionalString(args, 'description', IPC_CHANNELS.CHAT_COMPLETE) ?? ''
      const branchNameArg = optionalString(args, 'branchName', IPC_CHANNELS.CHAT_COMPLETE)

      // 1. Resolve workspace path
      const conversation = conversationRepository.findById(conversationId)
      if (!conversation) throw new Error('Conversation not found')
      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const git = simpleGit(workspace.repoPath)

      // Post-migration-66: no worktrees to merge (specialist-pool deleted).
      // Direct git flow commits against the workspace repo.
      try {
        log.debug(`No worktrees to merge for conversation ${conversationId}`)
      } catch (error) {
        if ((error as Error).message.includes('Merge conflict')) {
          throw error
        }
        log.warn('Worktree merge during /complete encountered an issue:', error)
      }

      // 2. Get ALL uncommitted files from git status
      const status = await git.status()
      const changedPaths = [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...status.renamed.map((r) => r.to)
      ]
      if (changedPaths.length === 0) throw new Error('No uncommitted changes in workspace')

      // 3. Create feature branch — use user-provided name or auto-generate
      const branchName =
        branchNameArg ||
        `chat/${conversation.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 50)}-${conversationId.slice(0, 8)}`

      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
      await git.checkoutLocalBranch(branchName)

      try {
        // 4. Stage all uncommitted files
        await git.add(changedPaths)

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

        // 8. Cleanup: stop agents, delete conversation
        chatAgentService.clearSession(conversationId)
        conversationRepository.delete(conversationId)

        // Clean up clipboard images for this conversation
        try {
          const imageDir = join(app.getPath('userData'), 'chat-images', conversationId)
          rmSync(imageDir, { recursive: true, force: true })
        } catch {
          /* best effort — directory may not exist */
        }

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
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)
      const dataUrl = requireString(args, 'dataUrl', IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)
      const conversationId = optionalString(args, 'conversationId', IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)

      // Extract base64 data from data URL
      const matches = dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/)
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
        conversationId || 'unsorted'
      )
      mkdirSync(imageDir, { recursive: true })

      const filename = `clipboard-${Date.now()}.${ext}`
      const filePath = join(imageDir, filename)
      writeFileSync(filePath, buffer)

      return filePath
    }
  )

  ipcMain.handle(IPC_CHANNELS.READ_IMAGE_BASE64, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.READ_IMAGE_BASE64)
    const filePath = requireString(args, 'filePath', IPC_CHANNELS.READ_IMAGE_BASE64)

    // Security: only allow reading from chat-images directory
    const chatImagesDir = join(app.getPath('userData'), 'chat-images')
    const resolved = resolve(filePath)
    if (!resolved.startsWith(chatImagesDir)) {
      throw new Error('Access denied: file is outside chat-images directory')
    }

    const { base64, mimeType } = fileService.readImageAsBase64(resolved)
    return `data:${mimeType};base64,${base64}`
  })
}

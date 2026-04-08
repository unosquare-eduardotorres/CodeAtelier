import { spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { repoService } from '../services/repo.service'
import { githubService } from '../services/github.service'
import {
  workspaceRepository,
  fileChangeRepository,
  conversationRepository,
  messageRepository
} from '../db/repositories'
import { validateSender } from './validate-sender'

const logger = log.scope('CodeChangesIpc')

/** Build env with PATH so spawned processes can find `claude` CLI */
function buildEnvWithPath(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/opt/homebrew/bin`
  }
}

/** Resolve workspace repoPath from conversationId */
function resolveRepoPath(conversationId: string): { repoPath: string; workspaceId: string } {
  const conversation = conversationRepository.findById(conversationId)
  if (!conversation) throw new Error('Conversation not found')

  const workspace = workspaceRepository.findById(conversation.workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  return { repoPath: workspace.repoPath, workspaceId: workspace.id }
}

export function registerCodeChangesIpc(): void {
  // Get detailed file status for uncommitted changes
  ipcMain.handle(
    IPC_CHANNELS.REPO_GET_FILE_DETAILS,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')

      const { repoPath } = resolveRepoPath(args.conversationId)
      const fileChanges = fileChangeRepository.findByConversation(args.conversationId)
      const trackedFiles = fileChanges.map((fc) => fc.filePath)

      return repoService.getUncommittedFileDetails(repoPath, trackedFiles)
    }
  )

  // Get old/new content for side-by-side diff
  ipcMain.handle(
    IPC_CHANNELS.REPO_GET_FILE_DIFF,
    async (event, args: { conversationId: string; filePath: string }) => {
      validateSender(event)
      if (!args?.conversationId || !args?.filePath) {
        throw new Error('Missing conversationId or filePath')
      }

      const { repoPath } = resolveRepoPath(args.conversationId)
      return repoService.getFileDiff(repoPath, args.filePath)
    }
  )

  // Stage specific files and commit
  ipcMain.handle(
    IPC_CHANNELS.REPO_COMMIT_FILES,
    async (event, args: { conversationId: string; filePaths: string[]; message: string }) => {
      validateSender(event)
      if (!args?.conversationId || !args?.filePaths?.length || !args?.message) {
        throw new Error('Missing conversationId, filePaths, or message')
      }

      const { repoPath } = resolveRepoPath(args.conversationId)
      const result = await repoService.commitFiles(repoPath, args.filePaths, args.message)

      // Remove committed files from the tracked file changes in DB
      const remaining = fileChangeRepository.findByConversation(args.conversationId)
      const committedSet = new Set(args.filePaths)
      for (const fc of remaining) {
        if (committedSet.has(fc.filePath)) {
          // We don't have a single-file delete, so we track and re-insert the rest
          // Actually, the simplest approach: clear committed files from the set
        }
      }

      // Clear committed files from DB — re-insert only the ones NOT committed
      const allTracked = fileChangeRepository.findByConversation(args.conversationId)
      fileChangeRepository.clearByConversation(args.conversationId)
      for (const fc of allTracked) {
        if (!committedSet.has(fc.filePath)) {
          fileChangeRepository.track(args.conversationId, fc.filePath, fc.changeType)
        }
      }

      return result
    }
  )

  // Push current branch to origin
  ipcMain.handle(IPC_CHANNELS.REPO_PUSH, async (event, args: { conversationId: string }) => {
    validateSender(event)
    if (!args?.conversationId) throw new Error('Missing conversationId')

    const { repoPath } = resolveRepoPath(args.conversationId)
    return repoService.push(repoPath)
  })

  // Get push status (commits ahead, branch, hasRemote)
  ipcMain.handle(
    IPC_CHANNELS.REPO_GET_PUSH_STATUS,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')

      const { repoPath } = resolveRepoPath(args.conversationId)
      return repoService.getPushStatus(repoPath)
    }
  )

  // Generate commit message from conversation context + changed files
  ipcMain.handle(
    IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE,
    async (event, args: { conversationId: string; filePaths: string[] }) => {
      validateSender(event)
      if (!args?.conversationId || !args?.filePaths?.length) {
        throw new Error('Missing conversationId or filePaths')
      }

      const messages = messageRepository.findByConversation(args.conversationId)
      const fileChanges = fileChangeRepository.findByConversation(args.conversationId)
      const selectedFiles = fileChanges.filter((fc) => args.filePaths.includes(fc.filePath))

      const prompt = `You are generating a concise git commit message. Follow conventional commit style.

Based on this conversation context and file changes, generate a single-line commit message (max 72 chars) followed by optionally a blank line and a body (max 3 lines).

## Recent conversation (last ${Math.min(messages.length, 10)} messages):
${messages
  .slice(-10)
  .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 300)}`)
  .join('\n')}

## Files to commit (${selectedFiles.length}):
${selectedFiles.map((fc) => `- ${fc.changeType}: ${fc.filePath}`).join('\n')}

Respond with ONLY the commit message, no preamble or explanation.`

      try {
        const env = buildEnvWithPath()
        const result = await new Promise<string>((resolve, reject) => {
          const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env
          })

          let stdout = ''
          child.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString()
          })

          let stderr = ''
          child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString()
          })

          child.on('close', (code) => {
            if (code === 0) {
              resolve(stdout.trim())
            } else {
              reject(new Error(`claude exited with code ${code}: ${stderr}`))
            }
          })

          child.on('error', reject)

          // Timeout after 30 seconds
          setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error('Commit message generation timed out'))
          }, 30_000)
        })

        return { message: result }
      } catch (e) {
        logger.warn('AI commit message generation failed, falling back to simple message:', e)
        // Fallback: generate a simple message from file paths
        const fileNames = selectedFiles.map((fc) => fc.filePath.split('/').pop()).join(', ')
        return {
          message:
            `update ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}: ${fileNames}`.slice(
              0,
              72
            )
        }
      }
    }
  )

  // Create a pull request via GitHub API
  ipcMain.handle(
    IPC_CHANNELS.REPO_CREATE_PR,
    async (
      event,
      args: {
        conversationId: string
        title: string
        body: string
        base: string
        head: string
      }
    ) => {
      validateSender(event)
      if (!args?.conversationId || !args?.title) {
        throw new Error('Missing conversationId or title')
      }

      const { repoPath, workspaceId } = resolveRepoPath(args.conversationId)

      if (!githubService.isConfigured(workspaceId)) {
        throw new Error(
          'GitHub is not configured for this workspace. Please add a GitHub token in workspace settings.'
        )
      }

      const result = await githubService.createPullRequest({
        workspaceId,
        repoPath,
        head: args.head,
        base: args.base,
        title: args.title,
        body: args.body
      })

      // Store PR info on conversation
      conversationRepository.updatePrInfo(
        args.conversationId,
        result.prUrl,
        result.prNumber,
        args.head
      )

      return { url: result.prUrl, number: result.prNumber }
    }
  )
}

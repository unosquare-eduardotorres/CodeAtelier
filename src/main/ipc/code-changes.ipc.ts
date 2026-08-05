import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { repoService } from '../services/repo.service'
import { githubService } from '../services/github.service'
import { workspaceRepository, conversationRepository, messageRepository } from '../db/repositories'
import { runOneShotClaude } from '../services/one-shot-claude'
import { modelConfigService } from '../services/model-config.service'
import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

const logger = log.scope('CodeChangesIpc')

/** Reject ref strings that look like flags or contain dangerous chars */
function validateRef(ref: string, channel: string): void {
  if (ref === 'WORKING_TREE') return  // Sentinel value is allowed
  if (ref.startsWith('-')) {
    throw new Error(`${channel}: invalid ref — must not start with "-"`)
  }
  if (/[\x00\n\r]/.test(ref)) {
    throw new Error(`${channel}: invalid ref — contains control characters`)
  }
}

/**
 * Enqueue commit-based memory extraction if gated settings allow it.
 * Extracted to keep the REPO_COMMIT_FILES handler below complexity threshold.
 */
async function maybeEnqueueCommitExtraction(
  workspaceId: string,
  repoPath: string,
  headBefore: string | null,
  commitHash: string | undefined
): Promise<void> {
  if (!headBefore || !commitHash) return

  const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
  if (settings.memoryCommitCapture === false) return

  const { memoryExtractionService } = await import('../services/memory-extraction.service')
  memoryExtractionService.enqueueCommitExtraction({
    workspaceId,
    workspacePath: repoPath,
    startSha: headBefore,
    endSha: commitHash
  })
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
  ipcMain.handle(IPC_CHANNELS.REPO_GET_FILE_DETAILS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_FILE_DETAILS)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_GET_FILE_DETAILS)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.getUncommittedFileDetails(repoPath)
  })

  // Get old/new content for side-by-side diff
  ipcMain.handle(IPC_CHANNELS.REPO_GET_FILE_DIFF, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_FILE_DIFF)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_GET_FILE_DIFF)
    const filePath = requireString(args, 'filePath', IPC_CHANNELS.REPO_GET_FILE_DIFF)
    // Rename source — without it the old side is looked up at the new path and the
    // file renders as a 100% addition.
    const oldPath = optionalString(args, 'oldPath', IPC_CHANNELS.REPO_GET_FILE_DIFF)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.getFileDiff(repoPath, filePath, oldPath)
  })

  // Stage specific files and commit
  ipcMain.handle(IPC_CHANNELS.REPO_COMMIT_FILES, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_COMMIT_FILES)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_COMMIT_FILES)
    const message = requireString(args, 'message', IPC_CHANNELS.REPO_COMMIT_FILES)
    const filePaths = args.filePaths as string[]
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error(`${IPC_CHANNELS.REPO_COMMIT_FILES}: filePaths must be a non-empty array`)
    }

    const { repoPath, workspaceId } = resolveRepoPath(conversationId)

    // Capture HEAD before commit for memory extraction
    const headBefore = await repoService.getHeadSha(repoPath).catch(() => null)

    const result = await repoService.commitFiles(repoPath, filePaths, message)

    // G3-FIX: Wire commit extraction, gated by memoryCommitCapture setting
    maybeEnqueueCommitExtraction(workspaceId, repoPath, headBefore, result.commitHash).catch(
      (err) => logger.debug('Commit memory extraction failed (non-fatal):', err)
    )

    return result
  })

  // Push current branch to origin
  ipcMain.handle(IPC_CHANNELS.REPO_PUSH, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_PUSH)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_PUSH)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.push(repoPath)
  })

  // Get push status (commits ahead, branch, hasRemote)
  ipcMain.handle(IPC_CHANNELS.REPO_GET_PUSH_STATUS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_PUSH_STATUS)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_GET_PUSH_STATUS)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.getPushStatus(repoPath)
  })

  // Generate commit message from conversation context + changed files
  ipcMain.handle(IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE)
    const conversationId = requireString(
      args,
      'conversationId',
      IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE
    )
    const filePaths = args.filePaths as string[]
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error(
        `${IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE}: filePaths must be a non-empty array`
      )
    }

    const messages = messageRepository
      .findByConversation(conversationId)
      .filter((m) => !m.hidden)

    const prompt = `You are generating a concise git commit message. Follow conventional commit style.

Based on this conversation context and file changes, generate a single-line commit message (max 72 chars) followed by optionally a blank line and a body (max 3 lines).

## Recent conversation (last ${Math.min(messages.length, 10)} messages):
${messages
  .slice(-10)
  .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 300)}`)
  .join('\n')}

## Files to commit (${filePaths.length}):
${filePaths.map((fp) => `- ${fp}`).join('\n')}

Respond with ONLY the commit message, no preamble or explanation.`

    try {
      let workspaceId: string | null = null
      try {
        workspaceId = resolveRepoPath(conversationId).workspaceId
      } catch {
        /* best-effort attribution */
      }

      // Resolve model from workspace settings (respects user overrides)
      const resolvedModel = workspaceId
        ? modelConfigService.getModelById(workspaceId, 'commit-message')
        : DEFAULT_MODEL_CONFIG['commit-message']

      const { text: result } = await runOneShotClaude({
        feature: 'commit_message',
        model: resolvedModel,
        workspaceId,
        conversationId,
        args: ['-p', prompt, '--model', resolvedModel],
        cli: {
          timeout: 30_000
        }
      })

      return { message: result.trim() }
    } catch (e) {
      logger.warn('AI commit message generation failed, falling back to simple message:', e)
      // Fallback: generate a simple message from file paths
      const fileNames = filePaths.map((fp) => fp.split('/').pop()).join(', ')
      return {
        message:
          `update ${filePaths.length} file${filePaths.length > 1 ? 's' : ''}: ${fileNames}`.slice(
            0,
            72
          )
      }
    }
  })

  // Get files differing between two refs (branch comparison)
  ipcMain.handle(IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)
    const fromRef = requireString(args, 'fromRef', IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)
    const toRef = requireString(args, 'toRef', IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)
    validateRef(fromRef, IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)
    validateRef(toRef, IPC_CHANNELS.REPO_GET_REF_FILE_DETAILS)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.getRefDiffFiles(repoPath, fromRef, toRef)
  })

  // Get file content at two refs for side-by-side diff (branch comparison)
  ipcMain.handle(IPC_CHANNELS.REPO_GET_REF_FILE_DIFF, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    const filePath = requireString(args, 'filePath', IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    const fromRef = requireString(args, 'fromRef', IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    const toRef = requireString(args, 'toRef', IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    // Rename source — a path, not a ref, so repoService validates it with assertWithinRepo.
    const oldPath = optionalString(args, 'oldPath', IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    validateRef(fromRef, IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)
    validateRef(toRef, IPC_CHANNELS.REPO_GET_REF_FILE_DIFF)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.getRefFileDiff(repoPath, filePath, fromRef, toRef, oldPath)
  })

  // Fetch latest refs from origin remote
  ipcMain.handle(IPC_CHANNELS.REPO_FETCH_ORIGIN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_FETCH_ORIGIN)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_FETCH_ORIGIN)

    const { repoPath } = resolveRepoPath(conversationId)
    return repoService.fetchOrigin(repoPath)
  })

  // Create a pull request via GitHub API
  ipcMain.handle(IPC_CHANNELS.REPO_CREATE_PR, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_CREATE_PR)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.REPO_CREATE_PR)
    const title = requireString(args, 'title', IPC_CHANNELS.REPO_CREATE_PR)
    const head = requireString(args, 'head', IPC_CHANNELS.REPO_CREATE_PR)
    const base = requireString(args, 'base', IPC_CHANNELS.REPO_CREATE_PR)
    const body = optionalString(args, 'body', IPC_CHANNELS.REPO_CREATE_PR) ?? ''

    const { repoPath, workspaceId } = resolveRepoPath(conversationId)

    if (!githubService.isConfigured(workspaceId)) {
      throw new Error(
        'GitHub is not configured for this workspace. Please add a GitHub token in workspace settings.'
      )
    }

    const result = await githubService.createPullRequest({
      workspaceId,
      repoPath,
      head,
      base,
      title,
      body
    })

    // Store PR info on conversation
    conversationRepository.updatePrInfo(conversationId, result.prUrl, result.prNumber, head)

    return { url: result.prUrl, number: result.prNumber }
  })
}

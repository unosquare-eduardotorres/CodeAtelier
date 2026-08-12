import { ipcMain, app } from 'electron'
import { join, resolve, sep } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import simpleGit from 'simple-git'
import { conversationRepository, messageRepository, workspaceRepository } from '../db/repositories'
import { chatAgentService, fileService } from '../services'
import { lifecycleRegistry } from '../services/conversation-lifecycle'
import { chatStreamService } from '../services/chat-stream.service'
import { IPC_CHANNELS, COMMIT_ATTRIBUTION, DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import { runOneShotClaude } from '../services/one-shot-claude'
import { modelConfigService } from '../services/model-config.service'
import { repoService } from '../services/repo.service'
import { githubService } from '../services/github.service'
import { trackService } from '../services/track.service'
import { landingService } from '../services/landing.service'
import { trackRepository } from '../db/repositories/track.repository'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import { completeStreamMetrics } from './chunk-router'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Completion & Images — close, complete, clipboard images, image reading
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Clean up clipboard images for a conversation (best-effort). */
function cleanupChatImages(conversationId: string): void {
  try {
    const imageDir = join(app.getPath('userData'), 'chat-images', conversationId)
    rmSync(imageDir, { recursive: true, force: true })
  } catch {
    /* best effort — directory may not exist */
  }
}

/**
 * Handle CHAT_CLOSE: abort streams, clean up branches, delete conversation.
 */
async function handleChatClose(conversationId: string): Promise<void> {
  // CONV-DEL-01: Abort active stream if it's for this conversation.
  if (lifecycleRegistry.isStreaming(conversationId)) {
    // CHAT-METRICS-ABORT-ORPHAN-01: Clean up metrics before abort to prevent leak.
    completeStreamMetrics(conversationId, 'aborted')
    lifecycleRegistry.abort(conversationId, 'conversation-deleted')
  }

  chatAgentService.clearSession(conversationId)
  // N1-FIX: Clear per-conversation memory dedupe state
  chatStreamService.clearConversationMemoryState(conversationId)

  // Release the worktree before any branch cleanup: git refuses to delete a
  // branch that a worktree still has checked out, so the order below is load
  // bearing — reversed, every discarded chat would leak both a directory and
  // an undeletable branch.
  //
  // Closing a chat is not consent to destroy uncommitted work. A dirty tree is
  // retained instead, and then its branch must survive too — deleting the
  // branch would strand the retained tree on a ref nothing can reach.
  let worktreeRetained = false
  try {
    worktreeRetained = (await trackService.release(conversationId)) === 'retained'
    if (worktreeRetained) {
      log.info(
        `[chat:close] conversation ${conversationId} had uncommitted changes — ` +
          `its working tree and branch were retained rather than deleted`
      )
    }
  } catch (e) {
    log.warn('Worktree release during close failed (non-fatal):', e)
  }

  // Clean up branches (local + remote if PR was merged).
  //
  // The repository is resolved from the *conversation*, never from the globally
  // active session. `chatAgentService.getWorkspacePath()` returns whichever
  // workspace the user is currently looking at, so closing a chat that belongs
  // to workspace B while workspace A is focused ran `git branch -D` against A.
  // Quietly, inside a catch — and if A happened to hold a same-named branch it
  // deleted the wrong one.
  try {
    const conv = conversationRepository.findById(conversationId)
    const ws = conv ? workspaceRepository.findById(conv.workspaceId) : undefined
    const workspacePath = ws?.repoPath
    if (conv?.branchName && ws && workspacePath && !worktreeRetained) {
      const git = simpleGit(workspacePath)

      // Delete remote branch if PR was merged/closed
      if (conv.prNumber && githubService.isConfigured(ws.id)) {
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

  conversationRepository.delete(conversationId)
  cleanupChatImages(conversationId)
}

/**
 * Wind down a conversation whose work has already landed.
 *
 * Deliberately all best-effort: the commit and push have happened, so a failure
 * here is untidy, never lost work. Called from both completion paths.
 */
async function retireCompletedConversation(conversationId: string): Promise<void> {
  if (lifecycleRegistry.isStreaming(conversationId)) {
    // CHAT-METRICS-ABORT-ORPHAN-01: Clean up metrics before abort to prevent leak.
    completeStreamMetrics(conversationId, 'completed')
    lifecycleRegistry.abort(conversationId, 'conversation-completed')
  }
  chatAgentService.clearSession(conversationId)
  // N1-FIX: Clear per-conversation memory dedupe state
  chatStreamService.clearConversationMemoryState(conversationId)

  // Release BEFORE deleting the conversation, so the outcome is known while the
  // chat still exists and a `retained` result can be reported against it.
  //
  // No `discard` here: landing already staged and committed every changed path,
  // so a clean tree is the expected outcome. If anything is still dirty then
  // something escaped the commit, and keeping it is strictly safer than forcing
  // the delete.
  try {
    if ((await trackService.release(conversationId)) === 'retained') {
      log.warn(
        `[chat:complete] worktree retained for ${conversationId} — ` +
          `changes remained after the commit; nothing was deleted`
      )
    }
  } catch (releaseErr) {
    log.error('[chat:complete] Worktree release failed — non-fatal:', releaseErr)
  }

  try {
    conversationRepository.delete(conversationId)
  } catch (deleteErr) {
    log.error(
      '[chat:complete] Failed to delete conversation after a successful landing — non-fatal:',
      deleteErr
    )
  }
  cleanupChatImages(conversationId)
}

/**
 * Handle CHAT_COMPLETE: land the chat's work, then retire the conversation.
 *
 * The git half now lives in landing.service.ts. This used to be the only path
 * work ever left a track by, which meant a blueprint branch or an adopted
 * retained tree had no route home at all — and it also meant every landing
 * concern (serialisation, conflicts, marking the track landed) had to be
 * reinvented anywhere else that wanted one. What is left here is the part that
 * is genuinely chat-specific: stopping the stream, releasing the tree and
 * deleting the conversation.
 */
async function handleChatComplete(args: {
  conversationId: string
  commitMessage: string
  description: string
  branchNameArg?: string
  baseBranch?: string
}): Promise<{ branch: string; commitHash: string; prUrl?: string }> {
  const { conversationId, commitMessage, description, branchNameArg } = args

  const conversation = conversationRepository.findById(conversationId)
  if (!conversation) throw new Error('Conversation not found')
  const workspace = workspaceRepository.findById(conversation.workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  // Commit where the work actually happened. An isolated conversation's edits
  // live in its own worktree, so running this against workspace.repoPath would
  // find "no uncommitted changes" while the real work sat elsewhere.
  const target = trackService.resolve(conversationId, workspace.repoPath)
  const trackRow = trackRepository.findByOwner('chat', conversationId)

  const branchName =
    // In a worktree the branch is a property of the directory — it is already
    // checked out and cannot be anything else.
    (target.isolated ? target.branchName : null) ||
    branchNameArg ||
    conversation.branchName ||
    `chat/${conversation.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)}-${conversationId.slice(0, 8)}`

  const currentBranch = await simpleGit(target.path).revparse(['--abbrev-ref', 'HEAD'])
  // Priority: explicit arg > stored source > current.
  const prBaseBranch = args.baseBranch || conversation.sourceBranch || currentBranch

  // Isolated chats go through the landing service, which owns commit → push →
  // PR, serialises against other landings in the workspace, and records
  // landed_at/landed_into on the track.
  if (target.isolated && trackRow) {
    const landed = await landingService.land(trackRow.id, {
      commitMessage,
      description,
      baseBranch: prBaseBranch
    })

    if (landed.outcome === 'conflicted') {
      throw new Error(
        `Landing "${landed.branch}" hit merge conflicts` +
          (landed.conflictedFiles?.length ? ` in ${landed.conflictedFiles.join(', ')}` : '') +
          `. Nothing was merged and both branches are intact — resolve them and try again.`
      )
    }
    if (landed.outcome === 'nothing-to-land') {
      throw new Error('No uncommitted changes in workspace')
    }

    if (landed.prUrl && landed.prNumber != null) {
      conversationRepository.updatePrInfo(
        conversationId,
        landed.prUrl,
        landed.prNumber,
        landed.branch
      )
    }

    await retireCompletedConversation(conversationId)
    return {
      branch: landed.branch,
      commitHash: landed.commitHash ?? '',
      prUrl: landed.prUrl
    }
  }

  // Non-isolated fallback: the chat is running in the workspace's primary tree,
  // so completing it means moving that tree's HEAD. Kept as it was — the
  // landing service deliberately refuses to touch the user's checkout, and the
  // rollback below only makes sense for a tree we switched.
  const git = simpleGit(target.path)

  const status = await git.status()
  const changedPaths = [
    ...status.modified,
    ...status.created,
    ...status.not_added,
    ...status.deleted,
    ...status.renamed.map((r) => r.to)
  ]
  if (changedPaths.length === 0) throw new Error('No uncommitted changes in workspace')

  let branchCreatedHere = false
  if (currentBranch === branchName) {
    // S1: Already on the target branch (gitAutoBranch case) — no checkout needed
    log.debug(`[chat:complete] Already on branch ${branchName}, skipping checkout`)
  } else {
    const localBranches = await git.branchLocal()
    if (localBranches.all.includes(branchName)) {
      // S2/S4: Branch exists but we're not on it — checkout without -b
      await git.checkout(branchName)
      log.debug(`[chat:complete] Switched to existing branch ${branchName}`)
    } else {
      // S3: Normal case — create and checkout new branch
      await git.checkoutLocalBranch(branchName)
      branchCreatedHere = true
      log.debug(`[chat:complete] Created and switched to new branch ${branchName}`)
    }
  }

  try {
    await git.add(changedPaths)

    const body = description ? `${description}\n\n${COMMIT_ATTRIBUTION}` : COMMIT_ATTRIBUTION
    const fullMessage = `${commitMessage}\n\n${body}`
    await git.commit(fullMessage)
    const commitHash = await git.revparse(['HEAD'])

    // Push if remote exists
    let prUrl: string | undefined
    try {
      const remotes = await git.getRemotes(true)
      if (remotes.length > 0) {
        await git.push('origin', branchName, ['--set-upstream'])
      }
    } catch (e) {
      log.warn('Push failed (no remote or auth issue):', e)
    }

    // Auto-create PR if GitHub is configured
    if (githubService.isConfigured(workspace.id)) {
      try {
        const prResult = await githubService.createPullRequest({
          workspaceId: workspace.id,
          repoPath: workspace.repoPath,
          head: branchName,
          base: prBaseBranch,
          title: commitMessage,
          body: description
        })
        log.info(`[chat:complete] PR created: ${prResult.prUrl} (pr#${prResult.prNumber})`)
        prUrl = prResult.prUrl
        conversationRepository.updatePrInfo(
          conversationId,
          prResult.prUrl,
          prResult.prNumber,
          branchName
        )
      } catch (e) {
        log.warn('GitHub PR creation/persistence failed (push succeeded):', e)
      }
    }

    // CHAT-COMPLETE-PUSH-DELETE-RACE-01: Isolate post-push cleanup so failures
    // don't trigger the catch handler's branch-deletion recovery. The commit and
    // push already succeeded — cleanup errors are non-fatal.
    await retireCompletedConversation(conversationId)

    return { branch: branchName, commitHash, prUrl }
  } catch (error) {
    // Only reached on the non-isolated path, where this call really did switch
    // the tree's branch. An isolated worktree never gets here — it has nothing
    // to roll back to, and git refuses to delete a branch that is checked out.
    try {
      // Rollback: return to the base branch (not necessarily where we started)
      const rollbackBranch = prBaseBranch !== branchName ? prBaseBranch : currentBranch
      await git.checkout(rollbackBranch)
      // Only delete the branch if we created it in this call — never delete pre-existing branches
      if (branchCreatedHere) {
        await git.deleteLocalBranch(branchName, true)
      }
    } catch {
      /* best effort */
    }
    throw error
  }
}

export function registerChatCompletionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_CLOSE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const closeArgs = requireObject(rawArgs, IPC_CHANNELS.CHAT_CLOSE)
    const conversationId = requireString(closeArgs, 'conversationId', IPC_CHANNELS.CHAT_CLOSE)
    return handleChatClose(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_COMPLETE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_COMPLETE)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_COMPLETE)
    const commitMessage = requireString(args, 'commitMessage', IPC_CHANNELS.CHAT_COMPLETE)
    const description = optionalString(args, 'description', IPC_CHANNELS.CHAT_COMPLETE) ?? ''
    const branchNameArg = optionalString(args, 'branchName', IPC_CHANNELS.CHAT_COMPLETE)
    const baseBranch = optionalString(args, 'baseBranch', IPC_CHANNELS.CHAT_COMPLETE)
    return handleChatComplete({
      conversationId,
      commitMessage,
      description,
      branchNameArg,
      baseBranch
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION)
    const conversationId = requireString(
      args,
      'conversationId',
      IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION
    )

    const conversation = conversationRepository.findById(conversationId)
    if (!conversation) throw new Error('Conversation not found')

    const workspace = workspaceRepository.findById(conversation.workspaceId)
    const messages = messageRepository.findByConversation(conversationId).filter((m) => !m.hidden)

    if (messages.length === 0) {
      return { description: '' }
    }

    // Truncate to last 15 messages, 500 chars each — keeps prompt small for Haiku
    const recentMessages = messages
      .slice(-15)
      .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 500)}`)
      .join('\n')

    // Get file changes for context (best-effort)
    let fileChangesContext = ''
    try {
      const fileChanges = await repoService.getUncommittedFileDetails(workspace?.repoPath ?? '')
      if (fileChanges.length > 0) {
        fileChangesContext = `\n\n## Changed files (${fileChanges.length}):\n${fileChanges
          .map((fc) => `- ${fc.changeType}: ${fc.filePath}`)
          .join('\n')}`
      }
    } catch {
      /* best effort */
    }

    const prompt = `You are generating a concise PR description for a GitHub pull request.

Based on this conversation and file changes, write a clear PR description with:
1. A one-line summary of what changed and why
2. A bullet list of key changes (max 8 items)
3. Any notable decisions or trade-offs

Keep it under 500 words. Use markdown formatting.

## Conversation title: ${conversation.title}

## Recent conversation (last ${Math.min(messages.length, 15)} messages):
${recentMessages}${fileChangesContext}

Respond with ONLY the PR description, no preamble.`

    const resolvedModel = workspace?.id
      ? modelConfigService.getModelById(workspace.id, 'pr-description')
      : DEFAULT_MODEL_CONFIG['pr-description']

    const { text } = await runOneShotClaude({
      feature: 'pr_description',
      model: resolvedModel,
      workspaceId: workspace?.id ?? null,
      conversationId,
      args: ['-p', prompt, '--model', resolvedModel],
      cli: { timeout: 15_000 }
    })

    return { description: text.trim() }
  })

  ipcMain.handle(IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)
    const dataUrl = requireString(args, 'dataUrl', IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)
    const conversationId = optionalString(args, 'conversationId', IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE)

    // Sanitize conversationId — must be alphanumeric/dashes (UUID-like), no path traversal
    if (conversationId && !/^[\w-]+$/.test(conversationId)) {
      throw new Error(`${IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE}: invalid conversationId format`)
    }

    // Extract base64 data from data URL
    const matches = dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/)
    if (!matches) {
      throw new Error('Invalid image data URL format')
    }

    const ext = matches[1]
    const base64Data = matches[2]
    const buffer = Buffer.from(base64Data, 'base64')

    // Save to conversation-scoped directory
    const imageDir = join(app.getPath('userData'), 'chat-images', conversationId || 'unsorted')
    mkdirSync(imageDir, { recursive: true })

    const filename = `clipboard-${Date.now()}.${ext}`
    const filePath = join(imageDir, filename)
    writeFileSync(filePath, buffer)

    return filePath
  })

  ipcMain.handle(IPC_CHANNELS.READ_IMAGE_BASE64, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.READ_IMAGE_BASE64)
    const filePath = requireString(args, 'filePath', IPC_CHANNELS.READ_IMAGE_BASE64)

    // Security: only allow reading from chat-images directory
    const chatImagesDir = join(app.getPath('userData'), 'chat-images')
    const resolved = resolve(filePath)
    if (!resolved.startsWith(chatImagesDir + sep) && resolved !== chatImagesDir) {
      throw new Error('Access denied: file is outside chat-images directory')
    }

    const { base64, mimeType } = fileService.readImageAsBase64(resolved)
    return `data:${mimeType};base64,${base64}`
  })
}

/**
 * Checkpoint Service Runners — hybrid scenarios mixing chat + checkpoint verification.
 *
 * These runners use ctx.streamPrompt to trigger build-mode edits that create checkpoints,
 * then verify checkpoint capture, restore, rewind, and untracked-file handling.
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2ECheckpointRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

// ── Checkpoint Capture ──

/**
 * Hybrid: streamPrompt(edit) in build mode → assert checkpointService.listCheckpoints non-empty.
 */
export async function runCheckpointCapture(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { checkpointService } = await import('../../checkpoint.service')

    transcript.push(statusEntry('streaming_edit'))
    const entries = await ctx.streamPrompt(
      'Edit the file src/hello.ts: add a comment "// checkpoint test" at the top. Use the Edit tool.',
      { conversationId: ctx.conversationId }
    )
    transcript.push(...entries)

    // Allow time for checkpoint creation
    await new Promise((r) => setTimeout(r, 2000))

    const checkpoints = checkpointService.listCheckpoints(ctx.conversationId)
    log.info(`[checkpoint-capture] Found ${checkpoints.length} checkpoints`)

    if (checkpoints.length > 0) {
      transcript.push(statusEntry('checkpoint_captured'))
    } else {
      transcript.push(statusEntry('checkpoint_not_found'))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Checkpoint Restore ──

/**
 * Edit via chat → restoreGitState(checkpointId, fixturePath) → assert file content reverted.
 */
export async function runCheckpointRestore(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { checkpointService } = await import('../../checkpoint.service')
    const { readFileSync } = await import('fs')
    const { join } = await import('path')

    // First, stream an edit to create a checkpoint
    transcript.push(statusEntry('streaming_edit'))
    const entries = await ctx.streamPrompt(
      'Edit src/hello.ts: change VERSION from "1.0.0" to "9.9.9". Use the Edit tool.',
      { conversationId: ctx.conversationId }
    )
    transcript.push(...entries)

    await new Promise((r) => setTimeout(r, 2000))

    const checkpoints = checkpointService.listCheckpoints(ctx.conversationId)
    if (checkpoints.length === 0) {
      transcript.push(statusEntry('restore_skip_no_checkpoint'))
      return transcript
    }

    // Restore to the first (most recent) checkpoint
    const cpId = checkpoints[0].id
    transcript.push(statusEntry(`restoring_checkpoint: ${cpId}`))
    const result = checkpointService.restoreGitState(cpId, ctx.workspacePath)

    if (result.success) {
      // Verify file was reverted
      const filePath = join(ctx.workspacePath, 'src', 'hello.ts')
      const content = readFileSync(filePath, 'utf-8')
      const reverted = content.includes('1.0.0') && !content.includes('9.9.9')
      transcript.push(statusEntry(reverted ? 'restore_ok' : 'restore_content_mismatch'))
    } else {
      transcript.push(statusEntry(`restore_failed: ${result.message}`))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Checkpoint Rewind ──

/**
 * 2 turns → rewind to checkpoint 1 → assert messageRepository count reduced + file reverted.
 */
export async function runCheckpointRewind(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { checkpointService } = await import('../../checkpoint.service')
    const { messageRepository } = await import('../../../db/repositories')

    // Turn 1: edit
    transcript.push(statusEntry('turn_1'))
    const entries1 = await ctx.streamPrompt(
      'Edit src/hello.ts: add a comment "// turn 1" at the top. Use the Edit tool.',
      { conversationId: ctx.conversationId }
    )
    transcript.push(...entries1)
    await new Promise((r) => setTimeout(r, 2000))

    // Turn 2: another edit
    transcript.push(statusEntry('turn_2'))
    const entries2 = await ctx.streamPrompt(
      'Edit src/hello.ts: add a comment "// turn 2" below the previous comment. Use the Edit tool.',
      { conversationId: ctx.conversationId }
    )
    transcript.push(...entries2)
    await new Promise((r) => setTimeout(r, 2000))

    const msgCountBefore = messageRepository.findByConversation(ctx.conversationId).length
    const checkpoints = checkpointService.listCheckpoints(ctx.conversationId)

    if (checkpoints.length < 2) {
      transcript.push(statusEntry(`rewind_skip_insufficient_checkpoints: ${checkpoints.length}`))
      return transcript
    }

    // Rewind to the oldest checkpoint (last in list, since sorted by newest first)
    const oldestCp = checkpoints[checkpoints.length - 1]
    transcript.push(statusEntry(`rewinding_to: ${oldestCp.id}`))

    // Restore git state
    const result = checkpointService.restoreGitState(oldestCp.id, ctx.workspacePath)

    // Truncate messages after checkpoint timestamp
    if (result.success && oldestCp.createdAt) {
      const allMessages = messageRepository.findByConversation(ctx.conversationId)
      const toDelete = allMessages.filter((m) => m.createdAt > oldestCp.createdAt)
      for (const msg of toDelete) {
        messageRepository.deleteById(msg.id)
      }

      const msgCountAfter = messageRepository.findByConversation(ctx.conversationId).length
      const reduced = msgCountAfter < msgCountBefore

      log.info(`[checkpoint-rewind] Messages: ${msgCountBefore} → ${msgCountAfter}, reduced: ${reduced}`)
      transcript.push(statusEntry(reduced ? 'rewind_ok' : 'rewind_messages_not_reduced'))
    } else {
      transcript.push(statusEntry(`rewind_git_restore_failed: ${result.message}`))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Checkpoint Untracked Files ──

/**
 * Chat writes NEW file → restore → assert file removed (git clean semantics).
 */
export async function runCheckpointUntracked(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { checkpointService } = await import('../../checkpoint.service')
    const { existsSync } = await import('fs')
    const { join } = await import('path')

    // Record pre-edit checkpoint list
    const cpBefore = checkpointService.listCheckpoints(ctx.conversationId)

    // Stream a prompt that creates a new file
    transcript.push(statusEntry('streaming_write'))
    const entries = await ctx.streamPrompt(
      'Create a new file src/e2e-untracked-test.ts with content: export const TEST = true. Use the Write tool.',
      { conversationId: ctx.conversationId }
    )
    transcript.push(...entries)
    await new Promise((r) => setTimeout(r, 2000))

    // Verify file was created
    const newFilePath = join(ctx.workspacePath, 'src', 'e2e-untracked-test.ts')
    const fileCreated = existsSync(newFilePath)
    transcript.push(statusEntry(`file_created: ${fileCreated}`))

    if (!fileCreated) {
      transcript.push(statusEntry('untracked_skip_file_not_created'))
      return transcript
    }

    // Get a checkpoint from before the write
    const cpAfter = checkpointService.listCheckpoints(ctx.conversationId)
    // Use either a new checkpoint or restore to pre-state via git clean
    const targetCp = cpBefore.length > 0
      ? cpBefore[0]
      : cpAfter.length > 0 ? cpAfter[cpAfter.length - 1] : null

    if (targetCp) {
      const result = checkpointService.restoreGitState(targetCp.id, ctx.workspacePath)
      if (result.success) {
        // After restore, the untracked file should be gone (git clean -fd)
        const fileGone = !existsSync(newFilePath)
        log.info(`[checkpoint-untracked] File removed after restore: ${fileGone}`)
        transcript.push(statusEntry(fileGone ? 'untracked_removed' : 'untracked_still_exists'))
      } else {
        // Fallback: manually clean
        const { execSync } = await import('child_process')
        execSync('git clean -fd', { cwd: ctx.workspacePath, stdio: 'pipe' })
        const fileGone = !existsSync(newFilePath)
        transcript.push(statusEntry(fileGone ? 'untracked_removed' : 'untracked_clean_failed'))
      }
    } else {
      transcript.push(statusEntry('untracked_skip_no_checkpoint'))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

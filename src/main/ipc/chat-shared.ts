import type { BrowserWindow } from 'electron'
import { fileChangeRepository, workspaceRepository } from '../db/repositories'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatIpcLogger } from '../logger'

const log = chatIpcLogger

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Eliminates duplicated chunk-handling logic between generalist and coordinator paths.
 */
export function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'generalist' | 'coordinator',
  chunk: StreamChunk,
  contentAccumulator: { value: string },
  workspacePath?: string
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
        toolInputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, workspacePath)

        // Safety net: detect plan file writes and inject content as a plan block
        // so the UI renders a PlanCard even when Claude CLI writes plans to files.
        // We extract the content from the tool input JSON (available at tool_result time)
        // instead of reading from disk, avoiding the timing bug where the file doesn't exist yet.
        if (
          chunk.toolName === 'Write' &&
          typeof parsed.file_path === 'string' &&
          parsed.file_path.includes('.claude/plans/') &&
          typeof parsed.content === 'string'
        ) {
          const planBlock = `\n\n\`\`\`\`plan\n${parsed.content}\n\`\`\`\`\n`
          contentAccumulator.value += planBlock
          mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: planBlock,
            role
          })
          log.info('Injected plan content from Write to .claude/plans/', parsed.file_path)
        }
      } catch {
        toolInputSummary = chunk.content.slice(0, 120)
      }
    }
    const toolActivity: Record<string, unknown> = {
      id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      toolName: chunk.toolName ?? 'Unknown',
      status: 'completed',
      completedAt: Date.now()
    }
    // Only include input if we have a real summary — don't overwrite existing input with undefined
    if (toolInputSummary) {
      toolActivity.input = toolInputSummary
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      toolActivity
    })
  } else if (chunk.type === 'error') {
    contentAccumulator.value += `\n\n**Error:** ${chunk.error}`
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n**Error:** ${chunk.error}`,
      role
    })
  } else if (chunk.type === 'status' && chunk.content) {
    // Skip internal heartbeat signals — they're for stall detection, not user-facing
    if (chunk.content === 'heartbeat') return

    // Forward meaningful status messages (reconnection, rate limit fallback, etc.) as italic text
    const statusText = `\n\n_${chunk.content}_\n\n`
    contentAccumulator.value += statusText
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: statusText,
      role
    })
  }
}

/** Check if memory writes are enabled for the given workspace path */
export function isMemoryEnabled(workspacePath: string): boolean {
  const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
  if (!workspace) return true // default enabled
  try {
    const settings = JSON.parse(workspace.settingsJson || '{}')
    return settings.memoryEnabled !== false
  } catch {
    return true
  }
}

/** Check if post-specialist code review is enabled for the given workspace path */
export function isPostReviewEnabled(workspacePath: string): boolean {
  const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
  if (!workspace) return false // default disabled — opt-in feature
  try {
    const settings = JSON.parse(workspace.settingsJson || '{}')
    return settings.postReviewEnabled === true
  } catch {
    return false
  }
}

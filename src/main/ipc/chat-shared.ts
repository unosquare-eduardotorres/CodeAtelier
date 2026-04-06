import type { BrowserWindow } from 'electron'
import { fileChangeRepository, workspaceRepository } from '../db/repositories'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatIpcLogger } from '../logger'

const log = chatIpcLogger

/**
 * Extracts a brief human-readable result summary from a tool result.
 * Used to populate ToolActivity.result for inline display in ToolActivityBlock.
 */
function extractResultSummary(toolName: string, content: string | undefined): string | undefined {
  if (!content) return undefined
  try {
    // For Write/Edit tools, the result is typically a confirmation
    if (toolName === 'Write' || toolName === 'Edit') {
      return 'Done'
    }
    // For Bash tool, extract exit code or first meaningful line
    if (toolName === 'Bash') {
      const lines = content.split('\n').filter((l) => l.trim())
      if (lines.length === 0) return 'No output'
      if (content.includes('exit code')) {
        const exitMatch = content.match(/exit code[:\s]*(\d+)/i)
        if (exitMatch) {
          return exitMatch[1] === '0' ? 'Success (exit 0)' : `Failed (exit ${exitMatch[1]})`
        }
      }
      // Return first meaningful line, truncated
      const firstLine = lines[0].trim()
      return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
    }
    // For Read tool — report line count
    if (toolName === 'Read') {
      const lineCount = content.split('\n').length
      return `${lineCount} line${lineCount !== 1 ? 's' : ''} read`
    }
    // For Grep — report match count
    if (toolName === 'Grep') {
      const matchCount = content.split('\n').filter((l) => l.trim()).length
      return `${matchCount} match${matchCount !== 1 ? 'es' : ''}`
    }
    // For Glob — report file count
    if (toolName === 'Glob') {
      const fileCount = content.split('\n').filter((l) => l.trim()).length
      return `${fileCount} file${fileCount !== 1 ? 's' : ''} found`
    }
    // Default: first line truncated
    const firstLine = content.split('\n')[0]?.trim()
    if (!firstLine) return undefined
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
  } catch {
    return undefined
  }
}

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Eliminates duplicated chunk-handling logic between generalist and specialist paths.
 */
export function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'generalist' | 'specialist',
  chunk: StreamChunk,
  contentAccumulator: { value: string },
  workspacePath?: string,
  specialistMeta?: { specialist: string; taskId: string }
): void {
  if (chunk.type === 'text' && chunk.content) {
    contentAccumulator.value += chunk.content
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: chunk.content,
      role,
      ...specialistMeta
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
      ...specialistMeta,
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
            role,
            ...specialistMeta
          })
          log.info('Injected plan content from Write to .claude/plans/', parsed.file_path)
        }
      } catch {
        toolInputSummary = chunk.content.slice(0, 120)
      }
    }
    const resultSummary = extractResultSummary(chunk.toolName ?? '', chunk.content)
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
    if (resultSummary) {
      toolActivity.result = resultSummary
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      ...specialistMeta,
      toolActivity
    })
  } else if (chunk.type === 'error') {
    contentAccumulator.value += `\n\n**Error:** ${chunk.error}`
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n**Error:** ${chunk.error}`,
      role,
      ...specialistMeta
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
      role,
      ...specialistMeta
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

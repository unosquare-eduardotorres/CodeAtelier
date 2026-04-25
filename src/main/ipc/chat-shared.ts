import type { BrowserWindow } from 'electron'
import { fileChangeRepository } from '../db/repositories'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import type { ConversationPhase } from '../../shared/types'
import { chatIpcLogger } from '../logger'
import { createTextChunk, createToolActivityChunk, createTurnBoundary } from './chat-protocol'

const log = chatIpcLogger

/**
 * Extracts a brief human-readable result summary from a tool result.
 * Used to populate ToolActivity.result for inline display in ToolActivityBlock.
 */
function extractResultSummary(toolName: string, content: string | undefined): string | undefined {
  if (!content) return undefined
  try {
    // SDK-level tool errors come through the result content as
    // `<tool_use_error>…</tool_use_error>`. Surface a short, accurate label
    // so the UI shows a real error instead of letting the LLM misdiagnose it
    // (e.g. blaming "sandbox" for stale-read issues).
    if (content.includes('<tool_use_error>')) {
      const match = content.match(/<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>|$)/)
      const inner = (match?.[1] ?? content).trim()
      if (/modified since read/i.test(inner)) return 'Stale read — re-read needed'
      if (/string to replace not found/i.test(inner)) return 'String not found — re-read needed'
      if (/permission denied|EACCES|operation not permitted/i.test(inner)) {
        return 'Permission denied'
      }
      const oneLine = inner.split('\n')[0]?.trim() ?? 'Tool error'
      return oneLine.length > 80 ? `Error: ${oneLine.slice(0, 77)}…` : `Error: ${oneLine}`
    }
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
  role: 'da-vinci' | 'specialist',
  chunk: StreamChunk,
  contentAccumulator: { value: string },
  workspacePath?: string,
  specialistMeta?: { specialist: string; taskId?: string },
  phase?: ConversationPhase,
  requestId?: string
): void {
  if (chunk.type === 'text' && chunk.content) {
    contentAccumulator.value += chunk.content
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: chunk.content,
        role,
        phase,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'tool_use') {
    // Control tools are internal — don't show as tool activity in the UI
    if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

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
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createToolActivityChunk({
        conversationId,
        requestId,
        role,
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          input: chunk.toolInput,
          startedAt: Date.now()
        },
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'tool_result') {
    // Control tool results are internal
    if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

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
          mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({
              conversationId,
              requestId,
              text: planBlock,
              role,
              specialist: specialistMeta?.specialist,
              taskId: specialistMeta?.taskId
            })
          )
          log.info('Injected plan content from Write to .claude/plans/', parsed.file_path)
        }
      } catch {
        toolInputSummary = chunk.content.slice(0, 120)
      }
    }
    const resultSummary = extractResultSummary(chunk.toolName ?? '', chunk.content)
    // Tag the activity as 'error' when the SDK returned a tool_use_error so
    // the renderer can show it visually distinct from a successful run.
    const isToolError =
      typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')
    const toolActivity: Record<string, unknown> = {
      id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      toolName: chunk.toolName ?? 'Unknown',
      status: isToolError ? 'error' : 'completed',
      completedAt: Date.now()
    }
    // Only include input if we have a real summary — don't overwrite existing input with undefined
    if (toolInputSummary) {
      toolActivity.input = toolInputSummary
    }
    if (resultSummary) {
      toolActivity.result = resultSummary
    }
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createToolActivityChunk({
        conversationId,
        requestId,
        role,
        toolActivity: toolActivity as { id: string; toolName: string },
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'turn_boundary') {
    // Emit a mid-stream boundary signal — renderer finalizes current bubble
    // and starts accumulating into a new one
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTurnBoundary({
        conversationId,
        requestId,
        role,
        turnId: chunk.content ?? `turn-${Date.now()}`,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'error') {
    contentAccumulator.value += `\n\n**Error:** ${chunk.error}`
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: `\n\n**Error:** ${chunk.error}`,
        role,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'status' && chunk.content) {
    // Skip internal heartbeat signals — they're for stall detection, not user-facing
    if (chunk.content === 'heartbeat') return

    // Forward meaningful status messages (reconnection, rate limit fallback, etc.) as italic text
    const statusText = `\n\n_${chunk.content}_\n\n`
    contentAccumulator.value += statusText
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: statusText,
        role,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'tool_progress') {
    // Update running tool with elapsed time
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createToolActivityChunk({
        conversationId,
        requestId,
        role,
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          elapsedSeconds: chunk.elapsedSeconds
        },
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'rate_limit') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_RATE_LIMIT, {
      ...(chunk.rateLimit ?? {}),
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'api_retry') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_API_RETRY, {
      ...(chunk.retryInfo ?? {}),
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'compact_boundary') {
    // Show compaction as system message in chat
    const compactText = `\n\n_⚡ ${chunk.content}_\n\n`
    contentAccumulator.value += compactText
    mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: compactText,
        role,
        specialist: specialistMeta?.specialist,
        taskId: specialistMeta?.taskId
      })
    )
  } else if (chunk.type === 'prompt_suggestion') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_PROMPT_SUGGESTION, {
      conversationId,
      suggestion: chunk.content,
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'files_persisted') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_FILES_PERSISTED, {
      conversationId,
      files: chunk.persistedFiles,
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'hook_lifecycle') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_HOOK_LIFECYCLE, {
      ...(chunk.hookInfo ?? {}),
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'session_state') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_SESSION_STATE, {
      state: chunk.content,
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'auth_status') {
    mainWindow.webContents.send(IPC_CHANNELS.SDK_AUTH_STATUS, {
      message: chunk.content,
      ...(requestId ? { requestId } : {})
    })
  } else if (chunk.type === 'session_recovery') {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_SESSION_RECOVERY, {
      conversationId,
      phase: chunk.recoveryPhase,
      message: chunk.content,
      ...(requestId ? { requestId } : {})
    })
  }
}

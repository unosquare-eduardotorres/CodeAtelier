import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { fileChangeRepository } from '../db/repositories'
import { bugRepository } from '../db/repositories/bug.repository'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import type { ConversationPhase } from '../../shared/types'
import { chatIpcLogger } from '../logger'
import { createTextChunk, createToolActivityChunk, createTurnBoundary } from './chat-protocol'

const log = chatIpcLogger

/** Return type from extractResultSummary — short summary + optional expanded detail */
export interface ToolResultSummary {
  result: string
  resultDetail?: string
}

/** Cap for resultDetail content — ~2K chars */
const DETAIL_CAP = 2048

/**
 * Extracts a brief human-readable result summary from a tool result.
 * Returns both a short `result` (one-line) and an optional `resultDetail`
 * (expanded text, up to ~2K chars) for the expand panel in ToolActivityBlock.
 */
export function extractResultSummary(
  toolName: string,
  content: string | undefined
): ToolResultSummary | undefined {
  if (!content) return undefined
  try {
    // SDK persisted-output placeholder — the SDK stores oversized results to disk
    if (content.includes('<persisted-output>') || content.includes('persisted-output')) {
      return {
        result: 'Result too large to display',
        resultDetail:
          'Output was persisted by the SDK. Check .claude/ directory for the full result.'
      }
    }

    // SDK-level tool errors come through the result content as
    // `<tool_use_error>…</tool_use_error>`. Surface a short, accurate label
    // so the UI shows a real error instead of letting the LLM misdiagnose it
    // (e.g. blaming "sandbox" for stale-read issues).
    if (content.includes('<tool_use_error>')) {
      const match = content.match(/<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>|$)/)
      const inner = (match?.[1] ?? content).trim()
      if (/modified since read/i.test(inner))
        return { result: 'Stale read — re-read needed', resultDetail: inner.slice(0, DETAIL_CAP) }
      if (/string to replace not found/i.test(inner))
        return {
          result: 'String not found — re-read needed',
          resultDetail: inner.slice(0, DETAIL_CAP)
        }
      if (/permission denied|EACCES|operation not permitted/i.test(inner)) {
        return { result: 'Permission denied', resultDetail: inner.slice(0, DETAIL_CAP) }
      }
      const oneLine = inner.split('\n')[0]?.trim() ?? 'Tool error'
      const shortResult =
        oneLine.length > 80 ? `Error: ${oneLine.slice(0, 77)}…` : `Error: ${oneLine}`
      return { result: shortResult, resultDetail: inner.slice(0, DETAIL_CAP) }
    }
    // For Write/Edit tools, the result is typically a confirmation
    if (toolName === 'Write' || toolName === 'Edit') {
      return { result: 'Done' }
    }
    // For Bash tool, extract exit code or first meaningful line
    if (toolName === 'Bash') {
      const lines = content.split('\n').filter((l) => l.trim())
      if (lines.length === 0) return { result: 'No output' }
      if (content.includes('exit code')) {
        const exitMatch = content.match(/exit code[:\s]*(\d+)/i)
        if (exitMatch) {
          const shortResult =
            exitMatch[1] === '0' ? 'Success (exit 0)' : `Failed (exit ${exitMatch[1]})`
          return {
            result: shortResult,
            resultDetail: lines.length > 1 ? content.slice(0, DETAIL_CAP) : undefined
          }
        }
      }
      // Return first meaningful line, truncated
      const firstLine = lines[0].trim()
      const shortResult = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
      return {
        result: shortResult,
        resultDetail: lines.length > 1 ? content.slice(0, DETAIL_CAP) : undefined
      }
    }
    // For Read tool — report line count (no detail — file path is in input)
    if (toolName === 'Read') {
      const lineCount = content.split('\n').length
      return { result: `${lineCount} line${lineCount !== 1 ? 's' : ''} read` }
    }
    // For Grep — report match count + detail with matching lines
    if (toolName === 'Grep') {
      const matchLines = content.split('\n').filter((l) => l.trim())
      const matchCount = matchLines.length
      const shortResult = `${matchCount} match${matchCount !== 1 ? 'es' : ''}`
      const detail = matchLines.slice(0, 30).join('\n')
      return {
        result: shortResult,
        resultDetail: detail.length > 0 ? detail.slice(0, DETAIL_CAP) : undefined
      }
    }
    // For Glob — report file count + detail with file list
    if (toolName === 'Glob') {
      const fileLines = content.split('\n').filter((l) => l.trim())
      const fileCount = fileLines.length
      const shortResult = `${fileCount} file${fileCount !== 1 ? 's' : ''} found`
      const detail = fileLines.slice(0, 50).join('\n')
      return {
        result: shortResult,
        resultDetail: detail.length > 0 ? detail.slice(0, DETAIL_CAP) : undefined
      }
    }
    // ── MCP tool results: extract meaningful counts from JSON ──
    if (toolName.startsWith(MCP_TOOLS.CODE_GRAPH._PREFIX)) {
      try {
        const parsed = JSON.parse(content)
        const detail = content.slice(0, DETAIL_CAP)
        // search_identifiers
        if (parsed.symbols?.length !== undefined) {
          const n = parsed.symbols.length
          return { result: `${n} symbol${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // find_callers / FindAllCallers
        if (parsed.callers?.length !== undefined) {
          const n = parsed.callers.length
          return { result: `${n} caller${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // find_references
        if (parsed.references?.length !== undefined) {
          const n = parsed.references.length
          return { result: `${n} reference${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // find_callees / FindAllCallees
        if (parsed.callees?.length !== undefined) {
          const n = parsed.callees.length
          return { result: `${n} callee${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // file_outline
        if (parsed.outline?.length !== undefined) {
          const n = parsed.outline.length
          return { result: `${n} symbol${n !== 1 ? 's' : ''} in outline`, resultDetail: detail }
        }
        // coupling_analysis
        if (parsed.coupledPairs?.length !== undefined) {
          const n = parsed.coupledPairs.length
          return { result: `${n} coupled pair${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // circular_dependencies
        if (parsed.cycles?.length !== undefined) {
          const n = parsed.cycles.length
          return { result: `${n} cycle${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        // module_boundary_health
        if (parsed.boundaries?.length !== undefined) {
          const n = parsed.boundaries.length
          return { result: `${n} module boundary${n !== 1 ? 'ies' : ''}`, resultDetail: detail }
        }
        // Existing checks
        if (parsed.count !== undefined) {
          const n = parsed.count
          return { result: `${n} result${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        if (parsed.definitions?.length !== undefined) {
          const n = parsed.definitions.length
          return { result: `${n} definition${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        if (parsed.report) {
          return {
            result: `${parsed.report.filesIncluded ?? '?'} files mapped`,
            resultDetail: detail
          }
        }
        // Generic fallback — find the first top-level array
        const firstArr = Object.entries(parsed).find(([, v]) => Array.isArray(v)) as
          | [string, unknown[]]
          | undefined
        if (firstArr) {
          return { result: `${firstArr[1].length} ${firstArr[0]}`, resultDetail: detail }
        }
      } catch {
        /* fall through to default */
      }
    }
    if (toolName.startsWith(MCP_TOOLS.CODE_ANALYSIS._PREFIX)) {
      try {
        const parsed = JSON.parse(content)
        const detail = content.slice(0, DETAIL_CAP)
        // todo_scanner
        if (parsed.totalCount !== undefined) {
          const mode = parsed.mode === 'overview' ? ' (overview)' : ''
          return {
            result: `${parsed.totalCount} marker${parsed.totalCount !== 1 ? 's' : ''} found${mode}`,
            resultDetail: detail
          }
        }
        // test_coverage_map
        if (parsed.summary?.totalSourceFiles !== undefined) {
          const s = parsed.summary
          const mode = parsed.mode === 'overview' ? ' (overview)' : ''
          return {
            result: `${s.filesWithTests}/${s.totalSourceFiles} covered (${Math.round(s.coverageRatio * 100)}%)${mode}`,
            resultDetail: detail
          }
        }
        // dependency_health
        if (parsed.counts?.total !== undefined) {
          const c = parsed.counts
          const outdated = c.outdated > 0 ? `, ${c.outdated} outdated` : ''
          return {
            result: `${c.total} deps (${c.production} prod, ${c.dev} dev${outdated})`,
            resultDetail: detail
          }
        }
        // Generic count fallback
        if (parsed.count !== undefined) {
          return {
            result: `${parsed.count} result${parsed.count !== 1 ? 's' : ''}`,
            resultDetail: detail
          }
        }
      } catch {
        /* fall through */
      }
    }
    // Git Context tools
    if (toolName.startsWith(MCP_TOOLS.GIT_CONTEXT._PREFIX)) {
      try {
        const parsed = JSON.parse(content)
        const detail = content.slice(0, DETAIL_CAP)
        if (parsed.commits?.length !== undefined) {
          const n = parsed.commits.length
          return { result: `${n} commit${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        if (parsed.hunks?.length !== undefined) {
          const n = parsed.hunks.length
          return { result: `${n} diff hunk${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        if (parsed.lines?.length !== undefined) {
          const n = parsed.lines.length
          return { result: `${n} blame line${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
      } catch {
        /* fall through */
      }
    }
    // Semantic Search tools
    if (toolName.startsWith(MCP_TOOLS.SEMANTIC_SEARCH._PREFIX)) {
      try {
        const parsed = JSON.parse(content)
        const detail = content.slice(0, DETAIL_CAP)
        if (parsed.results?.length !== undefined) {
          const n = parsed.results.length
          return { result: `${n} result${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
        if (parsed.concepts?.length !== undefined) {
          const n = parsed.concepts.length
          return { result: `${n} concept${n !== 1 ? 's' : ''}`, resultDetail: detail }
        }
      } catch {
        /* fall through */
      }
    }

    // Default: first line truncated, detail from first 2K
    const firstLine = content.split('\n')[0]?.trim()
    if (!firstLine) return undefined
    const shortResult = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
    const hasMore = content.length > firstLine.length + 1
    return { result: shortResult, resultDetail: hasMore ? content.slice(0, DETAIL_CAP) : undefined }
  } catch {
    return undefined
  }
}

/**
 * Auto-capture MCP tool errors to the bug tracker.
 * Called when `isToolError` is true in any pipeline (DaVinci, Grill, Audit).
 */
export function reportToolError(
  toolName: string,
  errorContent: string,
  context: { agentType: 'da-vinci' | 'grill' | 'audit'; workspaceId?: string; agentId?: string }
): void {
  try {
    const firstLine = errorContent.split('\n')[0]?.trim() ?? 'Unknown error'
    const SDK_BUILTIN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'])
    const prefix = SDK_BUILTIN_TOOLS.has(toolName) ? 'Tool error' : 'MCP tool error'
    bugRepository.upsertBug({
      process: 'main',
      severity: 'error',
      errorMessage: `${prefix}: ${toolName} — ${firstLine}`,
      stackTrace: errorContent.slice(0, 2048),
      componentName: context.agentType,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      appVersion: app.getVersion()
    })
  } catch (e) {
    log.warn('Failed to report tool error to bug tracker:', e)
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

    // Track file changes for Write/Edit tools (native + MCP variants)
    const isWriteTool = chunk.toolName === 'Write' || chunk.toolName?.endsWith('__Write')
    const isEditTool = chunk.toolName === 'Edit' || chunk.toolName?.endsWith('__Edit')
    if ((isWriteTool || isEditTool) && chunk.toolInput) {
      try {
        fileChangeRepository.track(
          conversationId,
          chunk.toolInput,
          isWriteTool ? 'created' : 'modified'
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
    const resultSummaryObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
    let resultSummary = resultSummaryObj?.result
    const resultDetail = resultSummaryObj?.resultDetail

    // For Read, compose file path into result so it's always visible
    // (e.g. "176 lines read — src/main/index.ts" instead of just "176 lines read")
    if (chunk.toolName === 'Read' && toolInputSummary && resultSummary) {
      resultSummary = `${resultSummary} — ${toolInputSummary}`
    }

    // Tag the activity as 'error' when the SDK returned a tool_use_error so
    // the renderer can show it visually distinct from a successful run.
    const isToolError =
      typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

    // Auto-capture tool errors to the bug tracker
    if (isToolError && chunk.content) {
      reportToolError(chunk.toolName ?? 'Unknown', chunk.content, {
        agentType: 'da-vinci',
        workspaceId: undefined, // not available in this context
        agentId: undefined
      })
    }

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
    if (resultDetail) {
      toolActivity.resultDetail = resultDetail
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

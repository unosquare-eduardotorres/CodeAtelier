import log from 'electron-log/main'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

const hookLog = log.scope('SDKHooks')

const DANGEROUS_PATTERNS = [
  'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf $HOME',
  'git push --force main', 'git push --force master',
  'git push --force origin main', 'git push --force origin master',
  'git push -f origin main', 'git push -f origin master',
  'sudo ', 'mkfs.', 'dd if=', ':(){:|:&};:',
  'chmod -R 777 /', 'chmod -R 777 /*',
  'DROP DATABASE', 'DROP TABLE', 'TRUNCATE TABLE',
  '| bash', '| sh', 'npm publish'
]

export function isDangerousCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return DANGEROUS_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/**
 * Creates a PreToolUse scope guard hook for the SDK.
 * Blocks file writes outside the allowed cwd and dangerous bash commands.
 * Returns SDK-compatible HookCallback for use in query() hooks option.
 */
export function createScopeGuard(allowedCwd: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>

    // File scope check for Write/Edit
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput?.file_path as string
      if (filePath && !filePath.startsWith(allowedCwd)) {
        hookLog.warn(`Blocked file access outside scope: ${filePath}`)
        return { decision: 'block', reason: `File outside allowed scope: ${filePath}` }
      }
    }

    // Dangerous command check for Bash
    if (toolName === 'Bash') {
      const command = toolInput?.command as string
      if (command && isDangerousCommand(command)) {
        hookLog.warn(`Blocked dangerous command: ${command.substring(0, 100)}`)
        return { decision: 'block', reason: 'Dangerous command blocked by scope guard' }
      }
    }

    return {} // Allow — no decision means continue
  }
}

/**
 * Creates a PreToolUse hook that enforces Code Graph-first exploration.
 * Tracks whether any Code Graph / Semantic Search tool has been called.
 * If Read/Grep/Glob is called before any graph tool, logs a warning
 * (warn mode) or blocks the call (block mode).
 *
 * Non-code files (config, docs, JSON, YAML, etc.) are exempt — they
 * don't benefit from graph tools.
 */
export function createCodeGraphFirstHook(mode: 'warn' | 'block' = 'warn'): HookCallback {
  let hasUsedGraphTool = false
  let toolCallCount = 0

  // Tools that satisfy the "graph first" requirement
  const GRAPH_TOOLS = new Set([
    'mcp__code-graph__graph_map',
    'mcp__code-graph__search_identifiers',
    'mcp__code-graph__find_dead_code',
    'mcp__semantic-search__semantic_search',
    // Also accept short names in case MCP prefixing varies
    'graph_map',
    'search_identifiers',
    'find_dead_code',
    'semantic_search'
  ])

  // Tools that should come AFTER graph tools for code exploration
  const EXPLORATION_TOOLS = new Set(['Read', 'Grep', 'Glob'])

  // File patterns that are NOT code (ok to Read without graph)
  const NON_CODE_PATTERNS = [
    /package\.json$/,
    /tsconfig.*\.json$/,
    /\.env/,
    /\.yml$/,
    /\.yaml$/,
    /\.md$/,
    /\.json$/,
    /\.lock$/,
    /\.config\./,
    /\.css$/,
    /\.html$/,
    /\.svg$/
  ]

  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>
    toolCallCount++

    // Track graph tool usage
    if (GRAPH_TOOLS.has(toolName)) {
      hasUsedGraphTool = true
      return {}
    }

    // Check if this is a premature exploration call (only within first 5 tool calls)
    if (EXPLORATION_TOOLS.has(toolName) && !hasUsedGraphTool && toolCallCount <= 5) {
      // Allow non-code file reads (config, docs, etc.)
      if (toolName === 'Read') {
        const filePath = (toolInput?.file_path as string) || ''
        if (NON_CODE_PATTERNS.some((p) => p.test(filePath))) {
          return {} // Allow — config/doc files don't need graph
        }
      }

      // Allow Grep on non-code patterns (e.g. grepping config files)
      if (toolName === 'Grep') {
        const grepPath = (toolInput?.path as string) || ''
        if (NON_CODE_PATTERNS.some((p) => p.test(grepPath))) {
          return {} // Allow — config/doc files don't need graph
        }
      }

      const reason = `Code Graph Protocol: Use search_identifiers or graph_map BEFORE ${toolName} for code exploration. This saves tool calls and improves accuracy.`

      hookLog.warn(`[CodeGraphFirst] ${toolName} called before any graph tool (call #${toolCallCount})`)

      if (mode === 'block') {
        return { decision: 'block', reason }
      }
      // Warn mode: allow but log — the prompt guidance should handle most cases
      return {}
    }

    return {}
  }
}

/** PostToolUse hook — tracks tool success for analytics */
export function createPostToolUseHook(agentId: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const durationMs = (input as Record<string, unknown>).duration_ms as number | undefined
    hookLog.info(`[PostToolUse] ${agentId}/${toolName} completed in ${durationMs ?? '?'}ms`)
    return {}
  }
}

/** PostToolUseFailure hook — detects systematic failures */
export function createPostToolUseFailureHook(agentId: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const error = (input as Record<string, unknown>).error as string | undefined
    hookLog.warn(`[PostToolUseFailure] ${agentId}/${toolName}: ${error}`)
    return {}
  }
}

/** Notification hook — logs SDK notifications */
export function createNotificationHook(): HookCallback {
  return async (input) => {
    const msg = (input as Record<string, unknown>).message as string
    hookLog.info(`[SDK Notification] ${msg}`)
    return {}
  }
}

/** SessionEnd hook — cleanup resources when session ends */
export function createSessionEndHook(onEnd: () => void): HookCallback {
  return async () => {
    hookLog.info('[SessionEnd] Cleaning up resources')
    onEnd()
    return {}
  }
}

/** FileChanged hook — real-time file tracking */
export function createFileChangedHook(
  onFileChanged: (filePath: string, changeType: string) => void
): HookCallback {
  return async (input) => {
    const filePath = (input as Record<string, unknown>).file_path as string
    const changeType = (input as Record<string, unknown>).change_type as string
    onFileChanged(filePath, changeType)
    return {}
  }
}

/**
 * Creates a PreToolUse hook that requests user approval for dangerous tools.
 * Auto-approves safe tools (Read, Grep, etc.) and caches decisions for 30s.
 */
export function createToolApprovalHook(agentId: string, taskId?: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>

    const { toolApprovalService } = await import('./tool-approval.service')

    const approved = await toolApprovalService.requestApproval(
      toolName,
      toolInput,
      agentId,
      taskId
    )

    if (!approved) {
      hookLog.info(`Tool ${toolName} blocked by user for agent ${agentId}`)
      return { decision: 'block', reason: 'Blocked by user' }
    }

    return {} // Allow
  }
}
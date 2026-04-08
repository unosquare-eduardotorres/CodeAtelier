import log from 'electron-log/main'
import type { HookCallback, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

const hookLog = log.scope('SDKHooks')

const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf $HOME',
  'git push --force main',
  'git push --force master',
  'git push --force origin main',
  'git push --force origin master',
  'git push -f origin main',
  'git push -f origin master',
  'sudo ',
  'mkfs.',
  'dd if=',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'chmod -R 777 /*',
  'DROP DATABASE',
  'DROP TABLE',
  'TRUNCATE TABLE',
  '| bash',
  '| sh',
  'npm publish'
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

      hookLog.warn(
        `[CodeGraphFirst] ${toolName} called before any graph tool (call #${toolCallCount})`
      )

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

    const approved = await toolApprovalService.requestApproval(toolName, toolInput, agentId, taskId)

    if (!approved) {
      hookLog.info(`Tool ${toolName} blocked by user for agent ${agentId}`)
      return { decision: 'block', reason: 'Blocked by user' }
    }

    return {} // Allow
  }
}

/**
 * Fire-and-forget patterns — commands that start long-running servers
 * and should never block the SDK waiting for exit.
 */
const FIRE_AND_FORGET_PATTERNS: RegExp[] = [
  // Node.js / JavaScript
  /\bnpm\s+run\s+(dev|start|serve|watch|preview)\b/,
  /\bnpm\s+start\b/,
  /\bnpx\s+(vite|next|nuxt|remix|astro|expo)\b/,
  /\byarn\s+(dev|start|serve|watch|preview)\b/,
  /\bpnpm\s+(dev|start|serve|watch|preview)\b/,
  /\bbun\s+(dev|start|run\s+dev|run\s+start)\b/,
  /\bnode\s+\S*server/i,
  /\bnext\s+dev\b/,
  /\bvite\b(?!.*build)/,
  // Electron
  /\belectron\s+\./,
  /\belectron-vite\s+dev\b/,
  /\bnpm\s+run\s+dev:restart\b/,
  // Python
  /\bpython\s+-m\s+http\.server\b/,
  /\bflask\s+run\b/,
  /\buvicorn\s+/,
  /\bgunicorn\s+/,
  /\bdjango.*runserver\b/,
  // Ruby / Rails
  /\brails\s+server\b/,
  /\brails\s+s\b/,
  // PHP
  /\bphp\s+artisan\s+serve\b/,
  /\bphp\s+-S\s+/,
  // Go
  /\bgo\s+run\s+.*main/,
  /\bair\b/, // Go live reload
  // Rust
  /\bcargo\s+run\b/,
  /\bcargo\s+watch\b/,
  // .NET
  /\bdotnet\s+run\b/,
  /\bdotnet\s+watch\b/,
  // Angular / Ionic
  /\bng\s+serve\b/,
  /\bionic\s+serve\b/,
  // Docker
  /\bdocker\s+compose\s+up\b(?!.*-d)/
]

/** Check if a command is already backgrounded */
function isAlreadyBackgrounded(command: string): boolean {
  const trimmed = command.trim()
  return (
    trimmed.endsWith('&') ||
    trimmed.includes('nohup ') ||
    trimmed.includes('disown') ||
    trimmed.includes('run_in_background') ||
    trimmed.includes('& echo') ||
    trimmed.includes('&>')
  )
}

/**
 * Creates a PreToolUse hook that detects "fire and forget" Bash commands
 * (dev servers, watchers, etc.) and rewrites them to run in the background.
 *
 * Uses the SDK's updatedInput capability to modify the command before execution,
 * so the Bash tool returns immediately instead of blocking for minutes.
 */
export function createFireAndForgetHook(): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    if (toolName !== 'Bash') return {}

    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>
    const command = toolInput?.command as string
    if (!command) return {}

    // Skip if already backgrounded
    if (isAlreadyBackgrounded(command)) return {}

    // Check against fire-and-forget patterns
    const isFireAndForget = FIRE_AND_FORGET_PATTERNS.some((p) => p.test(command))
    if (!isFireAndForget) return {}

    // Rewrite command to run in background with verification
    const logFile = `/tmp/agent-studio-bg-${Date.now()}.log`
    const bgCommand = [
      `nohup ${command} > ${logFile} 2>&1 &`,
      `BG_PID=$!`,
      `sleep 3`,
      `if kill -0 $BG_PID 2>/dev/null; then`,
      `  echo "✅ Process started successfully in background (PID: $BG_PID)"`,
      `  echo "📄 Output log: ${logFile}"`,
      `  echo "--- Initial output (first 20 lines) ---"`,
      `  head -20 ${logFile} 2>/dev/null || echo "(no output yet)"`,
      `else`,
      `  echo "❌ Process exited early. Full output:"`,
      `  cat ${logFile} 2>/dev/null || echo "(no output captured)"`,
      `fi`
    ].join('\n')

    hookLog.info(`[FireAndForget] Backgrounding command: ${command.substring(0, 80)}...`)

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, command: bgCommand },
        additionalContext:
          'This long-running server command was automatically backgrounded. ' +
          'The process is running and the output is being logged to a file.'
      }
    } as SyncHookJSONOutput
  }
}

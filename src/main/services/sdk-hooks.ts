import log from 'electron-log/main'
import type { HookCallback, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

const hookLog = log.scope('SDKHooks')

/**
 * Creates a PreToolUse scope guard hook for the SDK.
 * Blocks file writes outside the allowed cwd.
 * Returns SDK-compatible HookCallback for use in query() hooks option.
 *
 * Note: With SDK 0.2.96 PermissionMode: 'auto', dangerous command detection
 * is handled natively by the SDK's model classifier. The scope guard remains
 * as defense-in-depth for file path containment.
 */
export function createScopeGuard(allowedCwd: string): HookCallback {
  const resolvedCwd = require('path').resolve(allowedCwd)

  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>

    // File scope check for Write/Edit
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput?.file_path as string
      if (filePath && !isWithinScope(filePath, resolvedCwd)) {
        hookLog.warn(`Blocked file write outside scope: ${filePath}`)
        return { decision: 'block', reason: `File outside allowed scope: ${filePath}` }
      }
    }

    // Read scope check — prevent agents from reading files outside the workspace
    if (toolName === 'Read') {
      const filePath = toolInput?.file_path as string
      if (filePath && !isWithinScope(filePath, resolvedCwd)) {
        hookLog.warn(`Blocked Read outside scope: ${filePath}`)
        return {
          decision: 'block',
          reason: `Cannot read files outside workspace: ${filePath}. Stay within ${resolvedCwd}`
        }
      }
    }

    // Glob/Grep scope check — prevent scanning outside the workspace
    if (toolName === 'Glob' || toolName === 'Grep') {
      const searchPath = toolInput?.path as string | undefined
      if (searchPath && !isWithinScope(searchPath, resolvedCwd)) {
        hookLog.warn(`Blocked ${toolName} outside scope: ${searchPath}`)
        return {
          decision: 'block',
          reason: `Cannot search outside workspace: ${searchPath}. Stay within ${resolvedCwd}`
        }
      }
    }

    // Bash scope check — block commands that explicitly reference paths outside workspace
    if (toolName === 'Bash') {
      const command = toolInput?.command as string
      if (command) {
        const dangerousPatterns = [/\.\.\//, /cd\s+\.\./]
        const hasDangerousPath = dangerousPatterns.some((p) => p.test(command))
        if (hasDangerousPath) {
          // Resolve any path arguments to check if they escape cwd
          const pathMatches = command.match(/(?:cat|less|head|tail|find|ls)\s+(\S+)/g)
          if (pathMatches) {
            for (const match of pathMatches) {
              const arg = match.split(/\s+/).pop()
              if (arg && !isWithinScope(arg, resolvedCwd)) {
                hookLog.warn(`Blocked Bash outside scope: ${command}`)
                return {
                  decision: 'block',
                  reason: `Bash command references files outside workspace. Stay within ${resolvedCwd}`
                }
              }
            }
          }
        }
      }
    }

    return {} // Allow — no decision means continue
  }
}

/** Check if a path resolves within the allowed cwd (handles ../ traversal) */
function isWithinScope(targetPath: string, resolvedCwd: string): boolean {
  const path = require('path')
  const resolved = path.resolve(resolvedCwd, targetPath)
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
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

/**
 * Strategy Μ (Mu): PreToolUse hook that enforces a default limit on Read calls.
 * When the model calls Read without specifying a limit, inject a reasonable default
 * to prevent full-file reads that bloat the context window. The model can override
 * by explicitly passing limit in the tool input.
 *
 * Exemption: if the model specifies offset, it implies targeted reading — don't interfere.
 */
export function createReadLimitHook(defaultLimit: number = 300): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    if (toolName !== 'Read') return {}

    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>
    // Only inject limit if the model didn't specify one AND didn't specify offset
    // (offset implies targeted reading — the model knows what it's doing)
    if (toolInput.limit === undefined && toolInput.offset === undefined) {
      hookLog.info(`[ReadLimit] Injecting limit=${defaultLimit} on Read without explicit limit`)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: {
            ...toolInput,
            limit: defaultLimit
          }
        }
      } as SyncHookJSONOutput
    }
    return {}
  }
}

/**
 * PreToolUse hook that caps Bash output for commands known to produce large output.
 * Appends `2>&1 | tail -N` to noisy commands (npm build, eslint, tsc, git log, etc.)
 * where we only care about success/failure and a few trailing lines.
 *
 * Does NOT modify commands that already have output redirection.
 */
export function createBashOutputCapHook(tailLines: number = 30): HookCallback {
  // Patterns that produce huge output but where we only care about success/failure
  const NOISY_COMMANDS: RegExp[] = [
    /^npm (run |)(dev|build|install|ci)\b/,
    /^npx (eslint|prettier|tsc)\b/,
    /^git log(?! --oneline)/
  ]

  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    if (toolName !== 'Bash') return {}

    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>
    const command = toolInput?.command as string
    if (!command) return {}

    // Don't modify commands that already have output redirection
    if (
      command.includes('| tail') ||
      command.includes('| head') ||
      command.includes('> ') ||
      command.includes('2>')
    ) {
      return {}
    }

    const isNoisy = NOISY_COMMANDS.some((p) => p.test(command))
    if (!isNoisy) return {}

    hookLog.info(`[BashOutputCap] Capping output: ${command.substring(0, 80)}...`)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        updatedInput: {
          ...toolInput,
          command: `${command} 2>&1 | tail -${tailLines}`
        }
      }
    } as SyncHookJSONOutput
  }
}

/**
 * PostToolUse hook that detects consecutive large tool outputs and injects
 * guidance asking the model to use more targeted tool calls.
 *
 * When 2+ consecutive tool outputs exceed the character threshold,
 * injects additionalContext advising the model to use offset+limit on Read,
 * filter Grep, and pipe Bash through head/tail.
 */
export function createLargeOutputWarningHook(thresholdChars: number = 10_000): HookCallback {
  let consecutiveLargeOutputs = 0

  return async (input) => {
    const i = input as Record<string, unknown>
    // Only act on PostToolUse events
    if (i.hook_event_name !== 'PostToolUse') return {}

    const toolResponse = i.tool_response as string | undefined
    const outputLen = typeof toolResponse === 'string' ? toolResponse.length : 0

    if (outputLen > thresholdChars) {
      consecutiveLargeOutputs++
      if (consecutiveLargeOutputs >= 2) {
        const toolName = i.tool_name as string
        hookLog.info(
          `[LargeOutputWarning] ${consecutiveLargeOutputs} consecutive large outputs ` +
            `(last: ${toolName}, ${outputLen} chars) — injecting guidance`
        )
        consecutiveLargeOutputs = 0
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse' as const,
            additionalContext:
              'Multiple large tool outputs detected. Use targeted reads (offset+limit), ' +
              'filter grep results, and pipe bash output through head/tail to keep context manageable.'
          }
        } as SyncHookJSONOutput
      }
    } else {
      consecutiveLargeOutputs = 0
    }
    return {}
  }
}

/**
 * PreToolUse hook that auto-corrects pathPrefix → path for SDK built-in tools.
 * The model sometimes confuses pathPrefix (from MCP tools like find_dead_code,
 * todo_scanner) with path (the actual SDK parameter for Grep/Glob).
 * Defense-in-depth: even after renaming MCP params, this catches stale sessions.
 */
export function createPathPrefixAutoCorrectHook(): HookCallback {
  const CORRECTABLE_TOOLS = new Set(['Grep', 'Glob'])

  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    if (!CORRECTABLE_TOOLS.has(toolName)) return {}

    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>
    if (toolInput.pathPrefix !== undefined && toolInput.path === undefined) {
      hookLog.warn(`[PathPrefixAutoCorrect] Correcting pathPrefix → path on ${toolName} call`)
      const { pathPrefix, ...rest } = toolInput
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: { ...rest, path: pathPrefix }
        }
      } as SyncHookJSONOutput
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
 * PermissionDenied hook — surfaces SDK-denied tool calls to the UI.
 * With PermissionMode: 'auto', the SDK's model classifier may deny certain
 * tool calls. This hook logs those denials and emits them to the renderer
 * for transparency.
 */
export function createPermissionDeniedHook(
  onDenied: (toolName: string, reason: string) => void
): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const reason = (input as Record<string, unknown>).reason as string | undefined
    hookLog.info(`[PermissionDenied] ${toolName}: ${reason ?? 'no reason provided'}`)
    onDenied(toolName, reason ?? 'Permission denied by SDK auto-classifier')
    return {}
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
    const logFile = `/tmp/code-atelier-bg-${Date.now()}.log`
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
        updatedInput: { ...toolInput, command: bgCommand, dangerouslyDisableSandbox: true },
        additionalContext:
          'This long-running server command was automatically backgrounded and runs outside ' +
          'the sandbox (needs network port binding and filesystem watchers). ' +
          'The process is running and the output is being logged to a file.'
      }
    } as SyncHookJSONOutput
  }
}

/** SubagentStart hook — fires before SubAgent stream messages arrive */
export function createSubagentStartHook(
  onStart: (agentId: string, description: string) => void
): HookCallback {
  return async (input) => {
    const i = input as Record<string, unknown>
    hookLog.info(`[SubagentStart] agent=${i.agent_id} desc=${i.description}`)
    onStart(i.agent_id as string, i.description as string)
    return {}
  }
}

/** SubagentStop hook — fires when SubAgent completes or fails */
export function createSubagentStopHook(
  onStop: (agentId: string, status: string) => void
): HookCallback {
  return async (input) => {
    const i = input as Record<string, unknown>
    hookLog.info(`[SubagentStop] agent=${i.agent_id} status=${i.status}`)
    onStop(i.agent_id as string, i.status as string)
    return {}
  }
}

/** TaskCreated hook — fires when a task object is created (before execution) */
export function createTaskCreatedHook(
  onCreated: (taskId: string, description: string) => void
): HookCallback {
  return async (input) => {
    const i = input as Record<string, unknown>
    hookLog.info(`[TaskCreated] task=${i.task_id} desc=${i.description}`)
    onCreated(i.task_id as string, i.description as string)
    return {}
  }
}

/** TaskCompleted hook — fires when a task finishes execution */
export function createTaskCompletedHook(
  onCompleted: (taskId: string, status: string) => void
): HookCallback {
  return async (input) => {
    const i = input as Record<string, unknown>
    hookLog.info(`[TaskCompleted] task=${i.task_id} status=${i.status}`)
    onCompleted(i.task_id as string, i.status as string)
    return {}
  }
}

// ── Compaction lifecycle hooks ──────────────────────────────────────────────

/** PreCompact hook — fires before context compaction, receives pre-compaction token count */
export function createPreCompactHook(onPreCompact: (preTokens: number) => void): HookCallback {
  return async (input) => {
    const tokens = (input as Record<string, unknown>).pre_tokens as number
    hookLog.info(`[PreCompact] ${tokens} tokens before compaction`)
    onPreCompact(tokens)
    return {}
  }
}

/** PostCompact hook — fires after context compaction, includes token delta */
export function createPostCompactHook(
  onPostCompact: (preTokens: number, postTokens: number) => void
): HookCallback {
  return async (input) => {
    const i = input as Record<string, unknown>
    const pre = i.pre_tokens as number
    const post = i.post_tokens as number
    hookLog.info(`[PostCompact] ${pre} → ${post} tokens (saved ${pre - post})`)
    onPostCompact(pre, post)
    return {}
  }
}

// ── Tool result budget hook ─────────────────────────────────────────────────

/**
 * PostToolUse hook: Track cumulative tool result size within a single
 * agentic turn. When the running total exceeds a threshold, inject guidance
 * asking the model to use more targeted queries.
 *
 * This is Code Atelier's equivalent of Claude Code's Layer 0 aggregate
 * 200K character budget per message. The counter resets after the warning
 * fires so it can re-trigger if the model continues to produce large output.
 */
export function createToolResultBudgetHook(budgetChars: number = 200_000): HookCallback {
  let turnBudgetUsed = 0

  return async (input) => {
    const i = input as Record<string, unknown>
    // Only act on PostToolUse events
    if (i.hook_event_name !== 'PostToolUse') return {}

    const toolResponse = i.tool_response as string | undefined
    const batchSize = typeof toolResponse === 'string' ? toolResponse.length : 0
    turnBudgetUsed += batchSize

    if (turnBudgetUsed > budgetChars) {
      const consumedK = Math.round(turnBudgetUsed / 1000)
      hookLog.warn(
        `[ToolResultBudget] Turn budget exceeded: ${turnBudgetUsed}/${budgetChars} chars`
      )
      // Reset counter so it can re-trigger if model continues large outputs
      turnBudgetUsed = 0
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext:
            `⚠️ Context budget alert: This turn has consumed ${consumedK}K characters of tool output. ` +
            'Use targeted reads (offset+limit), narrow grep patterns, and FindSymbol/FindDefinition ' +
            'instead of broad searches to avoid context overflow.'
        }
      } as SyncHookJSONOutput
    }
    return {}
  }
}

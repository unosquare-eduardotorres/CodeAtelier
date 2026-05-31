/**
 * Code Atelier OpenCode Plugin — migrates SDK hooks to OpenCode's plugin system.
 *
 * This plugin implements the same safety and optimization hooks that
 * sdk-hooks.ts provides for the Agent SDK backend, adapted for OpenCode's
 * plugin hook API.
 *
 * Hook mapping:
 *   SDK Hook                           → OpenCode Plugin Hook
 *   ────────────────────────────────── → ──────────────────────
 *   createScopeGuard()                 → tool.execute.before (Write/Edit/Read/Bash scope)
 *   createReadLimitHook(300)           → tool.execute.before (inject limit: 300)
 *   createBashOutputCapHook(30)        → tool.execute.after  (truncate Bash output)
 *   createCodeGraphFirstHook()         → tool.execute.before (warn Grep before CodeGraph)
 *   createToolResultBudgetHook()       → tool.execute.after  (track cumulative output)
 *   createFireAndForgetHook()          → tool.execute.before (background long commands)
 *   onSessionEnd                       → session.idle        (cleanup)
 *   onPermissionDenied                 → permission.asked    (log denied calls)
 *   PreCompact / PostCompact           → session.compacted   (compaction lifecycle)
 *
 * Phase 5 enhancements:
 *   #8  shell.env       — Inject WORKSPACE_PATH, NODE_OPTIONS, GIT_TERMINAL_PROMPT
 *   #9  file.edited     — Reactive re-indexing notification
 *   #10 custom tools    — code_atelier_memory, code_atelier_plan, code_atelier_audit
 *   #17 command.executed — Track command history for compaction context
 *   #20 tui.toast.show  — Toast notifications for CodeGraph-first
 *
 * Phase 4B — OpenCode Evaluation: SDK hook migration.
 * Phase 5C — OpenCode Enhancement: Plugin hooks + custom tools.
 */

/**
 * Plugin type definitions — expanded to cover the full OpenCode plugin API.
 *
 * This file is loaded by OpenCode's plugin runtime at startup, NOT by
 * our Electron build. Types based on OpenCode's plugin API:
 * https://opencode.ai/docs/plugins
 */
interface PluginContext {
  /** Workspace directory */
  directory: string
  /** Full OpenCode SDK client — any session/command/file operation */
  client: OpencodeClient
  /** A-1: Current project metadata (name, path, etc.) */
  project: { name?: string; path?: string } | undefined
  /** A-1: Git worktree root — may differ from directory in multi-worktree setups */
  worktree: string | undefined
  /** Bun shell for command execution (typed as unknown — actually Bun's $ API) */
  shell: unknown
}

/**
 * A-2: Expanded SDK client type matching OpenCode's full plugin API surface.
 * Reference: https://opencode.ai/docs/sdk/
 */
interface OpencodeClient {
  /** Application-level APIs */
  app: {
    /** A-5: Structured logging — shows in OpenCode's log viewer */
    log: (opts: {
      body: {
        service: string
        level: 'debug' | 'info' | 'warn' | 'error'
        message: string
        /** A-5: Optional structured metadata for rich log filtering */
        extra?: Record<string, unknown>
      }
    }) => Promise<void>
    /** Discover loaded agents */
    agents: () => Promise<{ data?: Array<{ name: string; model?: string; mode?: string }> }>
  }
  /** Configuration access */
  config: {
    get: () => Promise<{ data?: Record<string, unknown> }>
    providers: () => Promise<{ data?: Array<{ id: string; name?: string; defaultModel?: string }> }>
  }
  /** Session management — full API */
  session: {
    create: (opts: unknown) => Promise<{ data?: { id: string } }>
    prompt: (opts: unknown) => Promise<unknown>
    abort: (opts: unknown) => Promise<void>
    revert: (opts: unknown) => Promise<void>
    unrevert: (opts: unknown) => Promise<void>
    summarize: (opts: unknown) => Promise<unknown>
    list: () => Promise<{ data?: Array<{ id: string; title?: string; status?: string }> }>
    get: (opts: { path: { id: string } }) => Promise<{ data?: Record<string, unknown> }>
    update: (opts: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
    delete: (opts: { path: { id: string } }) => Promise<void>
    children: (opts: { path: { id: string } }) => Promise<{ data?: Array<Record<string, unknown>> }>
    messages: (opts: { path: { id: string } }) => Promise<{ data?: Array<Record<string, unknown>> }>
    message: (opts: {
      path: { id: string; messageId: string }
    }) => Promise<{ data?: Record<string, unknown> }>
    command: (opts: {
      path: { id: string }
      body: { command: string; args?: string }
    }) => Promise<unknown>
    shell: (opts: {
      path: { id: string }
      body: { command: string }
    }) => Promise<{ data?: { stdout?: string; stderr?: string; exitCode?: number } }>
    share: (opts: { path: { id: string } }) => Promise<unknown>
    unshare: (opts: { path: { id: string } }) => Promise<void>
    init: (opts: { path: { id: string } }) => Promise<void>
  }
  /** Event subscription */
  event: {
    subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>
  }
  /** Server-side search */
  find: {
    text: (opts: {
      body: { query: string; path?: string }
    }) => Promise<{ data?: Array<{ path: string; line: number; content: string }> }>
    files: (opts: { body: { pattern: string } }) => Promise<{ data?: string[] }>
    symbols: (opts: {
      body: { query: string }
    }) => Promise<{ data?: Array<{ name: string; path: string; line: number }> }>
  }
  /** File operations */
  file: {
    read: (opts: { body: { path: string } }) => Promise<{ data?: { content: string } }>
    status: () => Promise<{ data?: Array<{ path: string; status: string }> }>
  }
  /** Auth management */
  auth: {
    set: (opts: { body: { provider: string; token: string } }) => Promise<void>
  }
  /** Health check */
  global: {
    health: () => Promise<{ data?: { version?: string } }>
  }
  /** TUI control (useful when debugging via OpenCode TUI) */
  tui: {
    showToast: (opts: {
      body: { message: string; variant?: 'info' | 'success' | 'warning' | 'error' }
    }) => Promise<void>
    setStatus: (opts: { body: { text: string } }) => Promise<void>
  }
}

interface PluginHookIO {
  tool?: string
  [key: string]: unknown
}

interface PluginHookOutput {
  args?: Record<string, unknown>
  output?: string
  context?: string[]
  decision?: string
  [key: string]: unknown
}

type PluginHook = (input: PluginHookIO, output: PluginHookOutput) => Promise<void>

/**
 * 6A-3: Tool helper type matching OpenCode's `tool()` plugin API (v1.15.1+).
 * Tools registered via `tool: { name: tool({...}) }` instead of the old
 * `tools: [{ name, parameters, execute }]` array format.
 */
interface ToolSchema {
  string: () => {
    describe: (d: string) => unknown
    optional: () => { describe: (d: string) => unknown }
  }
  enum: (values: string[]) => {
    describe: (d: string) => unknown
    optional: () => { describe: (d: string) => unknown }
  }
  number: () => {
    describe: (d: string) => unknown
    optional: () => { describe: (d: string) => unknown }
  }
  boolean: () => {
    describe: (d: string) => unknown
    optional: () => { describe: (d: string) => unknown }
  }
}

interface ToolContext {
  sessionID?: string
  directory?: string
  worktree?: string
}

interface ToolDef {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

/**
 * 6A-3: tool() helper factory — wraps tool definitions in OpenCode's expected format.
 * In real OpenCode runtime, this is imported from @opencode-ai/plugin.
 * We define it locally since the plugin file runs in OpenCode's Bun runtime.
 */
function tool(def: ToolDef): ToolDef {
  return def
}

/** 6A-3: Schema helpers for tool argument definitions */
tool.schema = {
  string: () => ({
    describe: (d: string) => ({ type: 'string', description: d }),
    optional: () => ({
      describe: (d: string) => ({ type: 'string', description: d, optional: true })
    })
  }),
  enum: (values: string[]) => ({
    describe: (d: string) => ({ type: 'string', enum: values, description: d }),
    optional: () => ({
      describe: (d: string) => ({ type: 'string', enum: values, description: d, optional: true })
    })
  }),
  number: () => ({
    describe: (d: string) => ({ type: 'number', description: d }),
    optional: () => ({
      describe: (d: string) => ({ type: 'number', description: d, optional: true })
    })
  }),
  boolean: () => ({
    describe: (d: string) => ({ type: 'boolean', description: d }),
    optional: () => ({
      describe: (d: string) => ({ type: 'boolean', description: d, optional: true })
    })
  })
} as ToolSchema

/** GAP-16: Instant TUI command definition */
interface PluginCommand {
  title: string
  description: string
  category?: string
  execute: (ctx: {
    client: OpencodeClient
    sessionId?: string
    toast: (opts: { message: string; variant?: 'info' | 'success' | 'warning' | 'error' }) => Promise<void>
  }) => Promise<void>
}

interface PluginResult {
  hooks: Record<string, PluginHook>
  tool?: Record<string, ToolDef>
  /** GAP-16: Instant TUI commands — execute without agent involvement */
  command?: Record<string, PluginCommand>
}

type Plugin = (ctx: PluginContext) => Promise<PluginResult>

import { resolve, sep } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// ── Constants ──

/** Max lines for unbounded Read calls */
const READ_LINE_LIMIT = 300

/** Max chars for Bash output (30 lines × 80 chars) */
const BASH_OUTPUT_CAP = 30 * 80

/** Tool result budget — max cumulative chars before nudging */
const TOOL_RESULT_BUDGET = 200_000

/** Commands that should be backgrounded (fire-and-forget) */
const FIRE_AND_FORGET_PATTERNS = [
  /npm run dev/,
  /npm start/,
  /yarn dev/,
  /pnpm dev/,
  /npx.*serve/,
  /python.*-m\s+http\.server/,
  /docker compose up/,
  /docker-compose up/
]

/** #17: Max command history entries to retain for compaction context */
const MAX_COMMAND_HISTORY = 50

/** 6A-1: Sentinel marker for system.transform verification */
const SYSTEM_SENTINEL = '<!-- CA_SYS_INJECTED -->'

/** 6A-1: Module-level flags for system prompt fallback path */
let systemTransformBroken = false
let systemTransformVerified = false
let systemPromptContent: string | null = null

/** 6B-1: Counter to prevent infinite stop verification loops */
let stopVerifyCount = 0

// ── Helper ──

function isWithinScope(targetPath: string, allowedCwd: string): boolean {
  const resolved = resolve(allowedCwd, targetPath)
  return resolved.startsWith(allowedCwd + sep) || resolved === allowedCwd
}

// ── IPC Bridge Client ──

/**
 * B-8: Response callback map for request-response IPC patterns.
 * Maps requestId → resolve function for pending responses.
 */
const pendingResponses = new Map<string, (data: unknown) => void>()

/** B-8: Response timeout for IPC request-response (ms) */
const IPC_RESPONSE_TIMEOUT = 5000

/**
 * Connect to the Electron main process via the IPC bridge Unix domain socket.
 * Falls back to console.log if the socket is unavailable (standalone OpenCode usage).
 *
 * B-8: Now supports bidirectional communication — listens for responses
 * from the main process and routes them to pending request callbacks.
 */
function createIpcClient(): {
  send: (event: { type: string; payload: unknown; requestId?: string }) => void
  request: (event: { type: string; payload: unknown }) => Promise<unknown>
  destroy: () => void
} {
  const socketPath = process.env.IPC_SOCKET_PATH
  if (!socketPath) {
    // No socket — fallback to console for standalone OpenCode usage
    return {
      send: (event) => console.log(JSON.stringify(event)),
      request: async () => null,
      destroy: () => {}
    }
  }

  let socket: Socket | null = null
  let connected = false
  const pending: string[] = []
  let responseBuffer = ''

  try {
    socket = createConnection(socketPath)
    socket.on('connect', () => {
      connected = true
      // Flush pending messages
      for (const msg of pending) {
        socket!.write(msg)
      }
      pending.length = 0
    })

    // B-8: Listen for responses from the main process
    socket.on('data', (data: Buffer) => {
      responseBuffer += data.toString('utf-8')

      let newlineIdx: number
      while ((newlineIdx = responseBuffer.indexOf('\n')) !== -1) {
        const line = responseBuffer.slice(0, newlineIdx).trim()
        responseBuffer = responseBuffer.slice(newlineIdx + 1)
        if (!line) continue

        try {
          const response = JSON.parse(line) as {
            requestId?: string
            type?: string
            payload?: unknown
          }
          if (response.requestId && pendingResponses.has(response.requestId)) {
            const resolve = pendingResponses.get(response.requestId)!
            pendingResponses.delete(response.requestId)
            resolve(response.payload)
          }
        } catch {
          // Ignore malformed responses
        }
      }
    })

    socket.on('error', (err) => {
      console.error(`[Code Atelier IPC] Socket error: ${err.message}`)
      connected = false
    })
    socket.on('close', () => {
      connected = false
      // Reject all pending responses on disconnect
      for (const [id, resolve] of pendingResponses) {
        resolve(null)
        pendingResponses.delete(id)
      }
    })
  } catch {
    // Socket connection failed — degrade gracefully
    return {
      send: (event) => console.log(JSON.stringify(event)),
      request: async () => null,
      destroy: () => {}
    }
  }

  return {
    send: (event) => {
      const line = JSON.stringify({ ...event, timestamp: Date.now() }) + '\n'
      if (connected && socket && !socket.destroyed) {
        socket.write(line)
      } else {
        pending.push(line)
      }
    },

    /**
     * B-8: Send a request and await a response from the main process.
     * Returns the payload of the response, or null on timeout.
     */
    request: (event) => {
      return new Promise<unknown>((resolveReq) => {
        const reqId = randomUUID()
        const timeout = setTimeout(() => {
          pendingResponses.delete(reqId)
          resolveReq(null)
        }, IPC_RESPONSE_TIMEOUT)

        pendingResponses.set(reqId, (payload) => {
          clearTimeout(timeout)
          resolveReq(payload)
        })

        const line = JSON.stringify({ ...event, requestId: reqId, timestamp: Date.now() }) + '\n'
        if (connected && socket && !socket.destroyed) {
          socket.write(line)
        } else {
          pending.push(line)
        }
      })
    },

    destroy: () => {
      if (socket && !socket.destroyed) {
        socket.destroy()
      }
    }
  }
}

// ── Plugin ──

export const CodeAtelierPlugin: Plugin = async (ctx) => {
  // A-1: Use worktree as the scope boundary when available.
  // In multi-worktree git setups, `worktree` is the actual file boundary,
  // while `directory` may be a subdirectory. This prevents submodule or
  // linked worktree paths from escaping the scope guard.
  const scopeRoot = ctx.worktree ?? ctx.directory
  const { directory, client } = ctx
  let cumulativeToolResultChars = 0
  let hasUsedCodeGraph = false
  // GAP-7: Track permission denials per session for mode-switch suggestion
  let permissionDenialCount = 0

  // D-2/A-5: Store client reference for structured logging.
  // Use client.app.log() instead of console.log() so messages show in
  // OpenCode's structured log viewer and TUI log panel.
  const log = {
    debug: (message: string, extra?: Record<string, unknown>) => {
      client.app
        .log({ body: { service: 'code-atelier', level: 'debug', message, extra } })
        .catch(() => {})
    },
    info: (message: string, extra?: Record<string, unknown>) => {
      client.app
        .log({ body: { service: 'code-atelier', level: 'info', message, extra } })
        .catch(() => {})
    },
    warn: (message: string, extra?: Record<string, unknown>) => {
      client.app
        .log({ body: { service: 'code-atelier', level: 'warn', message, extra } })
        .catch(() => {})
    },
    error: (message: string, extra?: Record<string, unknown>) => {
      client.app
        .log({ body: { service: 'code-atelier', level: 'error', message, extra } })
        .catch(() => {})
    }
  }

  // Connect to Electron main process via IPC bridge
  const ipc = createIpcClient()

  // #17: Command history for compaction context preservation
  const commandHistory: Array<{
    command: string
    timestamp: number
    exitCode?: number
  }> = []

  // #9: Track edited files for re-indexing notifications
  const editedFiles: Set<string> = new Set()

  return {
    hooks: {
      /**
       * 6E-4: config — Runtime adaptation hook.
       *
       * Adjusts OpenCode configuration based on runtime environment:
       *   - Ensures snapshots are always enabled
       *   - Injects IPC_SOCKET_PATH into shell.env programmatically
       *   - Validates provider connectivity
       */
      config: async (input) => {
        const cfg = input as Record<string, unknown>

        // Ensure snapshots are always enabled
        cfg.snapshot = true

        // Inject IPC socket path if available
        const shell = cfg.shell as Record<string, unknown> | undefined
        if (shell?.env && process.env.IPC_SOCKET_PATH) {
          ;(shell.env as Record<string, string>).IPC_SOCKET_PATH = process.env.IPC_SOCKET_PATH
        }

        // Log configuration confirmation
        log.debug('Config hook applied', {
          extra: { snapshot: true, hasIpcSocket: !!process.env.IPC_SOCKET_PATH }
        })
      },

      /**
       * 6B-5: chat.params — Dynamic temperature based on message intent.
       *
       * Code generation/implementation → temperature 0.2 (precision)
       * Brainstorming/exploring options → temperature 0.7 (creativity)
       * Planning/analysis → temperature 0.4 (balanced)
       */
      'chat.params': async (input, output) => {
        const parts = (input as Record<string, unknown>).parts as
          | Array<Record<string, unknown>>
          | undefined
        const firstText = parts?.find((p) => p.type === 'text')?.text as string | undefined
        if (!firstText) return

        const codeKeywords = /\b(implement|write|create|fix|refactor|add|build|code|migrate)\b/i
        const planKeywords = /\b(plan|analyze|review|audit|explain|how does|compare|evaluate)\b/i
        const brainstormKeywords =
          /\b(brainstorm|ideas|suggest|explore|what if|alternatives|options)\b/i

        if (codeKeywords.test(firstText)) {
          ;(output as Record<string, unknown>).temperature = 0.2
        } else if (brainstormKeywords.test(firstText)) {
          ;(output as Record<string, unknown>).temperature = 0.7
        } else if (planKeywords.test(firstText)) {
          ;(output as Record<string, unknown>).temperature = 0.4
        }
      },

      /**
       * 6B-2: chat.message — Input transformation hook.
       *
       * Transformations:
       *   1. Secret stripping: redacts API keys from user messages
       *   2. System prompt fallback: injects system prompt as user-message
       *      when system.transform is broken (detected by 6A-1)
       */
      'chat.message': async (_input, output) => {
        const parts = (output as Record<string, unknown>).parts as
          | Array<Record<string, unknown>>
          | undefined
        if (!parts) return

        // Secret stripping — prevent accidental credential exposure
        const secretPatterns = [
          /sk-[a-zA-Z0-9]{20,}/g,
          /ghp_[a-zA-Z0-9]{36}/g,
          /AKIA[A-Z0-9]{16}/g,
          /xox[baprs]-[a-zA-Z0-9-]+/g
        ]
        // GAP-4: Removed the `pattern.test()` guard — test() advances lastIndex on
        // global regex, causing the subsequent replace() to miss the second match.
        // Just call replace() unconditionally (it's a no-op if no match) and check
        // if the string actually changed to decide whether to log.
        for (const part of parts) {
          if (part.type === 'text' && typeof part.text === 'string') {
            for (const pattern of secretPatterns) {
              pattern.lastIndex = 0
              const original = part.text as string
              part.text = original.replace(pattern, '[REDACTED]')
              if (part.text !== original) {
                log.warn('Stripped potential secret from user message')
              }
            }
          }
        }

        // 6A-1 fallback: inject system prompt as user-message if transform is broken
        if (systemTransformBroken && systemPromptContent) {
          parts.unshift({
            type: 'text',
            text: `[System Instructions]\n${systemPromptContent}`
          })
        }
      },

      /**
       * tool.execute.before — Pre-tool-use hooks.
       *
       * Implements:
       *   - Scope guard (block Write/Edit/Read/Glob/Grep/Bash outside workspace)
       *   - Read line limit injection
       *   - Code Graph first enforcement (warn before Grep/Glob/Read for code)
       *   - Fire-and-forget for long-running commands
       */
      'tool.execute.before': async (input, output) => {
        const tool = input.tool as string
        const args = output.args as Record<string, unknown>

        // ── Scope Guard ──
        if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
          const filePath = args.file_path as string | undefined
          if (filePath && !isWithinScope(filePath, scopeRoot)) {
            throw new Error(`Blocked: ${tool} outside workspace scope: ${filePath}`)
          }
        }

        // A-3: apply_patch scope guard — GPT-5+ models substitute apply_patch for
        // Edit/Write. Paths are embedded in marker lines, not in args.file_path.
        if (tool === 'apply_patch') {
          const patchText = args.patchText as string | undefined
          if (patchText) {
            // Parse marker lines: *** Add File: path, *** Update File: path,
            // *** Move to: path, *** Delete File: path
            const markerPattern = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm
            const movePattern = /^\*\*\*\s+Move\s+to:\s+(.+)$/gm
            const allPaths: string[] = []

            let match: RegExpExecArray | null
            while ((match = markerPattern.exec(patchText)) !== null) {
              allPaths.push(match[1].trim())
            }
            while ((match = movePattern.exec(patchText)) !== null) {
              allPaths.push(match[1].trim())
            }

            for (const targetPath of allPaths) {
              if (!isWithinScope(targetPath, scopeRoot)) {
                throw new Error(
                  `Blocked: apply_patch references file outside workspace scope: ${targetPath}`
                )
              }
            }
          }
        }

        if (tool === 'Read') {
          const filePath = args.file_path as string | undefined
          if (filePath && !isWithinScope(filePath, scopeRoot)) {
            throw new Error(`Blocked: Read outside workspace: ${filePath}`)
          }
          // ── Read Line Limit ──
          if (!args.limit) {
            args.limit = READ_LINE_LIMIT
          }
        }

        if (tool === 'Glob' || tool === 'Grep') {
          const searchPath = args.path as string | undefined
          if (searchPath && !isWithinScope(searchPath, scopeRoot)) {
            throw new Error(`Blocked: ${tool} outside workspace: ${searchPath}`)
          }
        }

        if (tool === 'Bash') {
          const command = args.command as string | undefined
          if (command) {
            // ── Scope check for Bash ──
            const dangerousPatterns = [/\.\.\//, /cd\s+\.\./]
            const hasDangerous = dangerousPatterns.some((p) => p.test(command))
            if (hasDangerous) {
              // Check if path arguments escape workspace
              const pathMatches = command.match(/(?:cat|less|head|tail|find|ls)\s+(\S+)/g)
              if (pathMatches) {
                for (const match of pathMatches) {
                  const arg = match.split(/\s+/).pop()
                  if (arg && !isWithinScope(arg, scopeRoot)) {
                    throw new Error(
                      `Blocked: Bash references files outside workspace. Stay within ${scopeRoot}`
                    )
                  }
                }
              }
            }

            // ── Fire-and-Forget ──
            const shouldBackground = FIRE_AND_FORGET_PATTERNS.some((p) => p.test(command))
            if (shouldBackground && !command.includes('&')) {
              args.command = `${command} &`
            }
          }
        }

        // ── Code Graph First ──
        if (
          [
            'graph_map',
            'search_identifiers',
            'find_callers',
            'find_callees',
            'find_references',
            'file_outline',
            'file_dependencies'
          ].includes(tool)
        ) {
          hasUsedCodeGraph = true
        }

        if (['Grep', 'Glob', 'Read'].includes(tool) && !hasUsedCodeGraph) {
          if (tool === 'Grep' && args.pattern && typeof args.pattern === 'string') {
            // 6E-1: Use find.symbols() to check if pattern is a known identifier
            const isIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.pattern)
            if (isIdentifier) {
              try {
                const symbols = await client.find.symbols({ body: { query: args.pattern } })
                const count = symbols.data?.length ?? 0
                if (count > 0) {
                  log.info(
                    `💡 Found ${count} symbol(s) matching "${args.pattern}" — ` +
                      `consider using search_identifiers or find_references for structured results.`
                  )
                }
              } catch {
                // Non-fatal — find.symbols() may not be available
              }
            } else {
              // D-2: Generic CodeGraph-first suggestion for non-identifier patterns
              log.info(
                '💡 Consider using CodeGraph tools (search_identifiers, find_callers, ' +
                  'find_references, file_outline) before Grep for code navigation. ' +
                  'They provide structured results with cross-references.'
              )
            }
          }
        }
      },

      /**
       * tool.execute.after — Post-tool-use hooks.
       *
       * Implements:
       *   - Bash output cap (truncate to last 30 lines)
       *   - Tool result budget tracking
       *   - #17: Command execution tracking
       */
      'tool.execute.after': async (input, output) => {
        const tool = input.tool as string
        const result = output.output as string | undefined

        if (!result) return

        // ── Bash Output Cap ──
        if (tool === 'Bash' && result.length > BASH_OUTPUT_CAP) {
          const truncated = result.slice(-BASH_OUTPUT_CAP)
          const removedLines = result.slice(0, -BASH_OUTPUT_CAP).split('\n').length
          output.output = `[... ${removedLines} lines truncated ...]\n${truncated}`
        }

        // #17: Track command execution for compaction context
        if (tool === 'Bash') {
          const command = (output.args as Record<string, unknown>)?.command as string | undefined
          if (command) {
            commandHistory.push({
              command,
              timestamp: Date.now(),
              exitCode: (output as Record<string, unknown>).exitCode as number | undefined
            })
            // Keep history bounded
            if (commandHistory.length > MAX_COMMAND_HISTORY) {
              commandHistory.shift()
            }
          }
        }

        // 6C-3: Track apply_patch file edits (same as Write/Edit tracking)
        if (tool === 'apply_patch') {
          const patchText = (output.args as Record<string, unknown>)?.patchText as
            | string
            | undefined
          if (patchText) {
            const markerPattern = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm
            let match: RegExpExecArray | null
            while ((match = markerPattern.exec(patchText)) !== null) {
              const filePath = match[1].trim()
              editedFiles.add(filePath)
              ipc.send({ type: 'fileEdited', payload: { path: filePath } })
            }
          }
        }

        // ── Tool Result Budget ──
        cumulativeToolResultChars += (result as string).length
        if (cumulativeToolResultChars > TOOL_RESULT_BUDGET) {
          if (result.length > BASH_OUTPUT_CAP) {
            output.output =
              result.slice(0, BASH_OUTPUT_CAP) +
              '\n\n[Tool result budget exceeded. Use more targeted queries.]'
          }
          // Reset after warning
          cumulativeToolResultChars = 0
        }
      },

      /**
       * #8: shell.env — Inject environment variables into all Bash tool executions.
       *
       * Sets WORKSPACE_PATH, NODE_OPTIONS, GIT_TERMINAL_PROMPT so the agent's
       * shell commands have consistent context without manual setup.
       */
      'shell.env': async (_input, output) => {
        const env = (output as Record<string, Record<string, string>>).env ?? {}

        // Workspace path for tool scripts
        env.WORKSPACE_PATH = directory

        // Prevent OOM in heavy Node.js tasks spawned by the agent
        if (!env.NODE_OPTIONS) {
          env.NODE_OPTIONS = '--max-old-space-size=4096'
        }

        // Prevent interactive git prompts from hanging the agent
        env.GIT_TERMINAL_PROMPT = '0'

        // Disable telemetry in npm/yarn that might interfere
        env.DO_NOT_TRACK = '1'
        ;(output as Record<string, Record<string, string>>).env = env
      },

      /**
       * #9: file.edited — Reactive re-indexing notification.
       *
       * When the agent modifies a file, notify the main process so Code Graph
       * and Semantic Search can re-index immediately instead of waiting for
       * the file watcher to catch up.
       */
      'file.edited': async (input) => {
        const filePath = (input as Record<string, unknown>).path as string | undefined
        if (filePath) {
          editedFiles.add(filePath)
          // Notify main process via IPC bridge for reactive re-indexing
          ipc.send({
            type: 'fileEdited',
            payload: { path: filePath }
          })
        }
      },

      /**
       * #17: command.executed — Track command history for compaction context.
       *
       * After compaction, the AI loses track of what commands were run.
       * This hook captures the history so it can be re-injected.
       */
      'command.executed': async (input) => {
        const command = (input as Record<string, unknown>).command as string | undefined
        const exitCode = (input as Record<string, unknown>).exitCode as number | undefined
        if (command) {
          commandHistory.push({
            command,
            timestamp: Date.now(),
            exitCode
          })
          if (commandHistory.length > MAX_COMMAND_HISTORY) {
            commandHistory.shift()
          }
        }
      },

      /**
       * 6B-3: permission.ask — Decision hook for auto-resolving permissions.
       *
       * Build mode: allow ALL tools (no IPC round-trip needed).
       * Plan mode: allow read-only tools, deny writes, forward Bash to IPC.
       */
      'permission.ask': async (input, output) => {
        const toolName = input.tool as string | undefined
        if (!toolName) return
        const mode = process.env.CONVERSATION_MODE

        // Build mode — full auto-approve
        if (mode === 'build') {
          ;(output as Record<string, unknown>).status = 'allow'
          return
        }

        // Plan mode — granular decisions
        const readOnly = new Set([
          'Read',
          'Glob',
          'Grep',
          'search_identifiers',
          'find_callers',
          'find_callees',
          'find_references',
          'file_outline',
          'file_dependencies',
          'graph_map',
          'semantic_search',
          'similar_code',
          'codebase_concepts',
          'git_log',
          'git_diff',
          'git_blame',
          'git_show',
          'todowrite',
          'checkpoint_list',
          'checkpoint_diff'
        ])

        if (readOnly.has(toolName)) {
          ;(output as Record<string, unknown>).status = 'allow'
          return
        }

        if (['Write', 'Edit', 'MultiEdit', 'apply_patch'].includes(toolName)) {
          ;(output as Record<string, unknown>).status = 'deny'
          return
        }

        // Bash and other ambiguous tools: forward to IPC for user decision
        // (do not set output.status — OpenCode will wait for external response)
      },

      /**
       * permission.asked — Observation hook for permission events.
       *
       * Logs permission decisions and forwards write-tool requests to the
       * Electron UI via IPC bridge for user confirmation.
       */
      'permission.asked': async (input, output) => {
        const tool = input.tool as string | undefined
        if (!tool) return

        // Read-only tools are always safe to auto-approve
        const READ_ONLY_TOOLS = new Set([
          'Read',
          'Glob',
          'Grep',
          'search_identifiers',
          'find_callers',
          'find_callees',
          'find_references',
          'file_outline',
          'file_dependencies',
          'graph_map'
        ])

        if (READ_ONLY_TOOLS.has(tool)) {
          output.decision = 'allow'
          return
        }

        // For write tools, pipe the permission request to the Electron UI via IPC bridge.
        // The main process will show a modal and respond with allow/deny.
        // Meanwhile, we do NOT set output.decision — OpenCode will wait for the
        // postSessionByIdPermissionsByPermissionId() API call from our main process.
        const permissionId = (input as Record<string, unknown>).permissionId as string | undefined
        const args = (input as Record<string, unknown>).args as Record<string, unknown> | undefined
        ipc.send({
          type: 'permission',
          payload: {
            tool,
            permissionId,
            args,
            message: `Agent wants to use ${tool}`
          }
        })
      },

      /**
       * session.idle — Cleanup on session completion.
       */
      'session.idle': async () => {
        // Reset per-session state
        cumulativeToolResultChars = 0
        hasUsedCodeGraph = false
        // GAP-2: Reset stop verification counter so future sessions can run typecheck
        stopVerifyCount = 0
        // GAP-7: Reset permission denial counter
        permissionDenialCount = 0

        // #9: Send edited files summary to main process for re-indexing
        if (editedFiles.size > 0) {
          ipc.send({
            type: 'fileEdited',
            payload: {
              summary: true,
              files: Array.from(editedFiles),
              count: editedFiles.size
            }
          })
          editedFiles.clear()
        }
      },

      /**
       * 6A-1: session.created — Verify that system.transform hook is working.
       *
       * After a short delay, reads back the session messages and checks for
       * the sentinel marker. If missing, activates the fallback path which
       * injects the system prompt as a user-message part via chat.message.
       */
      'session.created': async (input) => {
        const sid = (input as Record<string, unknown>).sessionID as string
        if (!sid) return

        // GAP-3: If a previous session flagged systemTransformBroken, re-verify
        // on each new session. This gives the system a chance to self-heal if
        // a future OpenCode update fixes the bug.
        if (systemTransformBroken && systemTransformVerified) {
          systemTransformVerified = false
        }

        if (systemTransformVerified) return

        setTimeout(async () => {
          try {
            const msgs = await client.session.messages({ path: { id: sid } })
            const systemMsg = msgs.data?.[0]
            const hasMarker = JSON.stringify(systemMsg).includes('CA_SYS_INJECTED')
            if (hasMarker) {
              // System transform is working (or has been fixed)
              if (systemTransformBroken) {
                log.info('system.transform hook recovered — switching back to native injection')
                systemTransformBroken = false
              }
            } else {
              systemTransformBroken = true
              log.warn('system.transform hook is broken — falling back to user-message injection')
            }
            systemTransformVerified = true
          } catch {
            // Non-fatal — verification is best-effort
          }
        }, 2000)
      },

      /**
       * D-4: session.deleted — Clean up per-session state on deletion.
       * Without this, state (editedFiles, commandHistory, cumulative counters)
       * accumulates if sessions are created and deleted without going idle.
       */
      'session.deleted': async () => {
        cumulativeToolResultChars = 0
        hasUsedCodeGraph = false
        editedFiles.clear()
        commandHistory.length = 0
        // GAP-2: Reset stop verification counter on session deletion
        stopVerifyCount = 0
        // GAP-7: Reset permission denial counter
        permissionDenialCount = 0
      },

      /**
       * session.compacted — Compaction lifecycle.
       * Injects Code Atelier-specific context into the compaction summary.
       * #17: Also injects command history so the AI remembers what was run.
       */
      'experimental.session.compacting': async (_input, output) => {
        const contextEntries = output.context as string[] | undefined
        if (contextEntries) {
          contextEntries.push(
            '## Code Atelier Context\n' +
              'Preserve: file paths modified, key decisions, plan state, ' +
              'error patterns, workspace conventions.\n' +
              'Discard: verbatim file contents, intermediate search results, ' +
              'tool outputs already acted upon.'
          )

          // #17: Inject recent command history into compaction context
          if (commandHistory.length > 0) {
            const recentCommands = commandHistory
              .slice(-10) // Last 10 commands
              .map(
                (h) =>
                  `- \`${h.command}\` (${h.exitCode === 0 ? '✓' : `exit ${h.exitCode ?? '?'}`})`
              )
              .join('\n')
            contextEntries.push(`## Recent Commands\n${recentCommands}`)
          }
        }
      },

      /**
       * D-1: experimental.chat.system.transform — Inject our system prompt into
       * the REAL system prompt position instead of prepending as a user message.
       *
       * LLMs give significantly more authority to system prompt instructions vs
       * user message instructions. The CODE_ATELIER_SYSTEM_PROMPT env var is set
       * by the executor via shell.env before starting the session.
       */
      'experimental.chat.system.transform': async (_input, output) => {
        // D-1: Read system prompt from file (env var path set by config writer)
        // to avoid env var size limits (system prompts can be 10KB+).
        const promptFile = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
        if (promptFile) {
          try {
            const systemPrompt = readFileSync(promptFile, 'utf-8')
            if (systemPrompt) {
              // 6A-1: Cache the system prompt content for fallback injection
              systemPromptContent = systemPrompt

              const existingSystem = (output as Record<string, unknown>).system as
                | string
                | undefined
              // 6A-1: Inject sentinel marker for verification
              ;(output as Record<string, unknown>).system = existingSystem
                ? `${existingSystem}\n\n${systemPrompt}\n${SYSTEM_SENTINEL}`
                : `${systemPrompt}\n${SYSTEM_SENTINEL}`
            }
          } catch {
            // Non-fatal — system prompt file may not exist yet
          }
        }
      },

      /**
       * 6B-4: event — Generic event handler for forward compatibility.
       *
       * Logs all events via structured logging and forwards unknown event
       * types to the IPC bridge so the main process can react to future
       * OpenCode features without plugin updates.
       */
      event: async (input) => {
        const event = input as Record<string, unknown>
        const type = event.type as string | undefined
        if (!type) return

        log.debug(`Event: ${type}`, { extra: event })

        // Forward unknown events to main process for future handling
        const knownTypes = new Set([
          'session.created',
          'session.idle',
          'session.error',
          'session.compacted',
          'session.deleted',
          'session.updated',
          'session.diff',
          'session.status',
          'message.part.updated',
          'message.part.removed',
          'message.removed',
          'message.updated',
          'tool.execute.before',
          'tool.execute.after',
          'permission.asked',
          'permission.replied',
          'permission.ask',
          'file.edited',
          'file.watcher.updated',
          'lsp.client.diagnostics',
          'lsp.updated',
          'todo.updated',
          'command.executed',
          'server.connected',
          'installation.updated',
          'chat.message',
          'chat.params',
          'stop',
          'experimental.chat.system.transform',
          'experimental.session.compacting'
        ])

        if (!knownTypes.has(type)) {
          ipc.send({ type: 'unknown_event', payload: { eventType: type, event } })
        }
      },

      /**
       * 6B-1: stop — Build-mode completion verification.
       *
       * Before allowing the session to end in build mode, runs a quick
       * typecheck to catch regressions. If errors are found, sends a
       * continuation prompt asking the agent to fix them.
       *
       * Guards:
       *   - Only fires in build mode
       *   - Only if .ts/.tsx files were edited
       *   - Max 2 verification rounds to prevent infinite loops
       */
      stop: async (input) => {
        if (process.env.CONVERSATION_MODE !== 'build') return
        if (stopVerifyCount >= 2) return
        if (editedFiles.size === 0) return

        const hasTsChanges = [...editedFiles].some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
        if (!hasTsChanges) return

        const sid = (input as Record<string, unknown>).sessionID as string
        if (!sid) return

        try {
          const result = await client.session.shell({
            path: { id: sid },
            body: { command: 'npx tsc --noEmit 2>&1 | tail -10' }
          })
          if (result.data?.exitCode !== 0 && result.data?.stdout) {
            stopVerifyCount++
            await client.session.prompt({
              path: { id: sid },
              body: {
                parts: [
                  {
                    type: 'text',
                    text: `Type errors detected — please fix before finishing:\n\`\`\`\n${result.data.stdout}\n\`\`\``
                  }
                ]
              }
            })
          }
        } catch {
          // Non-fatal — typecheck verification is best-effort
        }
      },

      /**
       * #20: tui.toast.show — Display toast notifications in the OpenCode TUI.
       *
       * Currently used for CodeGraph-first suggestions. The toast is visible
       * if the user is watching the OpenCode TUI directly (e.g. debugging).
       */
      'tui.toast.show': async (input) => {
        const message = (input as Record<string, unknown>).message as string | undefined
        if (message) {
          log.info(`Toast: ${message}`)
        }
      },

      /**
       * GAP-5: tui.prompt.append — Agent-to-prompt injection hook.
       *
       * When the user triggers /plan or /audit commands, pre-fills context
       * from our memory system or recent git changes. Also injects helpful
       * context for empty prompts when edited files exist.
       */
      'tui.prompt.append': async (_input, output) => {
        const currentPrompt = (output as Record<string, unknown>).text as string | undefined

        // If the prompt starts with a slash command, inject relevant context
        if (currentPrompt?.startsWith('/plan') && editedFiles.size > 0) {
          const fileList = [...editedFiles].slice(0, 10).join(', ')
          ;(output as Record<string, unknown>).text =
            `${currentPrompt}\n\n[Context: Recently edited files: ${fileList}]`
        }

        if (currentPrompt?.startsWith('/audit')) {
          // Fetch workspace status from memory to pre-fill context
          const status = (await ipc.request({
            type: 'memory',
            payload: { action: 'status' }
          })) as { count?: number } | null
          if (status?.count) {
            ;(output as Record<string, unknown>).text =
              `${currentPrompt}\n\n[Context: ${status.count} memories, ${editedFiles.size} files edited this session]`
          }
        }
      },

      /**
       * GAP-6: tui.command.execute — Custom TUI command interception.
       *
       * Fires when a /command is executed in the TUI. Logs command
       * execution for debugging and forwards to IPC for tracking.
       */
      'tui.command.execute': async (input) => {
        const command = (input as Record<string, unknown>).command as string | undefined
        const args = (input as Record<string, unknown>).args as string | undefined
        if (command) {
          log.info(`TUI command: /${command}${args ? ` ${args}` : ''}`)
          ipc.send({
            type: 'tuiCommand',
            payload: { command, args, timestamp: Date.now() }
          })
        }
      },

      /**
       * GAP-7: permission.replied — Track permission decision outcomes.
       *
       * Fires AFTER a permission decision is made (allow/deny). Tracks
       * denied tool calls per session and auto-suggests switching to Build
       * mode after repeated denials in Plan mode.
       */
      'permission.replied': async (input) => {
        const toolName = input.tool as string | undefined
        const allowed = (input as Record<string, unknown>).allowed as boolean | undefined

        if (!toolName) return

        // Track decision for audit trail
        ipc.send({
          type: 'permissionDecision',
          payload: {
            tool: toolName,
            allowed: allowed ?? false,
            timestamp: Date.now()
          }
        })

        // Count denials — suggest mode switch after 3+ in plan mode
        if (allowed === false) {
          permissionDenialCount++
          log.info(`Permission denied for ${toolName} (${permissionDenialCount} total denials)`)

          if (
            permissionDenialCount >= 3 &&
            process.env.CONVERSATION_MODE === 'plan'
          ) {
            try {
              await client.tui.showToast({
                body: {
                  message: `${permissionDenialCount} tool calls denied — consider switching to Build mode`,
                  variant: 'warning'
                }
              })
            } catch {
              // Non-fatal — toast is best-effort
            }
          }
        }
      }
    }

    // GAP-1 (Phase 8): Inline tool definitions removed.
    // Standalone .opencode/tools/{memory,plan,audit}.ts are the single source of truth.
    // They use the real `import { tool } from '@opencode-ai/plugin'` (not our shim),
    // have proper Zod schemas, and connect IPC per-invocation (no stale socket).
    // Keeping tools out of the plugin avoids duplicating 3 tool schemas in the context window.

    // GAP-16: Instant TUI commands — execute without agent involvement.
    // These run pure plugin code with access to the SDK client.
    command: {
      'ca:reindex': {
        title: 'Re-index Code Graph',
        description: 'Trigger immediate code graph re-indexing without an agent call',
        category: 'Code Atelier',
        execute: async ({ toast }) => {
          ipc.send({ type: 'reindex', payload: { force: true } })
          await toast({ message: 'Code Graph re-indexing started', variant: 'info' })
        }
      },
      'ca:status': {
        title: 'Workspace Status',
        description: 'Show workspace health summary from memory cache',
        category: 'Code Atelier',
        execute: async ({ toast }) => {
          const memories = (await ipc.request({
            type: 'memory',
            payload: { action: 'status' }
          })) as { count?: number } | null
          await toast({
            message: `${memories?.count ?? 0} memories, ${editedFiles.size} edits this session`,
            variant: 'info'
          })
        }
      },
      'ca:compact': {
        title: 'Force Compact',
        description: 'Force context compaction with Code Atelier context preservation',
        category: 'Code Atelier',
        execute: async ({ client: c, sessionId, toast }) => {
          if (!sessionId) {
            await toast({ message: 'No active session', variant: 'warning' })
            return
          }
          try {
            await c.session.command({
              path: { id: sessionId },
              body: { command: 'compact' }
            })
            await toast({ message: 'Compaction triggered', variant: 'success' })
          } catch {
            await toast({ message: 'Compaction failed', variant: 'error' })
          }
        }
      },
      'ca:mode': {
        title: 'Switch Mode',
        description: 'Switch between plan and build mode via IPC',
        category: 'Code Atelier',
        execute: async ({ toast }) => {
          const current = process.env.CONVERSATION_MODE ?? 'plan'
          const next = current === 'plan' ? 'build' : 'plan'
          ipc.send({
            type: 'modeSwitch',
            payload: { from: current, to: next }
          })
          await toast({ message: `Mode switched to ${next}`, variant: 'info' })
        }
      }
    }
  }
}

export default CodeAtelierPlugin

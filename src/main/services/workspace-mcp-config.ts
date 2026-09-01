import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { MCP_TOOLS, EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'
import { buildModePermissions } from './mode-permissions'
import { missingCredentials, resolveIntegrationEnv } from './integration-credentials'
import type { ContextWindowTier } from './context-management'
import { TIER_LIMITS } from './context-management'
import { chatAgentLogger } from '../logger'

/**
 * MCP server config for stdio-based external servers.
 * Replaces the SDK's McpServerConfig type with a local definition.
 */
export interface McpServerConfig {
  type?: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  alwaysLoad?: boolean
}

/**
 * Essential code-graph tools for small-tier models (6 tools instead of 13).
 * These cover the core navigation workflow without bloating the 32K window.
 */
const ESSENTIAL_CODE_GRAPH_TOOLS = [
  MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name,
  MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name,
  MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.name,
  MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.name,
  MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.name,
  MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name
] as const

/**
 * Feature flag state for MCP configuration.
 * Passed as a snapshot so the builder has no dependency on workspace settings.
 */
export interface McpFeatureFlags {
  repomapEnabled: boolean
  semanticSearchEnabled: boolean
  githubConfigured: boolean
  /** External MCPs active for this specific message (e.g. { maestro: true }) */
  externalMcpActive?: Record<string, boolean>
  /** Per-chat local MCP overrides. Absent key = enabled (backward-compat). false = disabled. */
  localMcpActive: Record<string, boolean>
}

/**
 * Result of building MCP configuration for the executor.
 *
 * The `mcpServers` dict now contains only external MCP stdio configs (Maestro, etc.).
 * Local MCP servers (code-graph, semantic-search, control-actions, etc.) are
 * configured externally via McpConfigWriter for CLI and via OpenCode's own config.
 */
export interface McpConfigResult {
  mcpServers?: Record<string, McpServerConfig>
  allowedTools?: string[]
  disallowedTools: string[]
  /** Whether code-analysis tools are available — drives prompt guidance gating */
  codeAnalysisEnabled: boolean
}

/**
 * Check whether a local MCP server is enabled for this chat.
 * Missing key → enabled (backward-compatible default).
 */
function isLocalMcpEnabled(
  serverId: string,
  localMcpActive: Record<string, boolean> | undefined
): boolean {
  if (!localMcpActive) return true
  return localMcpActive[serverId] !== false
}

/**
 * Resolve a stdio command to an absolute path.
 * Checks known install paths first (handles packaged macOS apps where
 * GUI PATH is minimal). Falls back to the bare command name for PATH lookup.
 */
function resolveStdioCommand(command: string, knownPaths?: readonly string[]): string {
  if (knownPaths) {
    for (const p of knownPaths) {
      const resolved = p.replace(/^~/, homedir())
      const found = existsSync(resolved)
      chatAgentLogger.info(
        `[mcp:resolve-command] Checking ${resolved} → ${found ? 'EXISTS' : 'NOT FOUND'}`
      )
      if (found) return resolved
    }
  }
  // SVC-04: In packaged apps, don't fall back to bare command — the minimal
  // GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin) could resolve a trojan binary.
  if (app.isPackaged) {
    chatAgentLogger.error(
      `[mcp:resolve-command] Command "${command}" not found at any known path — refusing bare fallback in packaged mode`
    )
    throw new Error(`MCP command not found: ${command}`)
  }
  chatAgentLogger.info(`[mcp:resolve-command] Falling back to bare command: ${command}`)
  return command
}

/**
 * Known Homebrew Java installation paths (macOS arm64 + x86_64).
 * Checked in order — first existing directory wins.
 */
const KNOWN_JAVA_PATHS = [
  '/opt/homebrew/opt/openjdk@21', // Homebrew arm64 — Java 21
  '/opt/homebrew/opt/openjdk@17', // Homebrew arm64 — Java 17
  '/opt/homebrew/opt/openjdk', // Homebrew arm64 — latest
  '/usr/local/opt/openjdk@21', // Homebrew x86_64 — Java 21
  '/usr/local/opt/openjdk@17', // Homebrew x86_64 — Java 17
  '/usr/local/opt/openjdk' // Homebrew x86_64 — latest
] as const

/**
 * Resolve JAVA_HOME for packaged macOS apps where the shell profile
 * isn't loaded and Homebrew isn't on PATH.
 *
 * Strategy:
 * 1. Return `process.env.JAVA_HOME` if already set
 * 2. Probe known Homebrew install paths (fastest — no subprocess)
 * 3. Try `/usr/libexec/java_home -v 17+` as a last resort
 */
function resolveJavaHome(): string | undefined {
  // Already set — use it
  if (process.env.JAVA_HOME) {
    // SVC-05: Validate that JAVA_HOME actually contains bin/java
    const javaBin = join(process.env.JAVA_HOME, 'bin', 'java')
    if (existsSync(javaBin)) {
      return process.env.JAVA_HOME
    }
    chatAgentLogger.warn(
      `[mcp:java-resolve] JAVA_HOME=${process.env.JAVA_HOME} has no bin/java — ignoring`
    )
  }

  // Probe known Homebrew paths
  for (const p of KNOWN_JAVA_PATHS) {
    // SVC-05: Verify bin/java exists, not just the directory
    const javaBin = join(p, 'bin', 'java')
    if (existsSync(javaBin)) {
      chatAgentLogger.info(`[mcp:java-resolve] Found Java at ${p}`)
      return p
    }
  }

  // Fallback: ask macOS for any Java 17+
  try {
    const result = execFileSync('/usr/libexec/java_home', ['-v', '17+'], {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
    if (result && existsSync(result)) {
      chatAgentLogger.info(`[mcp:java-resolve] Found Java via java_home: ${result}`)
      return result
    }
  } catch (e) {
    chatAgentLogger.debug('[mcp:java-resolve] java_home lookup failed (non-fatal):', e)
  }

  chatAgentLogger.warn('[mcp:java-resolve] No Java 17+ found — Maestro may fail to start')
  return undefined
}

/**
 * Resolve the directory holding the bundled MCP server scripts (packaged vs dev).
 */
function resolveMcpServerBasePath(): string {
  return app.isPackaged
    ? join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'out', 'main', 'mcp-servers')
    : join(__dirname, 'mcp-servers')
}

/**
 * Enrich a resolved integration environment for an external MCP stdio process.
 *
 * `baseEnv` already carries the credential/shell values from
 * {@link resolveIntegrationEnv}. In packaged macOS apps the GUI process inherits
 * only a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so this helper also:
 * 1. Auto-resolves JAVA_HOME from Homebrew / macOS java_home
 * 2. Injects Homebrew bin directories and JAVA_HOME/bin into PATH
 *    so child processes can find `java`, `npx`, `node`, etc.
 */
function buildStdioEnv(
  envKeys: readonly string[] | undefined,
  baseEnv: Record<string, string>
): Record<string, string> | undefined {
  if (!envKeys?.length && !app.isPackaged && Object.keys(baseEnv).length === 0) return undefined

  const env: Record<string, string> = { ...baseEnv }

  // Auto-resolve JAVA_HOME if requested but not set
  if (envKeys?.includes('JAVA_HOME') && !env.JAVA_HOME) {
    const javaHome = resolveJavaHome()
    if (javaHome) env.JAVA_HOME = javaHome
  }

  // In packaged apps, enrich PATH with common tool directories
  if (app.isPackaged) {
    const extraPaths: string[] = []

    // Add JAVA_HOME/bin if resolved
    if (env.JAVA_HOME) {
      extraPaths.push(`${env.JAVA_HOME}/bin`)
    }

    // Add common Homebrew paths
    // SEC-01: Removed ~/.maestro/bin — user-writable directory enables executable
    // hijacking. Maestro users should have it in their system PATH.
    extraPaths.push(
      '/opt/homebrew/bin', // Homebrew arm64
      '/usr/local/bin' // Homebrew x86_64 + system tools
    )

    const basePath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
    env.PATH = [...extraPaths, basePath].join(':')

    chatAgentLogger.info(`[mcp:stdio-env] Enriched PATH for packaged app: ${env.PATH}`)
  }

  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * Mount external MCP stdio servers based on per-message activation flags.
 * Shared between local LLM and Claude code paths.
 *
 * Key behaviors:
 * - `alwaysLoad: true` forces tools into the prompt (not deferred behind ToolSearch,
 *   which is globally blocked in this app).
 * - `env` is built by {@link buildStdioEnv} which auto-resolves JAVA_HOME and enriches
 *   PATH for packaged macOS apps where the GUI shell is minimal.
 */
function mountExternalMcps(
  servers: Record<string, McpServerConfig>,
  allowedTools: string[] | undefined,
  mode: ConversationMode,
  externalMcpActive: Record<string, boolean>,
  workspaceId: string | null
): void {
  chatAgentLogger.info(
    `[mcp:mount-external] Active flags: ${JSON.stringify(externalMcpActive)} mode=${mode}`
  )
  for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
    if (externalMcpActive[integration.id]) {
      // An unconfigured server fails the MCP handshake and stalls session start.
      const missing = missingCredentials(integration, workspaceId)
      if (missing.length > 0) {
        chatAgentLogger.warn(
          `[mcp:mount-external] ✗ Skipped ${integration.id} (credentials incomplete: ${missing.join(', ')})`
        )
        continue
      }

      // One integration must never cost the conversation its whole MCP config.
      // `resolveStdioCommand` throws in packaged mode when the command is not at
      // a known path (SVC-04). Uncaught, that escapes `buildWorkspaceMcpConfig`
      // and the session starts with NO servers at all — code-graph and semantic
      // search included — so a single misconfigured integration reads as a
      // total agent regression. Degrade to skipping just this one.
      try {
        const finalEnv = buildStdioEnv(
          integration.envKeys,
          resolveIntegrationEnv(integration, workspaceId)
        )

        // Bundled first-party servers run via our own binary with
        // ELECTRON_RUN_AS_NODE=1 — never a PATH `node`, which does not exist on
        // machines without a Node install (F2).
        const bundled = Boolean(integration.bundledServerEntry)
        const stdioConfig: McpServerConfig = {
          type: 'stdio',
          ...(bundled
            ? {
                command: process.execPath,
                args: [join(resolveMcpServerBasePath(), `${integration.bundledServerEntry}.js`)]
              }
            : {
                command: resolveStdioCommand(integration.command, integration.commandPaths),
                args: [...integration.args]
              }),
          alwaysLoad: true,
          ...(bundled
            ? { env: { ELECTRON_RUN_AS_NODE: '1', ...(finalEnv ?? {}) } }
            : finalEnv
              ? { env: finalEnv }
              : {})
        }
        servers[integration.id] = stdioConfig

        // Plan mode: only read-only tools. Build mode: all tools.
        if (allowedTools !== undefined) {
          const modeTools = mode === 'plan' ? integration.planModeToolNames : integration.toolNames
          allowedTools.push(...modeTools)
        }

        chatAgentLogger.info(
          `[mcp:mount-external] ✓ Mounted ${integration.id}: command=${stdioConfig.command} args=${stdioConfig.args.join(' ')} tools=${(mode === 'plan' ? integration.planModeToolNames : integration.toolNames).length}`
        )
      } catch (err) {
        chatAgentLogger.error(
          `[mcp:mount-external] ✗ Skipped ${integration.id} — mount failed: ${(err as Error).message}`
        )
        continue
      }
    } else {
      chatAgentLogger.info(`[mcp:mount-external] ✗ Skipped ${integration.id} (not active)`)
    }
  }
}

/**
 * Merge additional tool names into a base allowlist.
 * Returns undefined when the base is undefined (= "all tools allowed").
 */
function resolveToolAllowlist(
  baseAllowed: string[] | undefined,
  additionalTools: string[]
): string[] | undefined {
  if (baseAllowed === undefined) return undefined
  return [...baseAllowed, ...additionalTools]
}

/**
 * Build MCP config for local LLM providers.
 * Tool gating by context window tier:
 *   small (≤64K): 6 essential code-graph + 3 control-actions — saves ~50% schema overhead
 *   medium (≤128K): full code-graph + semantic-search + control-actions
 *   large (>128K): everything (same as Claude)
 */
function buildLocalProviderMcpConfig(opts: {
  tier: ContextWindowTier
  mode: ConversationMode
  featureFlags: McpFeatureFlags
  workspaceId: string | null
  baseAllowed: string[] | undefined
  disallowed: string[]
}): McpConfigResult & { planBuiltinDisallowed?: string[] } {
  const { tier, mode, featureFlags, workspaceId, baseAllowed, disallowed } = opts
  const { repomapEnabled, semanticSearchEnabled } = featureFlags
  const localActive = featureFlags.localMcpActive
  const servers: Record<string, McpServerConfig> = {}

  const codeGraphEnabled =
    repomapEnabled && !!workspaceId && isLocalMcpEnabled('code-graph', localActive)

  // Semantic search: skip for 'small' tier (saves ~3 tool schemas ≈ 1-2K tokens)
  const semanticSearchEnabled_ =
    tier !== 'small' &&
    semanticSearchEnabled &&
    !!workspaceId &&
    isLocalMcpEnabled('semantic-search', localActive)

  // Code analysis: skip for 'small' tier (saves ~3 tool schemas)
  const codeAnalysisEnabled = tier !== 'small' && isLocalMcpEnabled('code-analysis', localActive)

  // Process manager: skip for 'small' tier and plan mode (read-only)
  const processManagerEnabled =
    tier !== 'small' && mode !== 'plan' && isLocalMcpEnabled('process-manager', localActive)

  // Build allowed tools list — tier-gated subset for code-graph
  const conditionalTools = [
    // Code graph: small tier → 6 essential tools; medium/large → full 13
    ...(codeGraphEnabled
      ? tier === 'small'
        ? [...ESSENTIAL_CODE_GRAPH_TOOLS]
        : MCP_TOOLS.CODE_GRAPH._ALL_NAMES
      : []),
    // Semantic search (tier-gated above)
    ...(semanticSearchEnabled_ ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES : []),
    // Code analysis (tier-gated above)
    ...(codeAnalysisEnabled ? MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES : []),
    // Process manager (tier-gated + mode-gated above)
    ...(processManagerEnabled ? MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES : []),
    // Control actions — always on
    MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
    MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
    MCP_TOOLS.CONTROL_ACTIONS.EMIT_PHASE_PROGRESS.name,
    // Memory tools — always on (all tiers, ~1-2K tokens of schemas)
    ...MCP_TOOLS.MEMORY._ALL_NAMES,
    // Recall tools — past plans + surrounding conversation (workspace-scoped)
    ...(workspaceId && isLocalMcpEnabled('recall', localActive) ? MCP_TOOLS.RECALL._ALL_NAMES : [])
  ]
  const localAllowed = resolveToolAllowlist(baseAllowed, conditionalTools)

  // ── External MCP Servers (stdio) — also available for local LLMs ──
  const externalActive = featureFlags.externalMcpActive ?? {}
  mountExternalMcps(servers, localAllowed, mode, externalActive, workspaceId)

  chatAgentLogger.info(
    `[mcp:config-result] servers=[${Object.keys(servers).join(',')}] allowedToolCount=${localAllowed?.length ?? 'all'} disallowedCount=${disallowed.length} provider=local tier=${tier}`
  )

  // For small tier: explicitly disallow the tools we didn't allow — defense-in-depth
  const smallTierDisallowed =
    tier === 'small'
      ? [
          // Redundant code-graph tools not in ESSENTIAL_CODE_GRAPH_TOOLS
          ...(codeGraphEnabled
            ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES.filter(
                (t) => !(ESSENTIAL_CODE_GRAPH_TOOLS as readonly string[]).includes(t)
              )
            : []),
          // All semantic-search tools (server not mounted)
          ...MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES,
          // All code-analysis tools (server not mounted)
          ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES
        ]
      : []

  // Plan-mode built-in tool gating — restrict write tools in plan mode
  // to reduce tool schema overhead (each tool schema costs ~400-500 tokens).
  const tierLimits = TIER_LIMITS[tier]
  let planBuiltinDisallowed: string[] | undefined
  if (mode === 'plan' && tierLimits.planBuiltinAllowlist) {
    const allBuiltins = [
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Bash',
      'Glob',
      'Grep',
      'TodoRead',
      'TodoWrite',
      'NotebookRead',
      'NotebookEdit'
    ]
    planBuiltinDisallowed = allBuiltins.filter((t) => !tierLimits.planBuiltinAllowlist!.includes(t))
    chatAgentLogger.info(
      `[mcp:plan-builtin-gating] tier=${tier} allowed=[${tierLimits.planBuiltinAllowlist.join(',')}] ` +
        `disallowed=[${planBuiltinDisallowed.join(',')}] — saves ~${planBuiltinDisallowed.length * 450} tokens`
    )
  }

  const mcpServers = Object.keys(servers).length > 0 ? servers : undefined
  return {
    ...(mcpServers ? { mcpServers } : {}),
    allowedTools: localAllowed,
    disallowedTools: [...disallowed, ...smallTierDisallowed, ...(planBuiltinDisallowed ?? [])],
    codeAnalysisEnabled,
    planBuiltinDisallowed
  }
}

/**
 * Build MCP config for Claude providers.
 * Full MCP suite with feature-flag gating.
 */
function buildClaudeProviderMcpConfig(opts: {
  mode: ConversationMode
  featureFlags: McpFeatureFlags
  workspaceId: string | null
  baseAllowed: string[] | undefined
  disallowed: string[]
}): McpConfigResult {
  const { mode, featureFlags, workspaceId, baseAllowed, disallowed } = opts
  const { repomapEnabled, semanticSearchEnabled } = featureFlags
  const localActive = featureFlags.localMcpActive

  // ── Claude Write/Edit exposure ──
  // Claude Code gates plan-mode writes via --permission-mode plan (read-only at
  // runtime), so we keep Write/Edit EXPOSED in every mode. This lets the live
  // set_permission_mode(plan→auto/acceptEdits) switch unlock edits without a
  // respawn — matching Claude Code's native "approve plan → start editing" flow.
  // The local-LLM path is unaffected (uses buildLocalProviderMcpConfig instead).
  const claudeDisallowed = disallowed.filter((t) => t !== 'Write' && t !== 'Edit')
  const claudeBaseAllowed =
    baseAllowed === undefined ? undefined : [...baseAllowed, 'Write', 'Edit']

  // ── Allowed Tools ──
  // Build-mode has no allow-list (claudeBaseAllowed=undefined). Plan-mode appends
  // conditional MCP tool names to the base allow-list (now including Write/Edit).
  const conditionalTools = [
    // Code graph MCP tools (workspace flag AND per-chat toggle)
    ...(repomapEnabled && workspaceId && isLocalMcpEnabled('code-graph', localActive)
      ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES
      : []),
    // Semantic search (workspace flag AND per-chat toggle)
    ...(semanticSearchEnabled && workspaceId && isLocalMcpEnabled('semantic-search', localActive)
      ? [
          MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.name,
          MCP_TOOLS.SEMANTIC_SEARCH.SIMILAR_CODE.name,
          MCP_TOOLS.SEMANTIC_SEARCH.CODEBASE_CONCEPTS.name
        ]
      : []),
    // Git context (per-chat gated)
    ...(isLocalMcpEnabled('git-context', localActive) ? MCP_TOOLS.GIT_CONTEXT._ALL_NAMES : []),
    // Code analysis (per-chat gated)
    ...(isLocalMcpEnabled('code-analysis', localActive) ? MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES : []),
    // Process manager — build/danger mode only (not plan)
    ...(mode !== 'plan' && isLocalMcpEnabled('process-manager', localActive)
      ? MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES
      : []),
    // Control actions — always on (plan + ask + phase progress)
    MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
    MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
    MCP_TOOLS.CONTROL_ACTIONS.EMIT_PHASE_PROGRESS.name,
    // Memory tools — always on (all tiers)
    ...MCP_TOOLS.MEMORY._ALL_NAMES,
    // Recall tools — past plans + surrounding conversation (workspace-scoped)
    ...(workspaceId && isLocalMcpEnabled('recall', localActive) ? MCP_TOOLS.RECALL._ALL_NAMES : [])
  ]
  const allowedTools = resolveToolAllowlist(claudeBaseAllowed, conditionalTools)

  // ── External MCP Servers (stdio) ──
  // Conditionally mounted based on per-message flags from the conversation MCP overrides.
  const servers: Record<string, McpServerConfig> = {}
  const externalActive = featureFlags.externalMcpActive ?? {}
  mountExternalMcps(servers, allowedTools, mode, externalActive, workspaceId)

  chatAgentLogger.info(
    `[mcp:config-result] servers=[${Object.keys(servers).join(',')}] allowedToolCount=${allowedTools?.length ?? 'all'} disallowedCount=${disallowed.length} provider=claude`
  )

  const mcpServers = Object.keys(servers).length > 0 ? servers : undefined

  return {
    ...(mcpServers ? { mcpServers } : {}),
    allowedTools,
    disallowedTools: claudeDisallowed,
    codeAnalysisEnabled: true
  }
}

/**
 * Builds MCP tool allow/disallow lists and mounts external MCP servers.
 * Dispatches to provider-specific builders for local LLM vs Claude paths.
 */
export function buildWorkspaceMcpConfig(opts: {
  mode: ConversationMode
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
  featureFlags: McpFeatureFlags
  controlCallbacks: ControlActionCallbacks
  /** When true, mounts only control-actions MCP (3 tools vs 30+) to save ~12-16K tokens. */
  isLocalProvider?: boolean
  /** Context window tier — gates MCP tools for small-window models */
  contextTier?: ContextWindowTier
}): McpConfigResult & {
  /** SDK built-in tools to disallow in local plan mode (saves tool schema tokens) */
  planBuiltinDisallowed?: string[]
} {
  const { baseAllowed, disallowed } = buildModePermissions(opts.mode)

  if (opts.isLocalProvider) {
    return buildLocalProviderMcpConfig({
      tier: opts.contextTier ?? 'large',
      mode: opts.mode,
      featureFlags: opts.featureFlags,
      workspaceId: opts.workspaceId,
      baseAllowed,
      disallowed
    })
  }

  return buildClaudeProviderMcpConfig({
    mode: opts.mode,
    featureFlags: opts.featureFlags,
    workspaceId: opts.workspaceId,
    baseAllowed,
    disallowed
  })
}

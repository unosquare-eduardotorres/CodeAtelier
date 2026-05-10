import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { McpServerConfig, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { MCP_TOOLS, EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'
import { createControlActionsMcpServer } from './control-actions.tool'
import { codeGraphMcpService } from './code-graph.tool'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import { checkpointContextMcpService } from './checkpoint-context.tool'
import { gitHubContextMcpService } from './github-context.tool'
import { codeAnalysisMcpService } from './code-analysis.tool'
import { buildModePermissions } from './mode-permissions'
import type { ContextWindowTier } from './context-management'

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
  MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name,
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
  localMcpActive?: Record<string, boolean>
}

/**
 * Result of building MCP configuration for the SDK executor.
 */
export interface McpConfigResult {
  mcpServers?: Record<string, McpServerConfig>
  allowedTools?: string[]
  disallowedTools: string[]
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
      if (existsSync(resolved)) return resolved
    }
  }
  return command
}

/**
 * Mount external MCP stdio servers based on per-message activation flags.
 * Shared between local LLM and Claude code paths.
 *
 * Key behaviors:
 * - `alwaysLoad: true` forces tools into the prompt (not deferred behind ToolSearch,
 *   which is globally blocked in this app).
 * - `env` forwards process environment keys listed in the integration definition
 *   (e.g. JAVA_HOME, MAESTRO_CLOUD_API_KEY) — only includes keys that are actually set.
 */
function mountExternalMcps(
  servers: Record<string, McpServerConfig>,
  allowedTools: string[] | undefined,
  mode: ConversationMode,
  externalMcpActive: Record<string, boolean>
): void {
  for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
    if (externalMcpActive[integration.id]) {
      const stdioConfig: McpStdioServerConfig = {
        type: 'stdio',
        command: resolveStdioCommand(integration.command, integration.commandPaths),
        args: [...integration.args],
        alwaysLoad: true,
        ...(integration.envKeys?.length
          ? {
              env: Object.fromEntries(
                integration.envKeys
                  .filter((k) => process.env[k])
                  .map((k) => [k, process.env[k]!])
              )
            }
          : {})
      }
      servers[integration.id] = stdioConfig

      // Plan mode: only read-only tools. Build mode: all tools.
      if (allowedTools !== undefined) {
        const modeTools =
          mode === 'plan' ? integration.planModeToolNames : integration.toolNames
        allowedTools.push(...modeTools)
      }
    }
  }
}

/**
 * Builds the SDK execute options (MCP servers + tool lists) for the current
 * workspace, independent of role. DaVinci and Project Specialists both go
 * through this helper — the only thing that differs between them is the
 * identity text in their system prompt, not their toolbox.
 *
 * - Allow / disallow lists come from {@link buildModePermissions} plus the
 *   MCP tool names gated by the workspace feature flags.
 * - MCP servers are mounted identically for both roles, again gated on
 *   feature flags + presence of a workspace / conversation id.
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
}): McpConfigResult {
  const { baseAllowed, disallowed } = buildModePermissions(opts.mode)

  // ── Local LLM path ──
  // Mount MCP tools gated by context window tier:
  //   small (≤64K): 6 essential code-graph + 3 control-actions — saves ~50% schema overhead
  //   medium (≤128K): full code-graph + semantic-search + control-actions
  //   large (>128K): everything (same as Claude)
  // SDK built-ins (Read, Write, Edit, Bash, Glob, Grep) are unaffected.
  if (opts.isLocalProvider) {
    const tier: ContextWindowTier = opts.contextTier ?? 'large' // backward-compat default
    const { repomapEnabled, semanticSearchEnabled } = opts.featureFlags
    const localActive = opts.featureFlags.localMcpActive
    const controlActionsConfig = createControlActionsMcpServer(opts.controlCallbacks)
    const servers: Record<string, McpServerConfig> = {}

    const codeGraphEnabled =
      repomapEnabled && !!opts.workspaceId && isLocalMcpEnabled('code-graph', localActive)

    // Code graph: always mounted when enabled (tier only affects allowed tool subset)
    if (codeGraphEnabled) {
      Object.assign(
        servers,
        codeGraphMcpService.getMcpServersConfig(opts.workspaceId!, opts.workspacePath)
      )
    }

    // Semantic search: skip for 'small' tier (saves ~3 tool schemas ≈ 1-2K tokens)
    const semanticSearchEnabled_ =
      tier !== 'small' &&
      semanticSearchEnabled &&
      !!opts.workspaceId &&
      isLocalMcpEnabled('semantic-search', localActive)
    if (semanticSearchEnabled_) {
      Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(opts.workspaceId!))
    }

    // Code analysis: skip for 'small' tier (saves ~3 tool schemas)
    const codeAnalysisEnabled =
      tier !== 'small' && isLocalMcpEnabled('code-analysis', localActive)
    if (codeAnalysisEnabled) {
      Object.assign(servers, codeAnalysisMcpService.getMcpServersConfig(opts.workspacePath))
    }

    // Control actions — ALWAYS ON (never gated)
    Object.assign(servers, controlActionsConfig)

    // Build allowed tools list — tier-gated subset for code-graph
    const localAllowed =
      baseAllowed === undefined
        ? undefined
        : [
            ...baseAllowed,
            // Code graph: small tier → 6 essential tools; medium/large → full 13
            ...(codeGraphEnabled
              ? (tier === 'small'
                  ? [...ESSENTIAL_CODE_GRAPH_TOOLS]
                  : MCP_TOOLS.CODE_GRAPH._ALL_NAMES)
              : []),
            // Semantic search (tier-gated above)
            ...(semanticSearchEnabled_
              ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
              : []),
            // Code analysis (tier-gated above)
            ...(codeAnalysisEnabled
              ? MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES
              : []),
            // Control actions — always on
            MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
            MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
            MCP_TOOLS.CONTROL_ACTIONS.EMIT_MEMORY.name
          ]

    // ── External MCP Servers (stdio) — also available for local LLMs ──
    const externalActive = opts.featureFlags.externalMcpActive ?? {}
    mountExternalMcps(servers, localAllowed, opts.mode, externalActive)

    // For small tier: explicitly disallow the tools we didn't allow — defense-in-depth
    const smallTierDisallowed = tier === 'small'
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
          ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
        ]
      : []

    const mcpServers = Object.keys(servers).length > 0 ? servers : undefined
    return {
      ...(mcpServers ? { mcpServers } : {}),
      allowedTools: localAllowed,
      disallowedTools: [...disallowed, ...smallTierDisallowed]
    }
  }

  // ── Full MCP config for Claude ──
  const { repomapEnabled, semanticSearchEnabled, githubConfigured } = opts.featureFlags
  const localActive = opts.featureFlags.localMcpActive

  // ── Allowed Tools ──
  // Build-mode has no allow-list (baseAllowed=undefined). Plan-mode appends
  // conditional MCP tool names to the base allow-list.
  const allowedTools =
    baseAllowed === undefined
      ? undefined
      : [
          ...baseAllowed,
          // Code graph MCP tools (workspace flag AND per-chat toggle)
          ...(repomapEnabled && opts.workspaceId && isLocalMcpEnabled('code-graph', localActive)
            ? [
                MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name,
                MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name,
                MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name,
                MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.name,
                MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.name,
                MCP_TOOLS.CODE_GRAPH.FIND_CALLEES.name,
                MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.name,
                MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENCIES.name,
                MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENTS.name,
                MCP_TOOLS.CODE_GRAPH.SYMBOL_HOTSPOTS.name,
                MCP_TOOLS.CODE_GRAPH.COUPLING_ANALYSIS.name,
                MCP_TOOLS.CODE_GRAPH.CIRCULAR_DEPENDENCIES.name,
                MCP_TOOLS.CODE_GRAPH.MODULE_BOUNDARY_HEALTH.name
              ]
            : []),
          // Semantic search (workspace flag AND per-chat toggle)
          ...(semanticSearchEnabled &&
          opts.workspaceId &&
          isLocalMcpEnabled('semantic-search', localActive)
            ? [
                MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.name,
                MCP_TOOLS.SEMANTIC_SEARCH.SIMILAR_CODE.name,
                MCP_TOOLS.SEMANTIC_SEARCH.CODEBASE_CONCEPTS.name
              ]
            : []),
          // Git context (per-chat gated)
          ...(isLocalMcpEnabled('git-context', localActive)
            ? MCP_TOOLS.GIT_CONTEXT._ALL_NAMES
            : []),
          // Checkpoint context (per-chat gated)
          ...(isLocalMcpEnabled('checkpoint-context', localActive)
            ? MCP_TOOLS.CHECKPOINT_CONTEXT._ALL_NAMES
            : []),
          // GitHub context (workspace flag AND per-chat toggle)
          ...(githubConfigured && isLocalMcpEnabled('github-context', localActive)
            ? MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES
            : []),
          // Code analysis (per-chat gated)
          ...(isLocalMcpEnabled('code-analysis', localActive)
            ? MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES
            : []),
          // Control actions — always on (plan + ask + memory)
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
          MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_MEMORY.name
        ]

  // ── MCP Servers ──
  const controlActionsConfig = createControlActionsMcpServer(opts.controlCallbacks)
  const servers: Record<string, McpServerConfig> = {}

  // Code graph (workspace flag AND per-chat toggle)
  if (repomapEnabled && opts.workspaceId && isLocalMcpEnabled('code-graph', localActive)) {
    Object.assign(
      servers,
      codeGraphMcpService.getMcpServersConfig(opts.workspaceId, opts.workspacePath)
    )
  }
  // Semantic search (workspace flag AND per-chat toggle)
  if (
    semanticSearchEnabled &&
    opts.workspaceId &&
    isLocalMcpEnabled('semantic-search', localActive)
  ) {
    Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(opts.workspaceId))
  }
  // Git context (per-chat gated)
  if (isLocalMcpEnabled('git-context', localActive)) {
    Object.assign(servers, gitContextMcpService.getMcpServersConfig(opts.workspacePath))
  }
  // Checkpoint context (conversation-scoped AND per-chat gated)
  if (opts.conversationId && isLocalMcpEnabled('checkpoint-context', localActive)) {
    Object.assign(servers, checkpointContextMcpService.getMcpServersConfig(opts.conversationId))
  }
  // GitHub context (workspace flag AND per-chat toggle)
  if (githubConfigured && opts.workspaceId && isLocalMcpEnabled('github-context', localActive)) {
    Object.assign(
      servers,
      gitHubContextMcpService.getMcpServersConfig(opts.workspaceId, opts.workspacePath)
    )
  }
  // Code analysis (per-chat gated)
  if (isLocalMcpEnabled('code-analysis', localActive)) {
    Object.assign(servers, codeAnalysisMcpService.getMcpServersConfig(opts.workspacePath))
  }
  // Control actions — ALWAYS ON, mode-aware structured output tools
  Object.assign(servers, controlActionsConfig)

  // ── External MCP Servers (stdio) ──
  // Conditionally mounted based on per-message flags from the conversation MCP overrides.
  const externalActive = opts.featureFlags.externalMcpActive ?? {}
  mountExternalMcps(servers, allowedTools, opts.mode, externalActive)

  const mcpServers = Object.keys(servers).length > 0 ? servers : undefined

  return {
    ...(mcpServers ? { mcpServers } : {}),
    allowedTools,
    disallowedTools: disallowed
  }
}

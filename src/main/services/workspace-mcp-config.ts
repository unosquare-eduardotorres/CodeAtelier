import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { MCP_TOOLS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'
import { createControlActionsMcpServer } from './control-actions.tool'
import { codeGraphMcpService } from './code-graph.tool'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import { checkpointContextMcpService } from './checkpoint-context.tool'
import { gitHubContextMcpService } from './github-context.tool'
import { buildModePermissions } from './mode-permissions'

/**
 * Feature flag state for MCP configuration.
 * Passed as a snapshot so the builder has no dependency on workspace settings.
 */
export interface McpFeatureFlags {
  repomapEnabled: boolean
  semanticSearchEnabled: boolean
  githubConfigured: boolean
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
}): McpConfigResult {
  const { repomapEnabled, semanticSearchEnabled, githubConfigured } = opts.featureFlags
  const { baseAllowed, disallowed } = buildModePermissions(opts.mode)

  // ── Allowed Tools ──
  // Build-mode has no allow-list (baseAllowed=undefined). Plan-mode appends
  // conditional MCP tool names to the base allow-list.
  const allowedTools =
    baseAllowed === undefined
      ? undefined
      : [
          ...baseAllowed,
          // Code graph MCP tools (conditional)
          ...(repomapEnabled && opts.workspaceId
            ? [MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name, MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name]
            : []),
          // Semantic search (conditional)
          ...(semanticSearchEnabled && opts.workspaceId
            ? [MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.name]
            : []),
          // Git context (always available)
          ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
          // Checkpoint context
          ...MCP_TOOLS.CHECKPOINT_CONTEXT._ALL_NAMES,
          // GitHub context (conditional on token)
          ...(githubConfigured ? MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES : []),
          // Control actions (plan + ask + memory)
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
          MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_MEMORY.name
        ]

  // ── MCP Servers ──
  const controlActionsConfig = createControlActionsMcpServer(opts.controlCallbacks)
  const servers: Record<string, McpServerConfig> = {}

  // Code graph (conditional)
  if (repomapEnabled && opts.workspaceId) {
    Object.assign(
      servers,
      codeGraphMcpService.getMcpServersConfig(opts.workspaceId, opts.workspacePath)
    )
  }
  // Semantic search (conditional)
  if (semanticSearchEnabled && opts.workspaceId) {
    Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(opts.workspaceId))
  }
  // Git context: always on
  Object.assign(servers, gitContextMcpService.getMcpServersConfig(opts.workspacePath))
  // Checkpoint context: conversation-scoped
  if (opts.conversationId) {
    Object.assign(servers, checkpointContextMcpService.getMcpServersConfig(opts.conversationId))
  }
  // GitHub context: conditional on token
  if (githubConfigured && opts.workspaceId) {
    Object.assign(
      servers,
      gitHubContextMcpService.getMcpServersConfig(opts.workspaceId, opts.workspacePath)
    )
  }
  // Control actions — mode-aware structured output tools
  Object.assign(servers, controlActionsConfig)

  const mcpServers = Object.keys(servers).length > 0 ? servers : undefined

  return {
    ...(mcpServers ? { mcpServers } : {}),
    allowedTools,
    disallowedTools: disallowed
  }
}

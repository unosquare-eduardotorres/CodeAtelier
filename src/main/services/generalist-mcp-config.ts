import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { MCP_TOOLS } from '../../shared/constants'
import type { ConversationMode } from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'
import { createControlActionsMcpServer } from './control-actions.tool'
import { codeGraphMcpService } from './code-graph.tool'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import { taskContextMcpService } from './task-context.tool'
import { checkpointContextMcpService } from './checkpoint-context.tool'
import { gitHubContextMcpService } from './github-context.tool'

/**
 * Feature flag state for MCP configuration.
 * Passed as a snapshot so McpConfig has no dependency on workspace settings.
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
 * Extracts MCP server and tool list assembly from GeneralistService.
 *
 * Responsibilities:
 * - Build allowedTools list based on mode + feature flags
 * - Build disallowedTools list based on mode
 * - Assemble MCP server configs (code-graph, semantic-search, git, task, checkpoint, github, control-actions)
 * - Control actions MCP server creation
 *
 * This is pure configuration — no side effects, no state.
 */
export class GeneralistMcpConfig {
  /**
   * Build the complete SDK execute options for MCP servers + tool lists.
   */
  build(opts: {
    mode: ConversationMode
    workspacePath: string
    workspaceId: string | null
    conversationId: string | null
    featureFlags: McpFeatureFlags
    controlCallbacks: ControlActionCallbacks
    investigationModeEnabled: boolean
  }): McpConfigResult {
    const isBuildMode = opts.mode === 'build'
    const { repomapEnabled, semanticSearchEnabled, githubConfigured } = opts.featureFlags

    // ── Allowed Tools ──
    const allowedTools = isBuildMode
      ? undefined
      : [
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
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
          // Task context (always available — no-ops gracefully if no active plan)
          ...MCP_TOOLS.TASK_CONTEXT._ALL_NAMES,
          // Checkpoint context
          ...MCP_TOOLS.CHECKPOINT_CONTEXT._ALL_NAMES,
          // GitHub context (conditional on token)
          ...(githubConfigured ? MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES : []),
          // Control actions (plan mode gets emit_plan + ask_user + emit_memory, NOT request_handoff)
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.name,
          MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.name,
          MCP_TOOLS.CONTROL_ACTIONS.EMIT_MEMORY.name
        ]

    // ── Disallowed Tools ──
    // Block SDK built-in tools that conflict with our control-actions MCP paradigm.
    // Both modes block: ExitPlanMode (use emit_plan), AskUserQuestion (use ask_user),
    // ToolSearch (wastes turns). Build mode additionally blocks Agent (handoff protocol).
    const disallowedTools = isBuildMode
      ? ['Agent', 'ToolSearch', 'ExitPlanMode', 'AskUserQuestion']
      : ['Write', 'Edit', 'ExitPlanMode', 'AskUserQuestion', 'ToolSearch']

    // ── MCP Servers ──
    const controlActionsConfig = createControlActionsMcpServer(
      opts.mode,
      opts.controlCallbacks,
      opts.investigationModeEnabled
    )

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
    // Task + checkpoint context: conversation-scoped
    if (opts.conversationId) {
      Object.assign(
        servers,
        taskContextMcpService.getMcpServersConfig(opts.conversationId, opts.workspacePath)
      )
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
      disallowedTools
    }
  }
}

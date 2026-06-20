/**
 * Shared read-only MCP tool configuration for evaluation-role adapters.
 *
 * Grill, Greenfield Grill, and Council Member adapters all use the same
 * read-only tool suite. This module centralises the allow/disallow lists
 * so changes to the MCP tool registry only need updating in one place.
 */

import type { AdapterMcpResult } from '../agent-session.types'

export interface EvaluationToolFlags {
  /** Whether the code-graph (repomap) MCP server is enabled */
  repomapEnabled: boolean
  /** Whether the semantic-search MCP server is enabled */
  semanticSearchEnabled: boolean
  /** Whether a workspace is available (needed to mount workspace-scoped servers) */
  hasWorkspace: boolean
  /** Whether to include git-context tools (skipped for local LLMs to save tokens) */
  includeGitContext: boolean
}

// ── Shared tool lists ────────────────────────────────────────────────────

/** Write/agent tools that are always disallowed in evaluation roles */
const EVALUATION_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'Bash',
  'Agent',
  'ToolSearch',
  'ExitPlanMode',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate'
] as const

/** Code graph tools (mounted when repomap is enabled + workspace present) */
const CODE_GRAPH_TOOLS = [
  'mcp__code-graph__graph_map',
  'mcp__code-graph__search_identifiers',
  'mcp__code-graph__find_dead_code',
  'mcp__code-graph__file_outline',
  'mcp__code-graph__find_callers',
  'mcp__code-graph__find_callees',
  'mcp__code-graph__find_references',
  'mcp__code-graph__file_dependencies',
  'mcp__code-graph__file_dependents',
  'mcp__code-graph__symbol_hotspots',
  'mcp__code-graph__coupling_analysis',
  'mcp__code-graph__circular_dependencies',
  'mcp__code-graph__module_boundary_health'
] as const

/** Semantic search tools (mounted when enabled + workspace present) */
const SEMANTIC_SEARCH_TOOLS = [
  'mcp__semantic-search__semantic_search',
  'mcp__semantic-search__similar_code',
  'mcp__semantic-search__codebase_concepts'
] as const

/** Git context tools (included for Claude, skipped for local LLMs) */
const GIT_CONTEXT_TOOLS = [
  'mcp__git-context__git_log',
  'mcp__git-context__git_diff',
  'mcp__git-context__git_blame'
] as const

/** Code analysis tools (always included) */
const CODE_ANALYSIS_TOOLS = [
  'mcp__code-analysis__todo_scanner',
  'mcp__code-analysis__dependency_health',
  'mcp__code-analysis__test_coverage_map',
  'mcp__code-analysis__eslint_check',
  'mcp__code-analysis__eslint_fix',
  'mcp__code-analysis__eslint_rules'
] as const

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build the read-only MCP tool config for evaluation adapters.
 * All adapters share the same pattern: read/search + optional code-graph/semantic/git.
 */
export function buildReadOnlyToolConfig(flags: EvaluationToolFlags): AdapterMcpResult {
  const allowedTools: string[] = [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    ...(flags.repomapEnabled && flags.hasWorkspace ? CODE_GRAPH_TOOLS : []),
    ...(flags.semanticSearchEnabled && flags.hasWorkspace ? SEMANTIC_SEARCH_TOOLS : []),
    ...(flags.includeGitContext ? GIT_CONTEXT_TOOLS : []),
    ...CODE_ANALYSIS_TOOLS
  ]

  return {
    allowedTools,
    disallowedTools: [...EVALUATION_DISALLOWED_TOOLS]
  }
}

/**
 * Build the no-tools MCP config for roles that should have no tool access
 * (e.g., Outsider council advisor, Chairman).
 */
export function buildNoToolsConfig(): AdapterMcpResult {
  return {
    allowedTools: [],
    disallowedTools: [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'Agent',
      'ToolSearch',
      'WebSearch',
      'WebFetch',
      'ExitPlanMode',
      'AskUserQuestion',
      'TodoWrite',
      'TaskCreate',
      'TaskUpdate'
    ]
  }
}

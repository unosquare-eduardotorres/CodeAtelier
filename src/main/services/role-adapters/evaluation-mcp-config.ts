/**
 * Shared read-only MCP tool configuration for evaluation-role adapters.
 *
 * Grill, Greenfield Grill, and Council Member adapters all use the same
 * read-only tool suite. All tool lists are derived from the canonical
 * MCP_TOOLS registry in shared/constants.ts — no hardcoded tool names.
 */

import { MCP_TOOLS } from '../../../shared/constants'
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

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build the read-only MCP tool config for evaluation adapters (Grill, Audit, Council).
 * All tool lists derived from canonical MCP_TOOLS — no hardcoded tool names.
 */
export function buildReadOnlyToolConfig(flags: EvaluationToolFlags): AdapterMcpResult {
  const allowedTools: string[] = [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    ...(flags.repomapEnabled && flags.hasWorkspace ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
    ...(flags.semanticSearchEnabled && flags.hasWorkspace ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES : []),
    ...(flags.includeGitContext ? MCP_TOOLS.GIT_CONTEXT._ALL_NAMES : []),
    ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
    // Memory tools — evaluators can search/record/flag workspace knowledge
    ...(flags.hasWorkspace ? MCP_TOOLS.MEMORY._ALL_NAMES : [])
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

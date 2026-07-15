/**
 * Derive which MCP servers can be skipped from the CLI config based on the
 * adapter's allowedTools list.
 *
 * When an adapter defines an explicit allowedTools array (e.g. blueprint phases),
 * any MCP server whose tools are entirely absent from that list is unnecessary —
 * spawning it wastes a cold-start `node` process and increases the likelihood of
 * the MCP connection race (Root Cause A in the blueprint-tools diagnosis).
 *
 * Returns an array of server IDs (e.g. ['checkpoint-context', 'control-actions'])
 * suitable for CliMcpConfigWriterOptions.skipServers.
 */

import { MCP_TOOLS } from '../../shared/constants'

/**
 * MCP server groups that can be skipped if their tools aren't in allowedTools.
 * Maps server ID → prefix used in tool names (e.g. 'mcp__control-actions__').
 *
 * Servers NOT listed here are never skipped (e.g. git-context, code-analysis
 * are always useful even if not explicitly in allowedTools since the CLI may
 * expose them as built-in tools).
 */
const SKIPPABLE_SERVERS: Array<{ id: string; prefix: string }> = [
  { id: 'checkpoint-context', prefix: MCP_TOOLS.CHECKPOINT_CONTEXT._PREFIX },
  { id: 'control-actions', prefix: MCP_TOOLS.CONTROL_ACTIONS._PREFIX },
  { id: 'github-context', prefix: MCP_TOOLS.GITHUB_CONTEXT._PREFIX }
]

/**
 * Given an adapter's allowedTools list, return server IDs that should be
 * omitted from the MCP config because none of their tools are allowed.
 *
 * Returns an empty array when allowedTools is undefined (= all tools allowed).
 */
export function deriveSkipServers(allowedTools: string[] | undefined): string[] | undefined {
  // undefined means "all tools allowed" — don't skip anything
  if (!allowedTools) return undefined

  const skip: string[] = []
  for (const { id, prefix } of SKIPPABLE_SERVERS) {
    const hasToolFromServer = allowedTools.some((t) => t.startsWith(prefix))
    if (!hasToolFromServer) {
      skip.push(id)
    }
  }
  return skip.length > 0 ? skip : undefined
}

/**
 * Pure server-selection logic extracted from CliMcpConfigWriter.buildConfig().
 *
 * These functions determine which MCP servers to include, apply toggle
 * overrides, and compute deterministic temp config paths. They have no
 * Electron or file-system dependencies — all environment-specific values
 * (serverBasePath, dbDir, HOME) are passed as parameters.
 *
 * Phase 4B — coverage extraction from cli-mcp-config-writer.ts (265 LOC, 31%).
 */

import type { ConversationMode } from '../../shared/types'
import type { McpFeatureFlags } from './workspace-mcp-config'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'
import { existsSync } from 'node:fs'

// ── Types ──

/** A single MCP server entry in the CLI config format. */
export interface CliMcpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Parameters for building the core server set. */
export interface BuildCoreServersParams {
  featureFlags: McpFeatureFlags
  workspaceId: string | null
  workspacePath: string
  conversationId: string | null
  mode: ConversationMode
  ipcSocketPath?: string
  serverBasePath: string
  dbDir: string
}

// ── Core Servers ──

/**
 * Build the core MCP server entries from feature flags and workspace params.
 * Returns a mutable record of server entries (before toggle/external overlay).
 */
export function buildCoreServers(
  params: BuildCoreServersParams
): Record<string, CliMcpServerEntry> {
  const servers: Record<string, CliMcpServerEntry> = {}
  const { featureFlags, workspaceId, workspacePath, serverBasePath, dbDir } = params
  const join = (...parts: string[]): string => parts.join('/')

  // ── Code Graph ──
  if (featureFlags.repomapEnabled && workspaceId) {
    servers['code-graph'] = {
      command: 'node',
      args: [join(serverBasePath, 'code-graph-server.js')],
      env: {
        WORKSPACE_ID: workspaceId,
        WORKSPACE_PATH: workspacePath,
        DB_PATH: dbDir
      }
    }
  }

  // ── Semantic Search ──
  if (featureFlags.semanticSearchEnabled && workspaceId) {
    servers['semantic-search'] = {
      command: 'node',
      args: [join(serverBasePath, 'semantic-search-server.js')],
      env: { WORKSPACE_ID: workspaceId, DB_PATH: dbDir }
    }
  }

  // ── Git Context ──
  servers['git-context'] = {
    command: 'node',
    args: [join(serverBasePath, 'git-context-server.js')],
    env: { WORKSPACE_PATH: workspacePath }
  }

  // ── Code Analysis ──
  servers['code-analysis'] = {
    command: 'node',
    args: [join(serverBasePath, 'code-analysis-server.js')],
    env: {
      WORKSPACE_PATH: workspacePath,
      ...(workspaceId ? { WORKSPACE_ID: workspaceId } : {})
    }
  }

  // ── Control Actions ──
  const controlEnv: Record<string, string> = {
    WORKSPACE_PATH: workspacePath,
    CONVERSATION_MODE: params.mode
  }
  if (params.ipcSocketPath) {
    controlEnv.IPC_SOCKET_PATH = params.ipcSocketPath
  }
  if (params.conversationId) {
    controlEnv.CONVERSATION_ID = params.conversationId
  }
  servers['control-actions'] = {
    command: 'node',
    args: [join(serverBasePath, 'control-actions-server.js')],
    env: controlEnv
  }

  return servers
}

// ── External MCP Integrations ──

/**
 * Mount any enabled external MCP integrations (Maestro, Jira, etc.).
 * Mutates the `servers` record in place.
 *
 * Environments are pre-resolved by `resolveActiveIntegrationEnvs` (credentials +
 * shell fallback + performanceEnv) so this function stays pure. An integration
 * absent from `envByIntegration` is not mounted — that is how incomplete
 * credentials are filtered out.
 */
export function mountExternalIntegrations(
  servers: Record<string, CliMcpServerEntry>,
  externalActive: Record<string, boolean>,
  envByIntegration: Record<string, Record<string, string>>,
  homePath: string,
  serverBasePath: string
): void {
  for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
    if (!externalActive[integration.id]) continue

    const env = envByIntegration[integration.id]
    if (!env) continue

    if (integration.bundledServerEntry) {
      servers[integration.id] = {
        command: 'node',
        args: [[serverBasePath, `${integration.bundledServerEntry}.js`].join('/')],
        ...(Object.keys(env).length > 0 ? { env } : {})
      }
      continue
    }

    let resolvedCommand = integration.command
    if (integration.commandPaths) {
      for (const cmdPath of integration.commandPaths) {
        const expanded = cmdPath.replace('~', homePath)
        if (existsSync(expanded)) {
          resolvedCommand = expanded
          break
        }
      }
    }

    servers[integration.id] = {
      command: resolvedCommand,
      args: [...integration.args],
      ...(Object.keys(env).length > 0 ? { env } : {})
    }
  }
}

// ── Toggle Overrides ──

/**
 * Remove disabled servers from the config based on localMcpActive toggles.
 * CLI config doesn't support `enabled: false` — we delete entries instead.
 */
export function applyLocalMcpToggles(
  servers: Record<string, CliMcpServerEntry>,
  localMcpActive: Record<string, boolean>
): void {
  for (const [serverId, enabled] of Object.entries(localMcpActive)) {
    if (enabled === false && servers[serverId]) {
      delete servers[serverId]
    }
  }
}

// ── Temp Config Path ──

/**
 * Build a deterministic temp config path from a workspace path.
 * Returns the base64url-encoded prefix (32 chars max) used as directory name.
 */
export function buildTempDirName(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url').slice(0, 32)
}

/**
 * Declarative data definitions for OpenCode config generation.
 *
 * Extracted from opencode-config-writer.ts to convert imperative
 * server/formatter building into data-driven registries.
 *
 * - LOCAL_MCP_SERVER_DEFS: 7 local MCP server entries (was 97 lines of imperative code)
 * - FORMATTER_DEFS: 3 formatter detection entries (was 48 lines of if/for blocks)
 * - buildLocalMcpServersFromRegistry(): factory that iterates the registry
 */

import { join } from 'node:path'
import type { OpenCodeConfigWriterOptions } from '../opencode-config-writer'

// ── MCP Server Registry ──

export interface LocalMcpServerDef {
  id: string
  serverScript: string
  /** Evaluated at build time — return false to skip this server */
  condition: (opts: OpenCodeConfigWriterOptions) => boolean
  /** Build environment variables for this server */
  environment: (opts: OpenCodeConfigWriterOptions) => Record<string, string>
  timeout: number
}

export const LOCAL_MCP_SERVER_DEFS: LocalMcpServerDef[] = [
  {
    id: 'code-graph',
    serverScript: 'code-graph-server.js',
    condition: (opts) => !!(opts.featureFlags.repomapEnabled && opts.workspaceId),
    environment: (opts) => ({
      WORKSPACE_ID: opts.workspaceId!,
      WORKSPACE_PATH: opts.workspacePath,
      ...(opts.contextTier ? { CONTEXT_TIER: opts.contextTier } : {})
    }),
    // 6D-1: Code-graph indexes large repos — 5s default is too short
    timeout: 15_000
  },
  {
    id: 'semantic-search',
    serverScript: 'semantic-search-server.js',
    condition: (opts) => !!(opts.featureFlags.semanticSearchEnabled && opts.workspaceId),
    environment: (opts) => ({ WORKSPACE_ID: opts.workspaceId! }),
    // 6D-1: Embedding queries can be slow on first call
    timeout: 10_000
  },
  {
    id: 'git-context',
    serverScript: 'git-context-server.js',
    condition: () => true,
    environment: (opts) => ({ WORKSPACE_PATH: opts.workspacePath }),
    // 6D-1: Large repos with deep history
    timeout: 10_000
  },
  {
    id: 'code-analysis',
    serverScript: 'code-analysis-server.js',
    condition: () => true,
    environment: (opts) => {
      const env: Record<string, string> = { WORKSPACE_PATH: opts.workspacePath }
      if (opts.workspaceId) env.WORKSPACE_ID = opts.workspaceId
      return env
    },
    timeout: 8_000
  },
  {
    id: 'control-actions',
    serverScript: 'control-actions-server.js',
    condition: () => true,
    environment: (opts) => ({
      WORKSPACE_PATH: opts.workspacePath,
      ...(opts.ipcSocketPath ? { IPC_SOCKET_PATH: opts.ipcSocketPath } : {}),
      ...(opts.conversationId ? { CONVERSATION_ID: opts.conversationId } : {}),
      CONVERSATION_MODE: opts.mode
    }),
    timeout: 8_000
  },
  {
    id: 'memory',
    serverScript: 'memory-server.js',
    condition: (opts) => !!opts.workspaceId,
    environment: (opts) => ({ WORKSPACE_ID: opts.workspaceId! }),
    timeout: 8_000
  },
  {
    id: 'recall',
    serverScript: 'recall-server.js',
    condition: (opts) => !!opts.workspaceId,
    environment: (opts) => ({ WORKSPACE_ID: opts.workspaceId! }),
    timeout: 8_000
  }
]

/**
 * MCP servers that open the SQLite DB via getDatabase(). They run as plain `node`
 * (no Electron app global) so they must receive DB_PATH (the userData dir) explicitly.
 */
export const DB_BACKED_SERVER_IDS = new Set([
  'code-graph',
  'semantic-search',
  'code-analysis',
  'memory',
  'recall'
])

/**
 * Build local MCP server entries from the declarative registry.
 * Replaces the 97-line imperative buildLocalMcpServers() method.
 *
 * @param dbDir Electron userData dir, injected as DB_PATH for DB-backed servers.
 */
export function buildLocalMcpServersFromRegistry(
  defs: LocalMcpServerDef[],
  opts: OpenCodeConfigWriterOptions,
  serverBasePath: string,
  dbDir?: string
): Record<
  string,
  { type: 'local'; command: string[]; environment?: Record<string, string>; timeout: number }
> {
  const servers: Record<
    string,
    { type: 'local'; command: string[]; environment?: Record<string, string>; timeout: number }
  > = {}

  for (const def of defs) {
    if (!def.condition(opts)) continue
    const env = def.environment(opts)
    if (dbDir && DB_BACKED_SERVER_IDS.has(def.id)) {
      env.DB_PATH = dbDir
    }
    servers[def.id] = {
      type: 'local',
      command: ['node', join(serverBasePath, def.serverScript)],
      ...(Object.keys(env).length > 0 ? { environment: env } : {}),
      timeout: def.timeout
    }
  }

  return servers
}

// ── Formatter Detection Registry ──

export interface FormatterDef {
  /** Config files to check for — if any exists, this formatter is active */
  configFiles: string[]
  /** Command to run the formatter */
  command: string[]
  /** File extensions to format */
  extensions: string[]
}

export const FORMATTER_DEFS: FormatterDef[] = [
  {
    configFiles: [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs'
    ],
    command: ['npx', 'prettier', '--write'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.md']
  },
  {
    configFiles: ['biome.json', 'biome.jsonc'],
    command: ['npx', '@biomejs/biome', 'format', '--write'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
  },
  {
    configFiles: ['dprint.json', '.dprint.json'],
    command: ['npx', 'dprint', 'fmt'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.md']
  }
]

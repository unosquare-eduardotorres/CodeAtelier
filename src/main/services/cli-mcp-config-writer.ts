/**
 * CLI MCP Config Writer — generates --mcp-config JSON for Claude CLI sessions.
 *
 * When using the CLI executor backend (`claude --mcp-config <path>`), this
 * module generates the JSON configuration file that declares MCP servers
 * as stdio child processes. The CLI spawns each server and connects to it.
 *
 * Expected format:
 * ```json
 * {
 *   "mcpServers": {
 *     "code-graph": {
 *       "command": "node",
 *       "args": ["/path/to/code-graph-server.js"],
 *       "env": { "WORKSPACE_ID": "xxx", "WORKSPACE_PATH": "/path" }
 *     }
 *   }
 * }
 * ```
 *
 * Server list and feature-flag gating mirror OpenCodeConfigWriter.buildMcpServers().
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import log from 'electron-log/main'
import type { ConversationMode } from '../../shared/types'
import type { McpFeatureFlags } from './workspace-mcp-config'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { mountExternalIntegrations } from './cli-mcp-config-builders'
import { resolveActiveIntegrationEnvs } from './integration-credentials'

const configLog = log.scope('CliMcpConfigWriter')

// ── Types ──

/** A single MCP server entry in the CLI config format. */
interface CliMcpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Top-level CLI MCP config structure. */
interface CliMcpConfig {
  mcpServers: Record<string, CliMcpServerEntry>
}

/** Options for writing a CLI MCP config file. */
export interface CliMcpConfigWriterOptions {
  /**
   * The workspace's primary working tree.
   *
   * Workspace *identity* on disk — the repo the shared indexes were built
   * against. Not necessarily where this turn is executing.
   */
  workspacePath: string
  /**
   * Where this turn's CLI actually runs — a track's worktree, or
   * `workspacePath` when the owner has no isolation.
   *
   * Every per-tree server (lint, git, processes, control actions) must be
   * pointed here. Passing `workspacePath` instead is how an agent working in a
   * worktree came to report the primary tree's eslint results and
   * `git diff --name-only` as its own — wrong answers with no indication that
   * they were about a different directory.
   */
  executionPath: string
  workspaceId: string | null
  conversationId: string | null
  mode: ConversationMode
  featureFlags: McpFeatureFlags
  /** IPC socket path for control-actions server ↔ Electron main process. */
  ipcSocketPath?: string
  /**
   * Control-action callbacks — accepted for call-site compatibility with
   * buildCLIMcpConfigPath() but NOT used by the CLI writer. The
   * control-actions MCP server communicates via IPC socket instead.
   */
  controlCallbacks?: unknown
  /**
   * Server IDs to omit from the generated config. Blueprint sessions use this
   * to skip spawning servers whose tools aren't in allowedTools (e.g.
   * 'control-actions', 'semantic-search', 'code-analysis') — reducing
   * cold-start contention that causes the MCP connection race.
   */
  skipServers?: string[]
  /**
   * G1: Unique instance identifier for per-session config isolation.
   * When provided, the config file is written as `mcp-config-<instanceId>.json`
   * instead of the shared `mcp-config.json`, preventing parallel build tasks
   * from overwriting each other's config.
   */
  instanceId?: string
}

// ── Writer ──

export class CliMcpConfigWriter {
  /** Generated config paths per session key, for cleanup. */
  private readonly configPaths = new Map<string, Set<string>>()

  /** Stable directory name for one (workspace, execution tree) pair. */
  private treeKey(opts: CliMcpConfigWriterOptions): string {
    return createHash('sha256')
      .update(`${opts.workspacePath}\u0000${opts.executionPath}`)
      .digest('hex')
      .slice(0, 32)
  }

  /**
   * Generate a CLI MCP config JSON and write it to a temp file.
   * Returns the absolute path to the generated config file.
   */
  writeConfig(opts: CliMcpConfigWriterOptions): string {
    const config = this.buildConfig(opts)
    const serverCount = Object.keys(config.mcpServers).length

    // Write to temp directory — avoids polluting workspace git status.
    //
    // The directory is keyed on BOTH paths. It used to be a truncated base64 of
    // workspacePath alone, which meant every track of a workspace resolved to
    // the same directory: one session moving between two worktrees would write
    // both configs to one file and the second silently won. A digest rather
    // than a truncated encoding, because truncation collides for any two paths
    // sharing a long prefix — exactly what sibling worktrees are.
    const tempDir = join(tmpdir(), 'agent-studio-mcp', this.treeKey(opts))
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }
    // G1: Per-session config files prevent parallel build tasks from overwriting
    // each other's MCP configuration. Key includes instanceId when provided.
    const configFileName = opts.instanceId
      ? `mcp-config-${opts.instanceId}.json`
      : 'mcp-config.json'
    const configPath = join(tempDir, configFileName)

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    configLog.info(
      `[cli-mcp-config] Wrote: ${configPath} (${serverCount} MCP servers, cwd=${opts.executionPath})`
    )

    // Cleanup is keyed on the session, not the tree, and holds a SET of paths:
    // a session that worked in two trees generated two config files and the
    // caller (which only knows its workspace and instance) has no way to name
    // the second. Keying on executionPath here would leak every config but the
    // last one.
    const configKey = opts.instanceId
      ? `${opts.workspacePath}:${opts.instanceId}`
      : opts.workspacePath
    const existing = this.configPaths.get(configKey)
    if (existing) existing.add(configPath)
    else this.configPaths.set(configKey, new Set([configPath]))

    return configPath
  }

  /** Clean up generated config files. Pass instanceId for per-session configs. */
  dispose(workspacePath: string, instanceId?: string): void {
    const configKey = instanceId ? `${workspacePath}:${instanceId}` : workspacePath
    const paths = this.configPaths.get(configKey)
    if (!paths) return

    for (const configPath of paths) {
      try {
        unlinkSync(configPath)
        configLog.info(`[cli-mcp-config] Cleaned up: ${configPath}`)
      } catch {
        /* file may already be gone */
      }
    }
    this.configPaths.delete(configKey)
  }

  // ── Private ──

  private buildConfig(opts: CliMcpConfigWriterOptions): CliMcpConfig {
    const servers: Record<string, CliMcpServerEntry> = {}
    const { featureFlags, workspaceId, workspacePath, executionPath } = opts

    // Resolve MCP server script base path (packaged vs dev)
    const serverBasePath = app.isPackaged
      ? join(
          app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
          'out',
          'main',
          'mcp-servers'
        )
      : join(__dirname, 'mcp-servers')

    // DB-backed MCP servers run as plain `node` (no Electron app global), so they can't
    // resolve app.getPath('userData'). Pass the userData dir explicitly via DB_PATH.
    const dbDir = app.getPath('userData')

    log.info(`[cli-mcp-config] serverBasePath=${serverBasePath} isPackaged=${app.isPackaged}`)

    // ── Code Graph ──
    //
    // Scoped to the tree the agent is actually working in.
    //
    // This used to point at the primary tree on the theory that an index is one
    // per repository and a worktree only drifts by its own uncommitted edits.
    // That holds for a worktree on the same branch; it is badly wrong for a
    // track, which is on a branch of its own. A blueprint track whose branch
    // carried 78 source files against a primary tree holding 14 asked the graph
    // "where is this component defined" and got nothing back — and because
    // `hasPersistedIndex()` counts the whole workspace, the "no index, use Grep"
    // hint never fired either. The agent could not tell an empty answer from a
    // blind one and fell back to raw `grep -rn` for the rest of the run.
    //
    // A shadow workspace row gives the worktree its own index under the key the
    // graph is already keyed by, so nothing downstream needs to know it exists.
    if (featureFlags.repomapEnabled && workspaceId) {
      const inTrack = executionPath !== workspacePath
      let graphScopeId = workspaceId
      if (inTrack) {
        try {
          graphScopeId = workspaceRepository.ensureShadow(
            workspaceId,
            executionPath,
            basename(executionPath)
          ).id
        } catch (err) {
          // Fall back to the primary scope rather than losing the server: a
          // stale index is worse than it was, but no index at all is worse still.
          log.warn(`[cli-mcp-config] shadow scope failed for ${executionPath}:`, err)
        }
      }
      const codeGraphEnv: Record<string, string> = {
        WORKSPACE_ID: graphScopeId,
        WORKSPACE_PATH: inTrack ? executionPath : workspacePath,
        DB_PATH: dbDir
      }
      servers['code-graph'] = {
        command: 'node',
        args: [join(serverBasePath, 'code-graph-server.js')],
        env: codeGraphEnv
      }
    }

    // ── Semantic Search ── (also repo-wide; embeddings are indexed per workspace)
    if (featureFlags.semanticSearchEnabled && workspaceId) {
      servers['semantic-search'] = {
        command: 'node',
        args: [join(serverBasePath, 'semantic-search-server.js')],
        env: { WORKSPACE_ID: workspaceId, DB_PATH: dbDir }
      }
    }

    // ── Memory ──
    if (workspaceId) {
      servers['memory'] = {
        command: 'node',
        args: [join(serverBasePath, 'memory-server.js')],
        env: { WORKSPACE_ID: workspaceId, DB_PATH: dbDir }
      }
    }

    // ── Recall ── (past plans + surrounding conversation)
    if (workspaceId) {
      servers['recall'] = {
        command: 'node',
        args: [join(serverBasePath, 'recall-server.js')],
        env: { WORKSPACE_ID: workspaceId, DB_PATH: dbDir }
      }
    }

    // ── Git Context ──
    //
    // Per-tree: a worktree has its own HEAD, its own branch and its own diff.
    // Pointed at the primary tree it answered "what changed" with the user's
    // uncommitted edits instead of the agent's.
    servers['git-context'] = {
      command: 'node',
      args: [join(serverBasePath, 'git-context-server.js')],
      env: { WORKSPACE_PATH: executionPath }
    }

    // ── Code Analysis ── (per-tree: lints and typechecks the files it wrote)
    const codeAnalysisEnv: Record<string, string> = {
      WORKSPACE_PATH: executionPath
    }
    if (workspaceId) codeAnalysisEnv.WORKSPACE_ID = workspaceId
    if (dbDir) codeAnalysisEnv.DB_PATH = dbDir
    const context7Key = appPreferenceRepository.get('context7_api_key')
    if (context7Key) codeAnalysisEnv.CONTEXT7_API_KEY = context7Key
    servers['code-analysis'] = {
      command: 'node',
      args: [join(serverBasePath, 'code-analysis-server.js')],
      env: codeAnalysisEnv
    }

    // ── Process Manager ── (per-tree: dev servers run against the tree's code)
    servers['process-manager'] = {
      command: 'node',
      args: [join(serverBasePath, 'process-manager-server.js')],
      env: { WORKSPACE_PATH: executionPath }
    }

    // ── Control Actions ── (per-tree: file actions resolve against the cwd)
    const controlEnv: Record<string, string> = {
      WORKSPACE_PATH: executionPath,
      CONVERSATION_MODE: opts.mode
    }
    if (opts.ipcSocketPath) {
      controlEnv.IPC_SOCKET_PATH = opts.ipcSocketPath
    }
    if (opts.conversationId) {
      controlEnv.CONVERSATION_ID = opts.conversationId
    }
    servers['control-actions'] = {
      command: 'node',
      args: [join(serverBasePath, 'control-actions-server.js')],
      env: controlEnv
    }

    // ── External MCP Integrations (Maestro, Jira, etc.) ──
    const externalActive = featureFlags.externalMcpActive ?? {}
    const externalEnvs = resolveActiveIntegrationEnvs(externalActive, workspaceId)
    mountExternalIntegrations(
      servers,
      externalActive,
      externalEnvs,
      process.env.HOME ?? '',
      serverBasePath
    )
    for (const id of Object.keys(externalEnvs)) {
      configLog.info(`[cli-mcp-config] Mounted external MCP: ${id}`)
    }

    // Remove explicitly skipped servers (blueprint sessions skip servers
    // whose tools aren't in allowedTools — fewer cold-start processes).
    if (opts.skipServers?.length) {
      for (const serverId of opts.skipServers) {
        if (servers[serverId]) {
          delete servers[serverId]
          configLog.info(`[cli-mcp-config] Skipped (not in allowedTools): ${serverId}`)
        }
      }
    }

    // Apply per-chat MCP toggles — remove disabled servers entirely
    // (CLI config doesn't support enabled:false like OpenCode does)
    for (const [serverId, enabled] of Object.entries(featureFlags.localMcpActive)) {
      if (enabled === false && servers[serverId]) {
        delete servers[serverId]
        configLog.info(`[cli-mcp-config] Disabled MCP: ${serverId}`)
      }
    }

    return { mcpServers: servers }
  }
}

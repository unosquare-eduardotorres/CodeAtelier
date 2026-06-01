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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import log from 'electron-log/main'
import type { ConversationMode } from '../../shared/types'
import type { McpFeatureFlags } from './workspace-mcp-config'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'

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
  workspacePath: string
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
}

// ── Writer ──

export class CliMcpConfigWriter {
  /** Track generated config paths for cleanup. */
  private readonly configPaths = new Map<string, string>()

  /**
   * Generate a CLI MCP config JSON and write it to a temp file.
   * Returns the absolute path to the generated config file.
   */
  writeConfig(opts: CliMcpConfigWriterOptions): string {
    const config = this.buildConfig(opts)
    const serverCount = Object.keys(config.mcpServers).length

    // Write to temp directory — avoids polluting workspace git status
    const tempDir = join(
      tmpdir(),
      'agent-studio-mcp',
      Buffer.from(opts.workspacePath).toString('base64url').slice(0, 32)
    )
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }
    const configPath = join(tempDir, 'mcp-config.json')

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    configLog.info(`[cli-mcp-config] Wrote: ${configPath} (${serverCount} MCP servers)`)

    // Store for cleanup
    this.configPaths.set(opts.workspacePath, configPath)

    return configPath
  }

  /** Clean up generated config file. */
  dispose(workspacePath: string): void {
    const configPath = this.configPaths.get(workspacePath)
    if (configPath) {
      try {
        unlinkSync(configPath)
        configLog.info(`[cli-mcp-config] Cleaned up: ${configPath}`)
      } catch {
        /* file may already be gone */
      }
      this.configPaths.delete(workspacePath)
    }
  }

  // ── Private ──

  private buildConfig(opts: CliMcpConfigWriterOptions): CliMcpConfig {
    const servers: Record<string, CliMcpServerEntry> = {}
    const { featureFlags, workspaceId, workspacePath } = opts

    // Resolve MCP server script base path (packaged vs dev)
    const serverBasePath = app.isPackaged
      ? join(
          app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
          'out',
          'main',
          'mcp-servers'
        )
      : join(__dirname, 'mcp-servers')

    log.info(`[cli-mcp-config] serverBasePath=${serverBasePath} isPackaged=${app.isPackaged}`)

    // ── Code Graph ──
    if (featureFlags.repomapEnabled && workspaceId) {
      servers['code-graph'] = {
        command: 'node',
        args: [join(serverBasePath, 'code-graph-server.js')],
        env: {
          WORKSPACE_ID: workspaceId,
          WORKSPACE_PATH: workspacePath
        }
      }
    }

    // ── Semantic Search ──
    if (featureFlags.semanticSearchEnabled && workspaceId) {
      servers['semantic-search'] = {
        command: 'node',
        args: [join(serverBasePath, 'semantic-search-server.js')],
        env: { WORKSPACE_ID: workspaceId }
      }
    }

    // ── Git Context ──
    servers['git-context'] = {
      command: 'node',
      args: [join(serverBasePath, 'git-context-server.js')],
      env: { WORKSPACE_PATH: workspacePath }
    }

    // ── Checkpoint Context ── (only when resuming a conversation)
    if (opts.conversationId) {
      servers['checkpoint-context'] = {
        command: 'node',
        args: [join(serverBasePath, 'checkpoint-context-server.js')],
        env: {
          CONVERSATION_ID: opts.conversationId,
          WORKSPACE_PATH: workspacePath
        }
      }
    }

    // ── GitHub Context ──
    if (featureFlags.githubConfigured && workspaceId) {
      servers['github-context'] = {
        command: 'node',
        args: [join(serverBasePath, 'github-context-server.js')],
        env: {
          WORKSPACE_ID: workspaceId,
          WORKSPACE_PATH: workspacePath
        }
      }
    }

    // ── Code Analysis ──
    servers['code-analysis'] = {
      command: 'node',
      args: [join(serverBasePath, 'code-analysis-server.js')],
      env: { WORKSPACE_PATH: workspacePath }
    }

    // ── Control Actions ──
    const controlEnv: Record<string, string> = {
      WORKSPACE_PATH: workspacePath,
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

    // ── External MCP Integrations (Maestro, etc.) ──
    const externalActive = featureFlags.externalMcpActive ?? {}
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      if (externalActive[integration.id]) {
        const env: Record<string, string> = {}

        // Copy env vars the integration expects
        if (integration.envKeys) {
          for (const key of integration.envKeys) {
            if (process.env[key]) {
              env[key] = process.env[key]!
            }
          }
        }

        // Add performance env overrides
        if (integration.performanceEnv) {
          Object.assign(env, integration.performanceEnv)
        }

        // Resolve the command — try commandPaths first, then bare command
        let resolvedCommand = integration.command
        if (integration.commandPaths) {
          for (const cmdPath of integration.commandPaths) {
            const expanded = cmdPath.replace('~', process.env.HOME ?? '')
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
        configLog.info(`[cli-mcp-config] Mounted external MCP: ${integration.id}`)
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

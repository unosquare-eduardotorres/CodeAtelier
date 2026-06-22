/**
 * OpenCode Config Writer — generates opencode.json for workspace sessions.
 *
 * When using the OpenCode executor backend, this module generates the
 * opencode.json configuration file that OpenCode reads for:
 *   - Provider selection (Claude, Ollama, oMLX, OpenAI, etc.)
 *   - MCP server connections (same servers as CLI backend)
 *   - Plugin loading (.opencode/plugins/code-atelier.ts)
 *   - Tool permissions and shell settings
 *
 * The generated config is placed in the workspace root (OpenCode reads
 * from the cwd). It reuses the same McpConfigWriter logic to determine
 * which servers to mount based on workspace feature flags.
 *
 * Phase 4B — OpenCode Evaluation: MCP server wiring.
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import log from 'electron-log/main'
import type { ConversationMode } from '../../shared/types'
import type { ContextWindowTier } from './context-management'
import type { OpenCodeProviderConfig } from './opencode-executor'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'
import {
  LOCAL_MCP_SERVER_DEFS,
  FORMATTER_DEFS,
  buildLocalMcpServersFromRegistry
} from './opencode-config-writer/opencode-config-data'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'

const configLog = log.scope('OpenCodeConfigWriter')

// ── Types ──

/**
 * OpenCode config file structure — comprehensive coverage of all OpenCode fields.
 * Reference: https://opencode.ai/docs/config/
 */
interface OpenCodeConfig {
  $schema: string
  model: string
  /** Lightweight model for housekeeping tasks (title generation, summarization) */
  small_model?: string
  /** Default agent to use (name from .opencode/agents/) */
  default_agent?: string
  provider: Record<
    string,
    {
      baseUrl?: string
      apiKey?: string
      /** Request timeout in ms — cloud: 300000, local: 600000 */
      timeout?: number
      /** Chunk timeout in ms — detects stalled streams */
      chunkTimeout?: number
      /** C-1: Ensure prompt cache keys are always set (Anthropic) — up to 90% cost reduction */
      setCacheKey?: boolean
      /** C-5: Override context/output limits for models that advertise larger windows than they handle */
      limit?: { context?: number; output?: number }
    }
  >
  mcp: Record<
    string,
    {
      type: 'local' | 'remote'
      command?: string[]
      /** GAP-22: OpenCode uses `environment` (not `env`) per MCP docs */
      environment?: Record<string, string>
      /** 6D-1: Per-server request timeout in ms */
      timeout?: number
      /** 6D-2: Explicitly disable a server without deleting its config */
      enabled?: boolean
      /** GAP-8: Remote MCP server URL */
      url?: string
      /** GAP-8: Remote MCP server headers (auth tokens, API keys) */
      headers?: Record<string, string>
      /** GAP-8: Remote MCP OAuth configuration */
      oauth?: {
        client_id: string
        authorization_url: string
        token_url: string
        scope?: string
      }
    }
  >
  plugin: string[]
  instructions: string[]
  tools: Record<string, unknown>
  /** Glob-based permission patterns per tool (e.g. { Bash: { '*': 'ask', 'git status *': 'allow' } }) */
  permission: Record<string, string | Record<string, string>>
  compaction: {
    enabled: boolean
    /** Auto-compact when context window is full */
    auto?: boolean
    /** Remove old tool outputs before summarizing */
    prune?: boolean
    /** Token buffer reserved for safety headroom */
    reserved?: number
  }
  snapshot: boolean
  /** Automatic code formatting after file edits */
  formatter?: {
    enabled: boolean
    /** B-6: Explicit formatter command (e.g. ["npx", "prettier", "--write"]) */
    command?: string[]
    /** B-6: File extensions to format */
    extensions?: string[]
  }
  /** LSP integration for compiler diagnostics */
  lsp?: {
    enabled: boolean
    /** Disable for specific languages */
    disabled?: string[]
  }
  /** Image attachment configuration */
  attachment?: {
    image?: {
      auto_resize?: boolean
      max_width?: number
      max_height?: number
      max_base64_bytes?: number
    }
  }
  /** File watcher configuration */
  watcher?: {
    enabled: boolean
    /** Glob patterns to ignore from file watching */
    ignore?: string[]
  }
  /** C-6/A-3: Shell configuration — executable + environment */
  shell?: {
    /** Shell executable path — explicit to prevent Windows cmd.exe issues */
    executable?: string
    /** Environment variables injected into all Bash tool executions */
    env?: Record<string, string>
  }
  /** Server configuration — CORS origins, mDNS, etc. */
  server?: {
    cors?: string[]
    mdns?: boolean
  }
  /** Session sharing mode */
  share?: 'manual' | 'auto' | 'disabled'
  /** C-4: Control automatic updates — we manage SDK version via package.json */
  autoupdate?: boolean | 'notify'
  /** C-2: Allowlist for provider loading */
  enabled_providers?: string[]
  /** C-2: Denylist for provider loading */
  disabled_providers?: string[]
  /** GAP-19: Experimental features */
  experimental?: {
    /** Enable background subagents (v1.14.51+) — tasks continue while agent works */
    backgroundSubagents?: boolean
  }
}

export interface OpenCodeConfigWriterOptions {
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
  mode: ConversationMode
  provider: OpenCodeProviderConfig
  featureFlags: {
    repomapEnabled: boolean
    semanticSearchEnabled: boolean
    githubConfigured: boolean
    localMcpActive: Record<string, boolean>
    /** External MCPs active for this chat (e.g. { maestro: true }) */
    externalMcpActive?: Record<string, boolean>
  }
  contextTier?: ContextWindowTier
  /** IPC socket path for control-actions server */
  ipcSocketPath?: string
  /** Enable LSP diagnostics integration */
  lspEnabled?: boolean
  /** Enable automatic code formatting after agent edits */
  formatterEnabled?: boolean
  /** Whether the provider is a local LLM (Ollama/oMLX) — drives timeout selection */
  isLocalProvider?: boolean
  /** D-1: System prompt for injection via experimental.chat.system.transform hook */
  systemPrompt?: string
  /** E-9: Enable web search/fetch tools (requires Exa AI or equivalent) */
  webSearchEnabled?: boolean
  /** GAP-8: Remote MCP server configurations from workspace settings */
  remoteMcpServers?: Record<
    string,
    {
      url: string
      headers?: Record<string, string>
      oauth?: {
        client_id: string
        authorization_url: string
        token_url: string
        scope?: string
      }
      enabled?: boolean
    }
  >
}

// ── Writer ──

export class OpenCodeConfigWriter {
  /**
   * Generate an opencode.json config for the workspace.
   * Returns the path to the generated config file.
   */
  writeConfig(opts: OpenCodeConfigWriterOptions): string {
    const config = this.buildConfig(opts)

    // Write to a temp directory to avoid polluting the workspace with
    // untracked files that would show in `git status` and potentially
    // get committed accidentally.
    const tempDir = join(
      tmpdir(),
      'code-atelier-opencode',
      Buffer.from(opts.workspacePath).toString('base64url').slice(0, 32)
    )
    if (!existsSync(tempDir)) {
      // OC-02: Restrict permissions — config may contain plaintext API keys
      mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    }
    const configPath = join(tempDir, 'opencode.json')

    // OC-02: Owner-only read/write — prevents other users from reading API keys
    writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
    configLog.info(
      `[opencode-config] Wrote: ${configPath} (${Object.keys(config.mcp).length} MCP servers)`
    )

    // Store the config path for cleanup
    this.configPaths.set(opts.workspacePath, configPath)

    return configPath
  }

  /** Track generated config paths for cleanup */
  private readonly configPaths = new Map<string, string>()

  /**
   * Get the config path for a workspace.
   */
  getConfigPath(workspacePath: string): string | undefined {
    return this.configPaths.get(workspacePath)
  }

  /**
   * Clean up the generated config file.
   */
  dispose(workspacePath: string): void {
    const configPath = this.configPaths.get(workspacePath)
    if (!configPath) return

    try {
      unlinkSync(configPath)
      this.configPaths.delete(workspacePath)
    } catch {
      /* non-fatal — file may not exist */
    }
  }

  // ── Private ──

  private buildConfig(opts: OpenCodeConfigWriterOptions): OpenCodeConfig {
    const { provider, workspacePath, contextTier } = opts
    const isLocal = opts.isLocalProvider ?? false

    // Resolve the model string in OpenCode format: provider/model
    const modelString = `${provider.providerId}/${provider.modelId}`

    // ── #5: Small model for housekeeping (title gen, summarization) ──
    const smallModel = this.resolveSmallModel(provider.providerId)

    // Build provider config with timeouts (#15)
    const providers = this.buildProviderConfig(provider, isLocal, contextTier)

    // Build MCP server config
    const mcp = this.buildMcpServers(opts)

    // Resolve plugin path
    const pluginDir = join(workspacePath, '.opencode', 'plugins')
    const plugins: string[] = []
    if (existsSync(join(pluginDir, 'code-atelier.ts'))) {
      plugins.push('.opencode/plugins/code-atelier.ts')
    }

    // C-7: Build instructions from workspace instruction files.
    const instructions = this.buildInstructions(workspacePath)

    // ── #19: Glob-based permissions for plan mode ──
    const permission = this.buildPermissions(opts.mode)

    // ── #7: Tier-aware compaction config ──
    const compaction = this.buildCompactionConfig(contextTier)

    // ── #8: Shell environment injection ──
    const shellEnv = this.buildShellEnvironment(opts)

    const config: OpenCodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: modelString,
      ...(smallModel ? { small_model: smallModel } : {}),
      // A-4: Always set default_agent so DaVinci is the active agent after server start
      default_agent: 'DaVinci',
      // C-4: Disable autoupdate — we bundle @opencode-ai/sdk as a dependency;
      // a server-side update would create a version mismatch.
      autoupdate: false,
      provider: providers,
      // C-2: Provider allowlist/denylist based on workspace configuration.
      // When using local LLMs only, disable cloud providers to prevent
      // accidental API cost and reduce startup time.
      ...(isLocal
        ? { disabled_providers: ['anthropic', 'openai', 'google', 'aws'] }
        : { enabled_providers: [provider.providerId] }),
      mcp,
      plugin: plugins,
      instructions,
      // C-3: Configure built-in tool availability.
      // - `question: false` — disable OpenCode's built-in ask-user tool since we have
      //   our own more integrated ask_user flow via the control-actions MCP server.
      //   Having both would confuse the agent with duplicate ask-user capabilities.
      // - `skill: true` — keep enabled; our 22+ skills in .claude/skills/ are natively
      //   discoverable by OpenCode.
      // - `todowrite: true` — keep enabled for plan tracking integration.
      // E-9: websearch/webfetch enabled via workspace feature flag.
      tools: {
        question: false,
        // B-5: Disable customize-opencode skill — config is managed by Code Atelier
        // and the agent modifying opencode.json in the workspace wouldn't affect
        // our runtime config (which is in a temp dir).
        skill: { 'customize-opencode': false },
        ...(opts.webSearchEnabled ? { websearch: true, webfetch: true } : {})
      },
      permission,
      compaction,
      snapshot: true,
      // A-3: Shell config uses a single object with both executable + env
      shell: {
        executable: process.platform === 'win32' ? 'pwsh' : '/bin/bash',
        env: shellEnv
      }
    }

    // ── #18/B-6: Formatter config with auto-detection ──
    if (opts.formatterEnabled) {
      config.formatter = this.detectFormatter(opts.workspacePath)
    }

    // ── #13: LSP integration ──
    if (opts.lspEnabled) {
      config.lsp = { enabled: true }
    }

    // ── #16: Image attachment configuration ──
    config.attachment = {
      image: {
        auto_resize: true,
        max_width: 1920,
        max_height: 1080,
        max_base64_bytes: 5_242_880 // 5 MB
      }
    }

    // ── ENH-4: File watcher ignore patterns ──
    config.watcher = {
      enabled: true,
      ignore: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        '.opencode/**',
        'coverage/**',
        '.next/**',
        '.nuxt/**',
        'out/**',
        '*.lock'
      ]
    }

    // ── ENH-12: Restrict CORS/mDNS for in-process server ──
    // We run the server in-process — no need for network discovery or broad CORS.
    config.server = {
      cors: ['http://localhost:*'],
      mdns: false
    }

    // ── ENH-11: Session sharing defaults (privacy-safe) ──
    config.share = 'disabled'

    // GAP-19: Enable background subagents in build mode (v1.14.51+)
    // Allows subagents to continue research while the primary agent works.
    if (opts.mode === 'build') {
      config.experimental = { backgroundSubagents: true }
    }

    return config
  }

  /**
   * #5: Resolve a lightweight small model for housekeeping tasks.
   * Avoids burning expensive model tokens on title generation, summarization.
   */
  private resolveSmallModel(providerId: string): string | undefined {
    switch (providerId) {
      case 'anthropic':
        return 'anthropic/claude-haiku-3-5'
      case 'openai':
        // D-4: GPT-4o-mini for lightweight housekeeping tasks
        return 'openai/gpt-4o-mini'
      case 'google':
        // D-4: Gemini Flash Lite for fast, cheap housekeeping
        return 'google/gemini-2.0-flash-lite'
      case 'ollama':
        return 'ollama/qwen3:8b'
      case 'omlx':
        return undefined // oMLX models are already small
      default:
        return undefined
    }
  }

  /**
   * #19: Build glob-based permission config.
   * In plan mode, auto-approve safe Bash commands while requiring
   * confirmation for mutations. In build mode, allow everything.
   */
  private buildPermissions(mode: ConversationMode): OpenCodeConfig['permission'] {
    if (mode === 'build' || mode === 'danger') {
      return {
        Write: 'allow',
        Edit: 'allow',
        Bash: 'allow',
        Read: 'allow',
        Glob: 'allow',
        Grep: 'allow',
        // B-7: Subagent invocation allowed in build mode
        task: 'allow',
        // C-3: Allow doom loop detection to prevent token waste
        doom_loop: 'allow',
        // Allow web tools when configured
        websearch: 'allow',
        webfetch: 'allow',
        // LSP and skill always allowed
        lsp: 'allow',
        skill: 'allow',
        todowrite: 'allow'
      }
    }

    // Plan mode: granular Bash permissions via glob patterns
    return {
      Write: 'ask',
      Edit: 'ask',
      Bash: {
        '*': 'ask',
        // Safe read-only commands auto-approved in plan mode
        'git status *': 'allow',
        'git log *': 'allow',
        'git diff *': 'allow',
        'git branch *': 'allow',
        'npm test *': 'allow',
        'npm run typecheck *': 'allow',
        'npm run lint *': 'allow',
        'npx tsc --noEmit *': 'allow',
        'ls *': 'allow',
        'cat *': 'allow',
        'head *': 'allow',
        'tail *': 'allow',
        'wc *': 'allow',
        'find *': 'allow'
      },
      Read: 'allow',
      Glob: 'allow',
      Grep: 'allow',
      // B-7: Block subagent invocation in plan mode — prevents bypassing
      // Write/Edit/Bash restrictions via a subagent with full permissions.
      task: 'deny',
      // B-7: Block access outside workspace in plan mode
      external_directory: 'deny',
      // C-3: Allow doom loop detection in plan mode too
      doom_loop: 'allow',
      // Allow planning tools
      todowrite: 'allow',
      skill: 'allow',
      lsp: 'allow'
    }
  }

  /**
   * B-6: Auto-detect the project's code formatter.
   * Uses FORMATTER_DEFS registry — adding a new formatter is a data entry.
   */
  private detectFormatter(workspacePath: string): NonNullable<OpenCodeConfig['formatter']> {
    for (const def of FORMATTER_DEFS) {
      if (def.configFiles.some((f) => existsSync(join(workspacePath, f)))) {
        return { enabled: true, command: def.command, extensions: def.extensions }
      }
    }
    // No specific formatter detected — use enabled-only (OpenCode default formatter)
    return { enabled: true }
  }

  /**
   * #7: Build tier-aware compaction configuration.
   * Small context windows get aggressive compaction; large windows are conservative.
   */
  private buildCompactionConfig(tier?: ContextWindowTier): OpenCodeConfig['compaction'] {
    switch (tier) {
      case 'small':
        return { enabled: true, auto: true, prune: true, reserved: 4096 }
      case 'medium':
        return { enabled: true, auto: true, prune: true, reserved: 8192 }
      case 'large':
        return { enabled: true, auto: true, prune: true, reserved: 16384 }
      default:
        // Cloud providers (Anthropic) — large context, conservative
        return { enabled: true, auto: true, prune: true, reserved: 8192 }
    }
  }

  /** #15: Build provider entry with tier-aware timeouts and caching. */
  private buildProviderConfig(
    provider: OpenCodeConfigWriterOptions['provider'],
    isLocal: boolean,
    contextTier?: ContextWindowTier
  ): OpenCodeConfig['provider'] {
    const providers: OpenCodeConfig['provider'] = {}
    if (provider.baseUrl || provider.apiKey || isLocal || provider.providerId === 'anthropic') {
      providers[provider.providerId] = {
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        // #15: Tier-aware timeouts — local models are slower
        timeout: isLocal ? 600_000 : 300_000,
        chunkTimeout: isLocal ? 30_000 : 15_000,
        // C-1: Enable prompt caching for Anthropic
        ...(provider.providerId === 'anthropic' ? { setCacheKey: true } : {}),
        // C-5: Context/output limits for local models
        ...(isLocal && contextTier
          ? {
              limit: {
                context: contextTier === 'small' ? 8192 : contextTier === 'medium' ? 32768 : 131072
              }
            }
          : {})
      }
    }
    return providers
  }

  /** C-7: Discover workspace instruction files and glob patterns. */
  private buildInstructions(workspacePath: string): string[] {
    const instructions: string[] = []
    const instructionFiles = [
      'CLAUDE.md',
      'AGENTS.md',
      '.github/CONTRIBUTING.md',
      'CONTRIBUTING.md'
    ]
    for (const file of instructionFiles) {
      if (existsSync(join(workspacePath, file))) {
        instructions.push(`{file:${file}}`)
      }
    }

    // 6D-4: Add glob patterns for broader context discovery.
    const instructionGlobs = [
      'docs/architecture/*.md', // Architecture decision records
      '.cursor/rules/*.md' // Cursor rules (cross-tool compat)
    ]
    for (const glob of instructionGlobs) {
      instructions.push(`{file:${glob}}`)
    }
    return instructions
  }

  /** #8: Build shell environment vars for the agent subprocess. */
  private buildShellEnvironment(opts: OpenCodeConfigWriterOptions): Record<string, string> {
    const { workspacePath, workspaceId } = opts
    const shellEnv: Record<string, string> = {
      WORKSPACE_PATH: workspacePath,
      GIT_TERMINAL_PROMPT: '0'
    }
    if (workspaceId) shellEnv.WORKSPACE_ID = workspaceId
    // Pass IPC socket path so the plugin can send events to the main process
    if (opts.ipcSocketPath) shellEnv.IPC_SOCKET_PATH = opts.ipcSocketPath
    // Prevent OOM in heavy Node.js tasks spawned by the agent
    shellEnv.NODE_OPTIONS = '--max-old-space-size=4096'

    // D-1: Write system prompt to a temp file and pass its path via env var.
    // This avoids env var size limits (system prompts can be 10KB+).
    if (opts.systemPrompt) {
      const promptFilePath = join(
        tmpdir(),
        'code-atelier-opencode',
        Buffer.from(opts.workspacePath).toString('base64url').slice(0, 32),
        'system-prompt.txt'
      )
      writeFileSync(promptFilePath, opts.systemPrompt, 'utf-8')
      shellEnv.CODE_ATELIER_SYSTEM_PROMPT_FILE = promptFilePath
    }
    return shellEnv
  }

  /**
   * Build MCP server declarations for OpenCode.
   * Same servers as CLI, different format.
   */
  private buildMcpServers(opts: OpenCodeConfigWriterOptions): OpenCodeConfig['mcp'] {
    const servers: OpenCodeConfig['mcp'] = {}

    // Compose from 3 focused sub-builders
    Object.assign(servers, this.buildLocalMcpServers(opts))
    this.buildExternalMcpServers(opts, servers)
    this.buildRemoteMcpServers(opts, servers)

    // 6D-2: Apply per-chat MCP toggles — use enabled:false instead of deleting.
    // This preserves the config for re-enabling without regeneration.
    const { featureFlags } = opts
    for (const [serverId, enabled] of Object.entries(featureFlags.localMcpActive)) {
      if (enabled === false && servers[serverId]) {
        servers[serverId].enabled = false
        configLog.info(`[opencode-config] Disabled MCP: ${serverId}`)
      }
    }

    return servers
  }

  /** Local MCP servers bundled with the app — built from declarative registry. */
  private buildLocalMcpServers(opts: OpenCodeConfigWriterOptions): OpenCodeConfig['mcp'] {
    // Resolve server script base path
    const serverBasePath = app.isPackaged
      ? join(
          app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
          'out',
          'main',
          'mcp-servers'
        )
      : join(__dirname, 'mcp-servers')

    // DB-backed servers (code-graph, semantic-search, code-analysis) run as plain `node`
    // and can't call app.getPath() — pass the userData dir as DB_PATH so they locate the DB.
    const servers = buildLocalMcpServersFromRegistry(
      LOCAL_MCP_SERVER_DEFS,
      opts,
      serverBasePath,
      app.getPath('userData')
    )

    // Inject CONTEXT7_API_KEY for library documentation fallback
    const context7Key = appPreferenceRepository.get('context7_api_key')
    if (context7Key && servers['code-analysis']) {
      servers['code-analysis'].environment = {
        ...servers['code-analysis'].environment,
        CONTEXT7_API_KEY: context7Key
      }
    }

    return servers
  }

  /** External MCP integrations (Maestro, etc.) registered via feature flags. */
  private buildExternalMcpServers(
    opts: OpenCodeConfigWriterOptions,
    servers: OpenCodeConfig['mcp']
  ): void {
    const externalActive = opts.featureFlags.externalMcpActive ?? {}
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      if (externalActive[integration.id]) {
        // Build env from the integration's envKeys
        const env: Record<string, string> = {}
        for (const key of integration.envKeys ?? []) {
          if (process.env[key]) {
            env[key] = process.env[key]!
          }
        }
        // Add any performance env overrides
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
          type: 'local',
          command: [resolvedCommand, ...integration.args],
          environment: Object.keys(env).length > 0 ? env : undefined
        }
        configLog.info(`[opencode-config] Mounted external MCP: ${integration.id}`)
      }
    }
  }

  /** GAP-8: Remote MCP servers (cloud code analysis, team indexes, CI/CD endpoints). */
  private buildRemoteMcpServers(
    opts: OpenCodeConfigWriterOptions,
    servers: OpenCodeConfig['mcp']
  ): void {
    if (!opts.remoteMcpServers) return
    for (const [serverId, remote] of Object.entries(opts.remoteMcpServers)) {
      servers[serverId] = {
        type: 'remote',
        url: remote.url,
        ...(remote.headers ? { headers: remote.headers } : {}),
        ...(remote.oauth ? { oauth: remote.oauth } : {}),
        ...(remote.enabled === false ? { enabled: false } : {})
      }
      configLog.info(`[opencode-config] Mounted remote MCP: ${serverId} (${remote.url})`)
    }
  }
}

/** Singleton instance */
export const openCodeConfigWriter = new OpenCodeConfigWriter()

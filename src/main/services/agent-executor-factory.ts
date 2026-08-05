/**
 * AgentExecutorFactory — builds executor options for CLI and OpenCode
 * backends (derived from LLM provider). Resolves MCP feature flags, hook
 * paths, budget caps, and local LLM context windows.
 *
 * Extracted from AgentSessionService to reduce god-class complexity.
 * Holds a back-reference to the session for state access.
 *
 * @internal Not for use outside the agent-session module.
 */

import type { AgentSessionHost, CLIExecuteOptions } from './agent-session-host'
import type { AdapterMcpResult } from './agent-session.types'
import type { McpFeatureFlags } from './workspace-mcp-config'
import { deriveSkipServers } from './mcp-skip-servers'

import type { ConversationMode } from '../../shared/types'
import {
  BUDGET_CAP_MODE_MULTIPLIERS,
  CLAUDE_1M_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  EXTERNAL_MCP_INTEGRATIONS,
  MCP_TOOLS,
  RECOMMENDED_LOCAL_MODELS,
  resolveModelAction,
  supportsContext1M
} from '../../shared/constants'

import { modelConfigService } from './model-config.service'
import { resolveModelFromSnapshot } from './snapshot-model-resolver'
import { contextWindowResolver } from './context-window-resolver'
import { resolveClaudeCompactionEnv, resolveSdkContextWindowSize } from './compaction-policy'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { join } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'

export class AgentExecutorFactory {
  private readonly s: AgentSessionHost
  /** Cached MCP config path — reused on continueSession turns to avoid rebuild. */
  private cachedMcpConfigPath: string | undefined
  /** Whether control-actions server was mounted in the last MCP config (for permission prompt gating). */
  private cachedControlActionsMounted = false
  /** Cached async-resolved context window + confidence flag. */
  private cachedContextWindow: number | null = null
  private cachedContextWindowConfident = false
  /** F18: 1M context beta header — extracted from magic string for maintainability. */
  private static readonly CONTEXT_1M_BETA = 'context-1m-2025-08-07'

  constructor(session: unknown) {
    this.s = session as AgentSessionHost
  }

  // F6: Invalidate the cached MCP config so the next turn rebuilds it.
  // Called on mode switch to ensure permission changes take effect immediately.
  invalidateMcpConfigCache(): void {
    this.cachedMcpConfigPath = undefined
  }

  /** Expose the cached MCP config path so recovery turns can re-mount control-actions/emit_plan. */
  getCachedMcpConfigPath(): string | undefined {
    return this.cachedMcpConfigPath
  }

  // ── resolveLocalContextWindow ─────────────────────────────────────────

  /** Sync fallback — checks static RECOMMENDED_LOCAL_MODELS only. */
  resolveLocalContextWindow(): number {
    if (!this.s.workspacePath) return 131_072
    try {
      const localConfig = modelConfigService.getLocalLLMConfig(this.s.workspacePath)
      const model = localConfig.localModel
      const recommended = RECOMMENDED_LOCAL_MODELS.find(
        (m) => m.ollamaId === model || m.omlxId === model
      )
      return recommended?.contextWindow ?? 131_072
    } catch {
      return 131_072
    }
  }

  /**
   * Async resolver — uses the full ContextWindowResolver chain:
   *   user override → backend API query → known models → 128K fallback.
   *
   * Caches the result for the session lifetime so subsequent calls are free.
   * Returns `confident: true` when the value came from a user override or
   * backend API (not the static table fallback), which gates whether we
   * write `models.*.limit` into opencode.json.
   */
  async resolveLocalContextWindowAsync(): Promise<{ contextWindow: number; confident: boolean }> {
    if (this.cachedContextWindow !== null) {
      return { contextWindow: this.cachedContextWindow, confident: this.cachedContextWindowConfident }
    }

    if (!this.s.workspacePath) {
      return { contextWindow: 131_072, confident: false }
    }

    try {
      const localConfig = modelConfigService.getLocalLLMConfig(this.s.workspacePath)
      const settings = workspaceRepository.getSettingsByPath(this.s.workspacePath)
      const userOverride =
        typeof settings?.localContextWindow === 'number' ? settings.localContextWindow : undefined

      const resolved = await contextWindowResolver.resolve(localConfig, userOverride)

      // Confident if user explicitly set a value, or the resolver got a
      // non-fallback answer (i.e. backend API or known model table hit).
      const confident = userOverride != null || resolved !== 131_072

      this.cachedContextWindow = resolved
      this.cachedContextWindowConfident = confident
      return { contextWindow: resolved, confident }
    } catch {
      return { contextWindow: 131_072, confident: false }
    }
  }

  // ── resolveWorkspaceMcpFlags ──────────────────────────────────────────

  resolveWorkspaceMcpFlags(): McpFeatureFlags {
    const defaults: McpFeatureFlags = {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      localMcpActive: {}
    }
    try {
      if (!this.s.workspaceId) return defaults
      const ws = workspaceRepository.findById(this.s.workspaceId)
      if (!ws) return defaults
      const settings = workspaceRepository.getSettings(ws.id)
      return {
        repomapEnabled: settings.repomapEnabled !== false,
        semanticSearchEnabled: settings.semanticSearchEnabled !== false,
        githubConfigured: !!settings.githubToken,
        externalMcpActive: this.resolveExternalMcpFlags(),
        localMcpActive: {}
      }
    } catch {
      return defaults
    }
  }

  // ── resolveExternalMcpFlags ───────────────────────────────────────────

  resolveExternalMcpFlags(): Record<string, boolean> {
    const flags: Record<string, boolean> = {}
    try {
      if (this.s.currentConversationId) {
        const conv = conversationRepository.findById(this.s.currentConversationId)
        if (conv?.mcpOverrides) {
          const overrides = conv.mcpOverrides
          if (this.s.workspaceId) {
            const wsSettings = workspaceRepository.getSettings(this.s.workspaceId)
            for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
              const wsAvailable = !!wsSettings[`${integration.id}Available`]
              const chatActive = !!overrides[integration.id]
              flags[integration.id] = wsAvailable && chatActive
            }
          }
        }
      }
    } catch {
      /* non-fatal */
    }
    return flags
  }

  // ── resolveHookPaths ──────────────────────────────────────────────────

  resolveHookPaths(): { pre?: string; post?: string } {
    const hooksDir = app.isPackaged
      ? join(process.resourcesPath, 'hooks')
      : join(__dirname, '..', '..', 'src', 'main', 'hooks')

    const pre = join(hooksDir, 'pre-tool-use-hook.sh')
    const post = join(hooksDir, 'post-tool-use-hook.sh')

    const result: { pre?: string; post?: string } = {}
    if (existsSync(pre)) result.pre = pre
    if (existsSync(post)) result.post = post

    if (result.pre || result.post) {
      this.s.log.info(
        `[resolveHookPaths] pre=${result.pre ?? 'none'} post=${result.post ?? 'none'}`
      )
    }
    return result
  }

  // ── resolveBudgetCap ──────────────────────────────────────────────────

  resolveBudgetCap(isLocal: boolean, isBuildMode: boolean): number | undefined {
    if (isLocal) return undefined
    if (!this.s.workspacePath) return undefined
    try {
      const workspace = workspaceRepository
        .findAll()
        .find((w) => w.repoPath === this.s.workspacePath)
      if (!workspace) return undefined
      const settings = workspaceRepository.getSettings(workspace.id)
      const baseCap = settings.budgetCapUsd
      if (!baseCap || baseCap <= 0) return undefined

      const multiplier = isBuildMode
        ? BUDGET_CAP_MODE_MULTIPLIERS.build
        : BUDGET_CAP_MODE_MULTIPLIERS.plan
      return baseCap * multiplier
    } catch {
      return undefined
    }
  }

  /**
   * Resolve thinking effort: user's per-conversation choice overrides the model default.
   * Model-aware defaults: Haiku → 'medium' (saves thinking tokens without quality loss),
   * Opus/Sonnet → 'high' (Opus 4.8 at high ≥ 4.7 at xhigh).
   */
  private resolveEffort(resolvedModel: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    // Check per-conversation override first
    if (this.s.currentConversationId) {
      try {
        const conv = conversationRepository.findById(this.s.currentConversationId)
        if (conv?.effort) {
          return conv.effort
        }
      } catch {
        /* non-fatal — use model default */
      }
    }
    // Model-aware defaults: Haiku uses fewer thinking tokens at 'medium'
    // without quality loss. Opus and Sonnet benefit from 'high'.
    if (resolvedModel.includes('haiku')) return 'medium'
    return 'high'
  }

  /**
   * Resolve per-conversation thinking budget cap.
   * Returns undefined if no cap is set (unlimited thinking).
   */
  private resolveThinkingBudget(): number | undefined {
    if (this.s.currentConversationId) {
      try {
        const conv = conversationRepository.findById(this.s.currentConversationId)
        if (conv?.thinkingBudget && conv.thinkingBudget > 0) {
          return conv.thinkingBudget
        }
      } catch {
        /* non-fatal */
      }
    }
    return undefined
  }

  // ── buildCLIExecuteOptions ────────────────────────────────────────────

  buildCLIExecuteOptions(params: {
    prompt: string | Array<Record<string, unknown>>
    systemPrompt: string
    sessionId: string | undefined
    isBuildMode: boolean
    mode?: ConversationMode
    resumeAt: string | undefined
    abortController: AbortController
    mcpResult: AdapterMcpResult
    // F14: localContextWindow removed — was accepted as a parameter but never
    // referenced. Context window is resolved internally from the model config.
    /** Completion goal — Claude works autonomously until this condition is met */
    goal?: string
    /** Goal delivery mode: 'advisory' (system prompt only) or 'enforce' (/goal stdin) */
    goalMode?: 'advisory' | 'enforce'
  }, resolvedExecutor?: { isAlive(): boolean }): CLIExecuteOptions {
    const { prompt, systemPrompt, sessionId, isBuildMode, resumeAt, abortController, mcpResult } =
      params
    const { allowedTools, disallowedTools } = mcpResult

    const modelAction = resolveModelAction(this.s.adapter.role, isBuildMode)
    const resolvedModel = resolveModelFromSnapshot(
      this.s.currentConversationId,
      this.s.workspacePath!,
      modelAction,
      isBuildMode
    )

    const supports1M = supportsContext1M(resolvedModel)
    const effectiveContextWindow = supports1M
      ? CLAUDE_1M_CONTEXT_WINDOW
      : CLAUDE_DEFAULT_CONTEXT_WINDOW
    this.s.effectiveContextWindow = effectiveContextWindow

    const sdkContextWindowSize = resolveSdkContextWindowSize(supports1M, effectiveContextWindow)
    // The `claude` CLI controls its auto-compact window via env vars, not argv
    // flags. Without this, 1M models use the (smaller) model-default window —
    // inflating the context badge and triggering premature auto-compact.
    const compactionEnv = resolveClaudeCompactionEnv(supports1M, effectiveContextWindow)

    // WRONG-EXECUTOR-03: Use the resolved per-conversation executor when provided,
    // not the cliExecutor getter which goes through _lastActiveConversationId.
    const canContinue = (resolvedExecutor ?? this.s.cliExecutor).isAlive() && !!sessionId

    // C2: Log tool availability on EVERY turn (not just first spawn)
    this.s.log.info(
      `[CLI:tools] turn=every allowedTools=${allowedTools?.length ?? 'all'} ` +
        `disallowed=[${disallowedTools?.join(',') ?? ''}] ` +
        `hasEmitPlan=${allowedTools === undefined || allowedTools.includes('mcp__control-actions__emit_plan')} ` +
        `hasCodeGraph=${allowedTools === undefined || allowedTools.some((t: string) => t.includes('code-graph'))} ` +
        `canContinue=${canContinue}`
    )

    // ── Fast path: continueSession — skip expensive work ────────────────
    // When the CLI process is alive and we're continuing the same session,
    // only prompt, model, cwd, abortController, and continueSession are used
    // by CLIExecutor.execute() (it writes the user message to stdin and reads
    // stdout — no args are rebuilt, no files are spawned). Skip MCP config
    // rebuild, system prompt file write, additional directories lookup, etc.
    if (canContinue) {
      return {
        prompt,
        systemPrompt,
        permissionMode: this.resolveCliPermissionMode(params.mode ?? this.s.currentMode),
        model: resolvedModel,
        cwd: this.s.workspacePath!,
        abortController,
        agentId: this.s.adapter.agentId,
        effort: this.resolveEffort(resolvedModel),
        continueSession: true,
        // Reuse cached MCP config — process already has MCP servers connected
        mcpConfigPath: this.cachedMcpConfigPath,
        contextWindowSize: sdkContextWindowSize,
        autoCompactEnabled: true,
        // No-op on a live process (env only applies at spawn) — included for a
        // consistent option shape with the new-spawn path.
        envOverrides: compactionEnv,
        // F1: thinkingBudget must persist across continueSession turns to
        // enforce user cost control on every turn, not just the first.
        thinkingBudget: this.resolveThinkingBudget(),
        // Permission prompt tool — only present when control-actions server is mounted.
        // When the adapter's allowedTools exclude all control-actions tools, the server
        // is skipped and referencing the tool would crash every tool call.
        permissionPromptTool: this.cachedControlActionsMounted
          ? MCP_TOOLS.CONTROL_ACTIONS.PERMISSION_PROMPT.name
          : undefined,
        // F2: goal must persist so MPA autonomous completion conditions
        // are evaluated on every turn, not just the initial spawn.
        goal: params.goal,
        goalMode: params.goalMode
      }
    }

    // ── Full path: new process spawn — build all options ─────────────────
    let additionalDirectories: string[] | undefined
    try {
      if (this.s.workspaceId) {
        const settings = workspaceRepository.getSettings(this.s.workspaceId)
        additionalDirectories = settings.additionalDirectories
      }
    } catch {
      /* non-fatal */
    }

    // Derive skip-servers BEFORE building the MCP config — we need to know
    // whether control-actions is mounted to gate the permissionPromptTool flag.
    const skipServers = deriveSkipServers(params.mcpResult.allowedTools)
    const controlActionsMounted = !skipServers?.includes('control-actions')
    this.cachedControlActionsMounted = controlActionsMounted

    // Build and cache MCP config for reuse on subsequent continueSession turns
    const mcpConfigPath = this.buildCLIMcpConfigPath(params, skipServers)
    this.cachedMcpConfigPath = mcpConfigPath

    // Instrumentation: one-line snapshot of the resolved compaction config on spawn.
    this.s.log.info(
      `[compaction:config] model=${resolvedModel} supports1M=${supports1M} ` +
        `contextWindowSize=${sdkContextWindowSize} autoCompactEnabled=true ` +
        `autoCompactWindow=${compactionEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW} ` +
        `pctOverride=${compactionEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? 'none'}`
    )

    return {
      prompt,
      systemPrompt,
      model: resolvedModel,
      cwd: this.s.workspacePath!,
      permissionMode: this.resolveCliPermissionMode(params.mode ?? this.s.currentMode),
      allowedTools,
      disallowedTools,
      maxTurns: isBuildMode ? 200 : 50,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      abortController,
      agentId: this.s.adapter.agentId,
      effort: this.resolveEffort(resolvedModel),
      // Fable 5 has native 1M context — no beta header needed. Sonnet/Opus use the beta.
      betas: supports1M && !resolvedModel.includes('fable')
        ? [AgentExecutorFactory.CONTEXT_1M_BETA]
        : undefined,
      // F19: Tier-aware fallback — only fall back to a model of equal or higher capability.
      // Fable → Opus fallback (refusal/availability per Anthropic docs).
      // Opus → Sonnet fallback (appropriate cost reduction).
      // Sonnet/Haiku → no fallback.
      fallbackModel: resolvedModel.includes('fable')
        ? 'claude-opus-4-8'
        : resolvedModel.includes('opus') ? 'claude-sonnet-5' : undefined,
      additionalDirectories,
      contextWindowSize: sdkContextWindowSize,
      autoCompactEnabled: true,
      // Wire compaction window + MCP timeout into the CLI's process env.
      // Blueprint sessions get an extended MCP server startup timeout (30s vs
      // the default ~10s) because they spawn 4-5 MCP servers simultaneously and
      // the packaged-app cold start is slower than dev.
      envOverrides: {
        ...compactionEnv,
        ...(this.s.adapter.role.startsWith('blueprint-')
          ? { MCP_TIMEOUT: '30000' }
          : {})
      },
      continueSession: false,
      mcpConfigPath,
      // Permission prompt tool — only set when control-actions server is mounted.
      // Blueprint sessions with restricted allowedTools skip control-actions; passing
      // the tool reference when the server isn't present crashes every tool call with
      // "MCP tool mcp__control-actions__permission_prompt not found".
      permissionPromptTool: controlActionsMounted
        ? MCP_TOOLS.CONTROL_ACTIONS.PERMISSION_PROMPT.name
        : undefined,
      goal: params.goal,
      goalMode: params.goalMode,
      thinkingBudget: this.resolveThinkingBudget()
    }
  }

  // ── buildCLIMcpConfigPath ─────────────────────────────────────────────

  buildCLIMcpConfigPath(
    _params: {
      isBuildMode: boolean
      mcpResult: AdapterMcpResult
    },
    precomputedSkipServers?: string[]
  ): string | undefined {
    try {
      const featureFlags = this.resolveWorkspaceMcpFlags()

      const controlCallbacks = this.s.adapter.buildControlCallbacks({
        conversationId: this.s.currentConversationId ?? '',
        emit: (evt: string, payload: unknown) => this.s.emitAdapterEvent(evt, payload),
        getAccumulatedText: () => this.s.accumulatedText
      })

      let socketPath: string | undefined
      if (this.s.ipcBridge) {
        socketPath = this.s.ipcBridge.getSocketPath() ?? undefined
      }

      // Use pre-computed skip servers when available (caller already derived them
      // to gate the permissionPromptTool flag). Fall back to computing here for
      // callers that don't pre-compute.
      const skipServers = precomputedSkipServers ?? deriveSkipServers(_params.mcpResult.allowedTools)

      const configPath = this.s.mcpConfigWriter.writeConfig({
        workspacePath: this.s.workspacePath!,
        workspaceId: this.s.workspaceId,
        conversationId: this.s.currentConversationId,
        mode: this.s.currentMode,
        featureFlags,
        controlCallbacks,
        ipcSocketPath: socketPath,
        skipServers,
        instanceId: this.s.instanceId
      })

      this.s.log.info(`[buildCLIMcpConfigPath] MCP config written: ${configPath}`)
      return configPath
    } catch (error) {
      this.s.log.error('[buildCLIMcpConfigPath] CRITICAL: MCP config write failed:', error)
      throw error // Don't swallow — agent needs control tools
    }
  }

  // ── Permission mode resolution ──────────────────────────────────────

  /**
   * Map app-level ConversationMode to CLI --permission-mode values.
   *   plan   → 'plan'              (read-only + read-only shell)
   *   build  → 'acceptEdits'       (auto-approves working-dir file edits + common fs Bash)
   *   danger → 'bypassPermissions' (unrestricted)
   *
   * `acceptEdits` is preferred over `auto` for build mode because `auto`
   * requires account/model/provider support and silently falls back to
   * `default` (interactive prompts → blocked in our stream-json session)
   * when unavailable. `acceptEdits` is deterministic and needs no gating.
   */
  private resolveCliPermissionMode(mode: ConversationMode): 'plan' | 'acceptEdits' | 'bypassPermissions' {
    switch (mode) {
      case 'danger':
        return 'bypassPermissions'
      case 'build':
        return 'acceptEdits'
      default:
        return 'plan'
    }
  }

}

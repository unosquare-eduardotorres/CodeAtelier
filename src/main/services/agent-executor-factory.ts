/**
 * AgentExecutorFactory — builds executor options for CLI and OpenCode
 * backends. Resolves MCP feature flags, hook paths, budget caps, and local
 * LLM context windows.
 *
 * Extracted from AgentSessionService to reduce god-class complexity.
 * Holds a back-reference to the session for state access.
 *
 * @internal Not for use outside the agent-session module.
 */

import type { AgentSessionHost, CLIExecuteOptions } from './agent-session-host'
import type { AdapterMcpResult } from './agent-session.types'
import type { McpFeatureFlags } from './workspace-mcp-config'

import type { ConversationMode, ModelAction } from '../../shared/types'
import {
  BUDGET_CAP_MODE_MULTIPLIERS,
  CLAUDE_1M_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  EXTERNAL_MCP_INTEGRATIONS,
  RECOMMENDED_LOCAL_MODELS,
  supportsContext1M
} from '../../shared/constants'

import { modelConfigService } from './model-config.service'
import { resolveClaudeCompactionEnv, resolveSdkContextWindowSize } from './compaction-policy'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { join } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'

export class AgentExecutorFactory {
  private readonly s: AgentSessionHost
  /** Cached MCP config path — reused on continueSession turns to avoid rebuild. */
  private cachedMcpConfigPath: string | undefined
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

  resolveLocalContextWindow(): number {
    if (!this.s.workspacePath) return 32_768
    try {
      const localConfig = modelConfigService.getLocalLLMConfig(this.s.workspacePath)
      const model = localConfig.localModel
      const recommended = RECOMMENDED_LOCAL_MODELS.find(
        (m) => m.ollamaId === model || m.omlxId === model
      )
      return recommended?.contextWindow ?? 32_768
    } catch {
      return 32_768
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
    /** LLM preset ID for per-action model resolution */
    presetId?: string | null
  }): CLIExecuteOptions {
    const { prompt, systemPrompt, sessionId, isBuildMode, resumeAt, abortController, mcpResult } =
      params
    const { allowedTools, disallowedTools } = mcpResult

    const modelAction = `${this.s.adapter.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction
    const resolvedModel = modelConfigService.getModel(
      this.s.workspacePath!,
      modelAction,
      params.presetId
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

    const canContinue = this.s.cliExecutor.isAlive() && !!sessionId

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
        // F2: goal must persist so MPA autonomous completion conditions
        // are evaluated on every turn, not just the initial spawn.
        goal: params.goal
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

    // Build and cache MCP config for reuse on subsequent continueSession turns
    const mcpConfigPath = this.buildCLIMcpConfigPath(params)
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
      maxTurns: isBuildMode ? 50 : 30,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      abortController,
      agentId: this.s.adapter.agentId,
      effort: this.resolveEffort(resolvedModel),
      betas: supports1M ? [AgentExecutorFactory.CONTEXT_1M_BETA] : undefined,
      // F19: Tier-aware fallback — only fall back to a model of equal or higher capability.
      // Haiku → no fallback (it's the cheapest; falling back to Sonnet increases cost).
      // Opus → Sonnet fallback (appropriate cost reduction).
      // Sonnet → no fallback (it IS the fallback target).
      fallbackModel: resolvedModel.includes('opus') ? 'claude-sonnet-4-6' : undefined,
      additionalDirectories,
      contextWindowSize: sdkContextWindowSize,
      autoCompactEnabled: true,
      // Wire compaction window into the CLI's process env (see resolveClaudeCompactionEnv).
      envOverrides: compactionEnv,
      continueSession: false,
      mcpConfigPath,
      goal: params.goal,
      thinkingBudget: this.resolveThinkingBudget()
    }
  }

  // ── buildCLIMcpConfigPath ─────────────────────────────────────────────

  buildCLIMcpConfigPath(_params: {
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
  }): string | undefined {
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

      const configPath = this.s.mcpConfigWriter.writeConfig({
        workspacePath: this.s.workspacePath!,
        workspaceId: this.s.workspaceId,
        conversationId: this.s.currentConversationId,
        mode: this.s.currentMode,
        featureFlags,
        controlCallbacks,
        ipcSocketPath: socketPath
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
   *   build  → 'auto'              (AI safety classifier)
   *   danger → 'bypassPermissions' (unrestricted)
   */
  private resolveCliPermissionMode(mode: ConversationMode): 'plan' | 'auto' | 'bypassPermissions' {
    switch (mode) {
      case 'danger':
        return 'bypassPermissions'
      case 'build':
        return 'auto'
      default:
        return 'plan'
    }
  }
}

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
import type { AdapterMcpResult } from './role-adapters/types'
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
import {
  conversationRepository,
  workspaceRepository
} from '../db/repositories'
import { join } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'

export class AgentExecutorFactory {
  private readonly s: AgentSessionHost

  constructor(session: unknown) {
    this.s = session as AgentSessionHost
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
        localMcpActive: settings.localMcpActive ?? {}
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
   * Opus 4.8 defaults to 'high' (outperforms 4.7's 'xhigh'). All models now default to 'high'.
   */
  private resolveEffort(resolvedModel: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    const modelDefault: 'high' = 'high' // Unified default — Opus 4.8 at high ≥ 4.7 at xhigh
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
    return modelDefault
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
    localContextWindow?: number
    /** Completion goal — Claude works autonomously until this condition is met */
    goal?: string
  }): CLIExecuteOptions {
    const { prompt, systemPrompt, sessionId, isBuildMode, resumeAt, abortController, mcpResult } =
      params
    const { allowedTools, disallowedTools } = mcpResult

    const modelAction = `${this.s.adapter.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction
    const resolvedModel = modelConfigService.getModel(this.s.workspacePath!, modelAction)

    let additionalDirectories: string[] | undefined
    try {
      if (this.s.workspaceId) {
        const settings = workspaceRepository.getSettings(this.s.workspaceId)
        additionalDirectories = settings.additionalDirectories
      }
    } catch {
      /* non-fatal */
    }

    const supports1M = supportsContext1M(resolvedModel)
    const effectiveContextWindow = supports1M
      ? CLAUDE_1M_CONTEXT_WINDOW
      : CLAUDE_DEFAULT_CONTEXT_WINDOW
    this.s.effectiveContextWindow = effectiveContextWindow

    const canContinue = this.s.cliExecutor.isAlive() && !!sessionId
    const hookPaths = this.resolveHookPaths()

    return {
      prompt,
      systemPrompt,
      model: resolvedModel,
      cwd: this.s.workspacePath!,
      permissionMode: this.resolveCliPermissionMode(params.mode ?? this.s.currentMode),
      allowedTools,
      disallowedTools,
      maxTurns: isBuildMode ? 50 : 30,
      resume: canContinue ? undefined : sessionId,
      resumeSessionAt: resumeAt,
      abortController,
      agentId: this.s.adapter.agentId,
      effort: this.resolveEffort(resolvedModel),
      betas: supports1M ? ['context-1m-2025-08-07'] : undefined,
      fallbackModel: resolvedModel !== 'claude-sonnet-4-6' ? 'claude-sonnet-4-6' : undefined,
      additionalDirectories,
      contextWindowSize: supports1M
        ? effectiveContextWindow
        : Math.round(effectiveContextWindow * 0.8),
      autoCompactEnabled: true,
      continueSession: canContinue,
      mcpConfigPath: this.buildCLIMcpConfigPath(params),
      goal: params.goal
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
        emit: (evt, payload) => this.s.emitAdapterEvent(evt, payload),
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
      this.s.log.warn('[buildCLIMcpConfigPath] Failed to write MCP config:', error)
      return undefined
    }
  }

  // ── Permission mode resolution ──────────────────────────────────────

  /**
   * Map app-level ConversationMode to CLI --permission-mode values.
   *   plan   → 'plan'              (read-only + read-only shell)
   *   build  → 'auto'              (AI safety classifier)
   *   danger → 'bypassPermissions' (unrestricted)
   */
  private resolveCliPermissionMode(
    mode: ConversationMode
  ): 'plan' | 'auto' | 'bypassPermissions' {
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

/**
 * AuditRoleAdapter — drives AgentSessionService for a single workspace health
 * auditor track (e.g. "database", "code", "testing").
 *
 * Key differences vs. chat adapters:
 *   - Single-shot: one message ("Begin your audit.") → one response → done.
 *   - Read-only: write tools are explicitly disallowed.
 *   - No personas, no intent detection, no control-tool callbacks.
 *   - Always runs in 'plan' mode (no build mode).
 *   - Shorter interaction timeout (5 min per auditor).
 *   - MCP servers mounted: code-graph + semantic-search + git-context (NO control-actions).
 */

import type { AuditMode, AuditTrackId, CostPreference } from '../../../shared/types'
import type { RoundContext } from '../audit-prompt-templates'
import type {
  AdapterIntentContext,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AgentRoleAdapter,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'
import { workspaceRepository } from '../../db/repositories'
import { renderAuditPrompt } from '../audit-prompt-templates'
import { detectTechStack } from '../tech-stack-detector.service'
import { chatAgentLogger } from '../../logger'
import { appendMcpToolGuidance, type PromptFeatureFlags } from '../prompt-assembly-helpers'
import { modelConfigService } from '../model-config.service'
import { buildReadOnlyToolConfig } from './evaluation-mcp-config'

export class AuditRoleAdapter implements AgentRoleAdapter {
  readonly role = 'audit' as const
  readonly agentId: string
  interactionTimeoutMs = 5 * 60_000 // 5 min per auditor (adjusted for local LLMs in onSessionStart)

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private readonly trackId: AuditTrackId
  private readonly mode: AuditMode
  private readonly skillContent?: string
  private readonly roundContext?: RoundContext

  private readonly llmProvider: import('../../../shared/types').LLMProvider

  private systemPrompt: string | null = null

  // Feature flags read on session start
  private repomapEnabled = true
  private semanticSearchEnabled = true

  constructor(params: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
    skillContent?: string
    roundContext?: RoundContext
    llmProvider?: import('../../../shared/types').LLMProvider
  }) {
    this.workspaceId = params.workspaceId
    this.trackId = params.trackId
    this.mode = params.mode
    this.skillContent = params.skillContent
    this.roundContext = params.roundContext
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `audit-${params.trackId}-${params.workspaceId}`
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Read workspace settings for MCP flags
    try {
      const settings = workspaceRepository.getSettings(this.workspaceId)
      this.repomapEnabled = settings.repomapEnabled !== false
      this.semanticSearchEnabled = settings.semanticSearchEnabled !== false
    } catch {
      /* non-fatal */
    }

    // Increase timeout for local LLMs — they're much slower but still productive.
    // 45 min gives enough headroom to manually observe progress via live stream.
    if (this.llmProvider === 'local-llm') {
      this.interactionTimeoutMs = 45 * 60_000 // 45 min for local LLMs
      this.log.info(`[audit-adapter] Using extended timeout (45 min) for local LLM`)
    }

    // Detect tech stack and build prompt
    const detectedTechs = ctx.workspacePath ? detectTechStack(ctx.workspacePath).detectedTechs : []

    const workspaceName = (() => {
      try {
        const ws = workspaceRepository.findById(this.workspaceId)
        return ws?.name ?? 'Unknown'
      } catch {
        return 'Unknown'
      }
    })()

    // Resolve model for lean prompt optimization (Opus 4.8+ gets compressed guidance)
    const isLocal = modelConfigService.isLocalProvider(ctx.workspacePath)
    const resolvedModel = isLocal ? undefined : modelConfigService.getModel(ctx.workspacePath, 'audit')

    this.systemPrompt = renderAuditPrompt({
      trackId: this.trackId,
      workspaceName,
      detectedTechs,
      skillContent: this.skillContent,
      roundContext: this.roundContext,
      model: resolvedModel
    })

    // Append MCP tool guidance (same as DaVinci/Grill) so the agent knows how to use custom tools
    const featureFlags: PromptFeatureFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: false, // auditors don't mount GitHub tools
      includeGitContext: this.llmProvider !== 'local-llm',
      includeCheckpoint: false // auditors don't mount checkpoint tools
    }

    this.systemPrompt = appendMcpToolGuidance(this.systemPrompt, 1, featureFlags, resolvedModel)

    this.log.info(
      `[audit-adapter] ${this.trackId} audit started for workspace=${this.workspaceId} mode=${this.mode}`
    )
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // No-op — single-shot, no need to refresh mid-audit
  }

  onConversationSwitch(_conversationId: string): void {
    // No-op — auditors don't switch conversations
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `AuditRoleAdapter.buildPrompts() called before onSessionStart() for track=${this.trackId}`
      )
    }
    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: 'Begin your audit.'
    }
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    // Use the shared read-only tool config — same pattern as grill/council adapters.
    // Local LLMs skip git-context to save tokens (Bash + git CLI equivalent).
    return buildReadOnlyToolConfig({
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      hasWorkspace: !!ctx.workspaceId,
      includeGitContext: this.llmProvider !== 'local-llm'
    })
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // No-op — auditors don't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(_ctx: AdapterIntentContext): void {
    // No-op — auditors don't emit intents
  }

  getCompactionThresholds(
    _costPreference: CostPreference
  ): { suggest: number; auto: number } | null {
    return null
  }

  getPersonaId(): string | null {
    return null
  }

  onSessionStop(): void {
    this.systemPrompt = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
  }
}

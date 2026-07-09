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

import type { AuditMode, AuditTrackId } from '../../../shared/types'
import type { RoundContext } from '../audit-prompt-templates'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { workspaceRepository } from '../../db/repositories'
import { renderAuditPrompt } from '../audit-prompt-templates'
import { detectTechStack } from '../tech-stack-detector.service'
import { BaseRoleAdapter, type McpStrategy } from './base.adapter'
import type { AdapterIntentContext } from '../agent-session.types'

export class AuditRoleAdapter extends BaseRoleAdapter {
  readonly role = 'audit' as const
  readonly agentId: string
  interactionTimeoutMs = 5 * 60_000 // 5 min per auditor (adjusted for local LLMs in onSessionStart)

  private readonly workspaceId: string
  private readonly trackId: AuditTrackId
  private readonly mode: AuditMode
  private readonly skillContent?: string
  private readonly roundContext?: RoundContext

  private readonly llmProvider: import('../../../shared/types').LLMProvider

  private systemPrompt: string | null = null

  constructor(params: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
    skillContent?: string
    roundContext?: RoundContext
    llmProvider?: import('../../../shared/types').LLMProvider
  }) {
    super()
    this.workspaceId = params.workspaceId
    this.trackId = params.trackId
    this.mode = params.mode
    this.skillContent = params.skillContent
    this.roundContext = params.roundContext
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `audit-${params.trackId}-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(this.workspaceId)

    // Pattern 3: Centralized local LLM timeout
    this.applyLocalLlmTimeout(this.llmProvider)

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

    // Pattern 1: Centralized model resolution
    const resolvedModel = this.resolveModel(ctx.workspacePath, 'audit')

    this.systemPrompt = renderAuditPrompt({
      trackId: this.trackId,
      workspaceName,
      detectedTechs,
      skillContent: this.skillContent,
      roundContext: this.roundContext,
      model: resolvedModel
    })

    // Append MCP tool guidance via base class helper
    this.systemPrompt = this.appendToolGuidance(this.systemPrompt, 1, resolvedModel)

    this.log.info(
      `[audit-adapter] ${this.trackId} audit started for workspace=${this.workspaceId} mode=${this.mode}`
    )
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

  protected override getMcpStrategy(): McpStrategy {
    return 'readonly'
  }
  protected override getIncludeGitContext(): boolean {
    return this.llmProvider !== 'local-llm'
  }

  /** No-op — auditors don't emit intents. */
  override emitDetectedIntents(_ctx: AdapterIntentContext): void {
    /* no-op */
  }

  override onSessionStop(): void {
    this.systemPrompt = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
  }
}

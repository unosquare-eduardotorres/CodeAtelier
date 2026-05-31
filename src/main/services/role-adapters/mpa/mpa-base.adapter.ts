import type {
  AgentRoleAdapter,
  AdapterSessionLifecycleCtx,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterIntentContext
} from '../../agent-session.types'
import type { AgentRole, CostPreference } from '../../../../shared/types'
import type { ControlActionCallbacks } from '../../control-actions.tool'
import { workspaceRepository } from '../../../db/repositories'
import { detectTechStack } from '../../tech-stack-detector.service'
import { MCP_TOOLS } from '../../../../shared/constants'
import { modelConfigService } from '../../model-config.service'

/**
 * Base adapter for MPA (Multi-Phased Agent) pipeline phases.
 *
 * Provides common plumbing for all three MPA roles:
 * - Read-only MCP tool config (plan/verify) vs full access (builder)
 * - Single-shot lifecycle (no conversation switching, no persona)
 * - Goal condition support for /goal-based completion
 */
export abstract class MpaBaseAdapter implements AgentRoleAdapter {
  abstract readonly role: AgentRole
  abstract readonly agentId: string
  interactionTimeoutMs = 30 * 60_000 // 30 min hard cap per phase

  protected workspaceId: string
  protected systemPrompt: string | null = null
  protected goalCondition: string | null = null
  protected workspaceName = ''
  protected detectedTechs: string[] = []
  protected repomapEnabled = true
  protected semanticSearchEnabled = true
  /** Resolved model ID for lean prompt gating (undefined for local LLMs) */
  protected resolvedModel: string | undefined

  constructor(params: { workspaceId: string }) {
    this.workspaceId = params.workspaceId
  }

  /** Set the /goal completion condition before starting the phase. */
  setGoalCondition(condition: string): void {
    this.goalCondition = condition
  }

  /** Read the /goal completion condition — used by executor factory. */
  getGoalCondition(): string | null {
    return this.goalCondition
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Resolve workspace name + settings
    try {
      const ws = workspaceRepository.findById(this.workspaceId)
      this.workspaceName = ws?.name ?? 'Unknown'
    } catch {
      this.workspaceName = 'Unknown'
    }

    try {
      const settings = workspaceRepository.getSettings(this.workspaceId)
      this.repomapEnabled = settings.repomapEnabled !== false
      this.semanticSearchEnabled = settings.semanticSearchEnabled !== false
    } catch {
      /* non-fatal */
    }

    // Detect tech stack
    this.detectedTechs = ctx.workspacePath
      ? detectTechStack(ctx.workspacePath).detectedTechs
      : []

    // Resolve model for lean prompt optimization (Opus 4.8+ gets compressed prompts).
    // MPA doesn't have its own ModelAction — planner/verifier reuse 'da-vinci:plan',
    // builder reuses 'da-vinci:build'.
    const isLocal = modelConfigService.isLocalProvider(ctx.workspacePath)
    this.resolvedModel = isLocal ? undefined : modelConfigService.getModel(ctx.workspacePath, this.getModelAction())

    // Build the phase-specific system prompt
    this.systemPrompt = this.buildPhaseSystemPrompt()
  }

  /** Return the ModelAction to use for model resolution (overridden by builder). */
  protected getModelAction(): import('../../../../shared/types').ModelAction {
    return 'da-vinci:plan' // Planner/verifier share plan-tier model
  }

  /** Subclasses implement to build phase-specific prompts. */
  protected abstract buildPhaseSystemPrompt(): string

  /** Subclasses provide the initial message for the phase. */
  protected abstract getPhaseMessage(): string

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // Single-shot — no mid-phase refresh needed
  }

  onConversationSwitch(_conversationId: string): void {
    // MPA phases don't switch conversations
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(`${this.role} adapter: buildPrompts() called before onSessionStart()`)
    }
    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: this.getPhaseMessage()
    }
  }

  /** Read-only MCP config for plan/verify phases. Builder overrides this. */
  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        // Code graph tools
        ...(this.repomapEnabled && ctx.workspaceId
          ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES
          : []),
        // Semantic search
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        // Git context
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        // Code analysis
        ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES
      ],
      disallowedTools: [
        'Write',
        'Edit',
        'Bash',
        'ListDir',
        'Agent',
        'ToolSearch',
        'ExitPlanMode',
        'AskUserQuestion',
        'TodoWrite',
        'TaskCreate',
        'TaskUpdate'
      ]
    }
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: string, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // MPA phases don't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(_ctx: AdapterIntentContext): void {
    // MPA phases don't emit conversational intents
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
    this.goalCondition = null
  }
}

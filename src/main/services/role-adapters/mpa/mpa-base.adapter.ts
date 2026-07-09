import type {
  AdapterSessionLifecycleCtx,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterIntentContext
} from '../../agent-session.types'
import type { AgentRole } from '../../../../shared/types'
import { workspaceRepository } from '../../../db/repositories'
import { detectTechStack } from '../../tech-stack-detector.service'
import { MCP_TOOLS } from '../../../../shared/constants'
import { BaseRoleAdapter } from '../base.adapter'

/**
 * Base adapter for MPA (Multi-Phased Agent) pipeline phases.
 *
 * Provides common plumbing for all three MPA roles:
 * - Read-only MCP tool config (plan/verify) vs full access (builder)
 * - Single-shot lifecycle (no conversation switching, no persona)
 * - Goal condition support for /goal-based completion
 */
export abstract class MpaBaseAdapter extends BaseRoleAdapter {
  abstract readonly role: AgentRole
  abstract readonly agentId: string
  interactionTimeoutMs = 30 * 60_000 // 30 min hard cap per phase

  protected workspaceId: string
  protected systemPrompt: string | null = null
  protected goalCondition: string | null = null
  protected goalMode: 'advisory' | 'enforce' = 'advisory'
  protected workspaceName = ''
  protected detectedTechs: string[] = []
  /** Resolved model ID for lean prompt gating (undefined for local LLMs) */
  protected resolvedModel: string | undefined

  constructor(params: { workspaceId: string }) {
    super()
    this.workspaceId = params.workspaceId
  }

  /** Set the /goal completion condition before starting the phase. */
  setGoalCondition(condition: string, mode: 'advisory' | 'enforce' = 'advisory'): void {
    this.goalCondition = condition
    this.goalMode = mode
  }

  /** Read the /goal completion condition — used by executor factory. */
  getGoalCondition(): string | null {
    return this.goalCondition
  }

  /** Read the goal delivery mode — 'advisory' (system prompt only) or 'enforce' (/goal stdin). */
  getGoalMode(): 'advisory' | 'enforce' {
    return this.goalMode
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Resolve workspace name
    try {
      const ws = workspaceRepository.findById(this.workspaceId)
      this.workspaceName = ws?.name ?? 'Unknown'
    } catch {
      this.workspaceName = 'Unknown'
    }

    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(this.workspaceId)

    // Detect tech stack
    this.detectedTechs = ctx.workspacePath ? detectTechStack(ctx.workspacePath).detectedTechs : []

    // Pattern 1: Centralized model resolution
    this.resolvedModel = this.resolveModel(ctx.workspacePath, this.getModelAction())

    // Build the phase-specific system prompt
    this.systemPrompt = this.buildPhaseSystemPrompt()

    // Append tool guidance (Tool Priority + MCP guidance) — centralized in base class
    this.systemPrompt = this.appendToolGuidance(this.systemPrompt, 1, this.resolvedModel)
  }

  /** Return the ModelAction to use for model resolution (overridden by builder). */
  protected getModelAction(): import('../../../../shared/types').ModelAction {
    return 'da-vinci:plan' // Planner/verifier share plan-tier model
  }

  /** Subclasses implement to build phase-specific prompts. */
  protected abstract buildPhaseSystemPrompt(): string

  /** Subclasses provide the initial message for the phase. */
  protected abstract getPhaseMessage(): string

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
  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
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

  /** MPA phases don't emit conversational intents. */
  override emitDetectedIntents(_ctx: AdapterIntentContext): void {
    /* no-op */
  }


  override onSessionStop(): void {
    this.systemPrompt = null
    this.goalCondition = null
    this.goalMode = 'advisory'
  }
}

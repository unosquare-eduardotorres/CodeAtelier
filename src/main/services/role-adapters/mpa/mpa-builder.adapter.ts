import { MpaBaseAdapter } from './mpa-base.adapter'
import { buildBuilderSystemPrompt } from '../../mpa-prompts'
import type { AgentRole } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { MpaPlanArtifact, MpaVerifyReport } from '../../../../shared/mpa-types'
import { MCP_TOOLS } from '../../../../shared/constants'

/**
 * MPA Builder Adapter — implements the approved plan with full write access.
 *
 * CLI config: --permission-mode auto, --effort xhigh, --goal "condition", --max-turns 50
 */
export class MpaBuilderAdapter extends MpaBaseAdapter {
  readonly role: AgentRole = 'mpa-builder'
  readonly agentId: string

  private readonly goal: string
  private readonly plan: MpaPlanArtifact
  private readonly verifierFeedback?: MpaVerifyReport

  constructor(params: {
    workspaceId: string
    goal: string
    plan: MpaPlanArtifact
    verifierFeedback?: MpaVerifyReport
  }) {
    super({ workspaceId: params.workspaceId })
    this.goal = params.goal
    this.plan = params.plan
    this.verifierFeedback = params.verifierFeedback
    this.agentId = `mpa-builder-${params.workspaceId}`
  }

  protected buildPhaseSystemPrompt(): string {
    return buildBuilderSystemPrompt({
      goal: this.goal,
      plan: this.plan,
      workspaceName: this.workspaceName,
      detectedTechs: this.detectedTechs,
      verifierFeedback: this.verifierFeedback
    })
  }

  protected getPhaseMessage(): string {
    if (this.verifierFeedback) {
      return 'Fix all issues reported by the verifier, then re-run tests.'
    }
    return 'Begin implementation. Follow the plan in dependency order.'
  }

  /**
   * Builder gets full write access — overrides the read-only base config.
   */
  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        // Full read/write
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'WebSearch',
        'WebFetch',
        'ListDir',
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
        'Agent',
        'ToolSearch',
        'AskUserQuestion',
        'TodoWrite'
      ]
    }
  }
}

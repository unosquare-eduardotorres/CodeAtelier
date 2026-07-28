import { MpaBaseAdapter } from './mpa-base.adapter'
import { buildBuilderSystemPrompt } from '../../mpa-prompts'
import { TOOL_PRIORITY_DIRECTIVE_BUILDER } from '../../default-prompts'
import type { AgentRole } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { MpaPlanArtifact, MpaVerifyReport } from '../../../../shared/mpa-types'
import { MCP_TOOLS } from '../../../../shared/constants'

/**
 * MPA Builder Adapter — implements the approved plan with full write access.
 *
 * CLI config: --permission-mode auto, --effort high, --goal "condition", --max-turns 50
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

  protected getModelAction(): import('../../../../shared/types').ModelAction {
    return 'specialist:build' // Builder uses build-tier model
  }

  protected buildPhaseSystemPrompt(): string {
    // Builder uses TOOL_PRIORITY_DIRECTIVE_BUILDER (write-mode variant).
    // Embedding it here means the base class's appendToolGuidance() skips
    // the generic directive (it checks for '## Tool Priority' already present).
    return (
      buildBuilderSystemPrompt({
        goal: this.goal,
        plan: this.plan,
        workspaceName: this.workspaceName,
        detectedTechs: this.detectedTechs,
        verifierFeedback: this.verifierFeedback,
        model: this.resolvedModel
      }) + TOOL_PRIORITY_DIRECTIVE_BUILDER
    )
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
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        // Semantic search
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        // Git context
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        // Code analysis
        ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
        // Memory tools — let builder search/record workspace knowledge (parity with blueprints)
        ...(ctx.workspaceId ? MCP_TOOLS.MEMORY._ALL_NAMES : [])
      ],
      disallowedTools: ['Agent', 'ToolSearch', 'AskUserQuestion', 'TodoWrite']
    }
  }
}

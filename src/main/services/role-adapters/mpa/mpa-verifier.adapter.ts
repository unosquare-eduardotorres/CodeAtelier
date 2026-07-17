import { MpaBaseAdapter } from './mpa-base.adapter'
import { buildVerifierSystemPrompt } from '../../mpa-prompts'
import type { AgentRole } from '../../../../shared/types'
import type { MpaPlanArtifact } from '../../../../shared/mpa-types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import { MCP_TOOLS } from '../../../../shared/constants'

/**
 * MPA Verifier Adapter — read-only auditor that checks implementation completeness.
 *
 * CLI config: --permission-mode plan, --effort xhigh, --goal "condition"
 */
export class MpaVerifierAdapter extends MpaBaseAdapter {
  readonly role: AgentRole = 'mpa-verifier'
  readonly agentId: string

  private readonly goal: string
  private readonly plan: MpaPlanArtifact
  private readonly successCriteria?: string[]

  constructor(params: {
    workspaceId: string
    goal: string
    plan: MpaPlanArtifact
    successCriteria?: string[]
  }) {
    super({ workspaceId: params.workspaceId })
    this.goal = params.goal
    this.plan = params.plan
    this.successCriteria = params.successCriteria
    this.agentId = `mpa-verifier-${params.workspaceId}`
  }

  protected buildPhaseSystemPrompt(): string {
    return buildVerifierSystemPrompt({
      goal: this.goal,
      plan: this.plan,
      workspaceName: this.workspaceName,
      successCriteria: this.successCriteria,
      model: this.resolvedModel
    })
  }

  protected getPhaseMessage(): string {
    return 'Begin verification. Check every plan item against the actual codebase.'
  }

  /**
   * VERIFY gets read-only + Bash + ListDir (for test execution and directory traversal).
   * Write/Edit remain disabled — verification doesn't modify code.
   */
  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'Bash',    // For running tests + lint + typecheck
        'ListDir', // For directory traversal verification
        'WebSearch',
        'WebFetch',
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
        ...(ctx.workspaceId ? MCP_TOOLS.MEMORY._ALL_NAMES : [])
      ],
      disallowedTools: [
        'Write',
        'Edit',
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
}

/**
 * Blueprint Verify Adapter — read-only + Bash agent that performs adversarial verification.
 *
 * CLI config: --permission-mode plan, --effort xhigh, goalMode: enforce (/goal via stdin)
 *
 * Key difference from other blueprint adapters: overrides buildMcpConfig() to add
 * Bash + ListDir while keeping Write/Edit disabled. The verify prompt calls for
 * "limited testing commands" — Bash is needed to run npm test, npx tsc, etc.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { PhaseContext } from '../../../../shared/blueprint-types'
import { MCP_TOOLS } from '../../../../shared/constants'

export class BlueprintVerifyAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-verify'
  readonly agentId: string

  private readonly phaseContext: PhaseContext

  constructor(params: { workspaceId: string; blueprintId: string; phaseContext: PhaseContext }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.agentId = `blueprint-verify-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:verify'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('verify', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Begin adversarial verification of the BUILD phase output.',
      '',
      'Apply the 4-level artifact verification methodology:',
      '1. EXISTS — file present at expected path',
      '2. SUBSTANTIVE — real implementation, not stubs',
      '3. WIRED — imported and used by other code',
      '4. DATA FLOWING — real data traverses the wiring',
      '',
      'Scan for anti-patterns, verify all key links from the plan,',
      'trace each spec requirement to code, and run tests if available.',
      '',
      'Emit a `blueprint-phase-complete` block with phase: "verify",',
      'overallStatus, artifact counts, and recommendation.'
    ].join('\n')
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
        'Bash', // For running tests + inspection commands
        'ListDir', // For directory traversal verification
        'WebSearch',
        'WebFetch',
        // Code graph tools
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
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

/**
 * Blueprint Specify Adapter — read-only architect that produces feature specifications.
 *
 * CLI config: --permission-mode plan, --effort high, goalMode: enforce (/goal via stdin)
 *
 * Following the MpaPlannerAdapter pattern: extends base, injects phase-specific
 * prompt via buildPhaseSystemPrompt(), and provides the initial phase message.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext, GrillDecisionForBlueprint } from '../../../../shared/blueprint-types'

export class BlueprintSpecifyAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-specify'
  readonly agentId: string

  private readonly description: string
  private readonly grillDecisions?: GrillDecisionForBlueprint[]
  private readonly phaseContext: PhaseContext
  private readonly referenceDocsBlock?: string

  constructor(params: {
    workspaceId: string
    blueprintId: string
    description: string
    grillDecisions?: GrillDecisionForBlueprint[]
    phaseContext: PhaseContext
    referenceDocsBlock?: string
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.description = params.description
    this.grillDecisions = params.grillDecisions
    this.phaseContext = params.phaseContext
    this.referenceDocsBlock = params.referenceDocsBlock
    this.agentId = `blueprint-specify-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:specify'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('specify', this.phaseContext)
  }

  getPhaseMessage(): string {
    const parts: string[] = [
      'Generate a detailed specification for this feature:',
      '',
      this.description
    ]

    if (this.grillDecisions?.length) {
      parts.push(
        '',
        '## Grill Decisions (from prior analysis)',
        '',
        ...this.grillDecisions.map(
          (d) => `- **${d.header}**: ${d.selectedOption}\n  _Reason_: ${d.reason}`
        )
      )
    }

    if (this.referenceDocsBlock) {
      parts.push(
        '',
        '## Reference Documents (attached by user)',
        '',
        this.referenceDocsBlock
      )
    }

    return parts.join('\n')
  }
}

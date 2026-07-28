/**
 * Blueprint Clarify Adapter — interactive agent that identifies spec gaps and asks questions.
 *
 * Unlike SPECIFY (one-shot), CLARIFY is interactive: the first turn triggers
 * gap analysis, follow-up turns are user answers via session.send().
 *
 * CLI config: --permission-mode plan, --effort high, goalMode: enforce (/goal via stdin)
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintClarifyAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-clarify'
  readonly agentId: string

  private readonly phaseContext: PhaseContext

  constructor(params: { workspaceId: string; blueprintId: string; phaseContext: PhaseContext }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.agentId = `blueprint-clarify-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:clarify'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('clarify', this.phaseContext)
  }

  getPhaseMessage(): string {
    return 'Analyze the specification for gaps and ambiguities. Present your questions.'
  }
}

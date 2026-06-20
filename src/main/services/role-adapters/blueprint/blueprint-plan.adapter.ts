/**
 * Blueprint Plan Adapter — read-only planner that produces implementation plans.
 *
 * CLI config: --permission-mode plan, --effort xhigh, --goal "condition"
 *
 * One-shot phase: agent reads spec artifacts, investigates codebase,
 * produces a structured plan with items, risks, and dependency graph.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintPlanAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-plan'
  readonly agentId: string

  private readonly phaseContext: PhaseContext

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.agentId = `blueprint-plan-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:plan'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('plan', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Create a detailed implementation plan from the specification.',
      '',
      'Start with Phase 0 (Research): investigate the codebase for existing patterns,',
      'conventions, and reusable code that the plan should reference.',
      '',
      'Then apply Goal-Backward methodology to derive the plan items.',
      'Emit the plan as a `blueprint-plan` JSON block and a `blueprint-phase-complete` block.'
    ].join('\n')
  }
}

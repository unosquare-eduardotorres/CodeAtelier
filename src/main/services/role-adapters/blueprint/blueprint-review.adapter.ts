/**
 * Blueprint Review Adapter — read-only quality gate that validates cross-artifact consistency.
 *
 * CLI config: --permission-mode plan, --effort high, goalMode: enforce (/goal via stdin)
 *
 * One-shot phase: agent reads spec + plan + tasks artifacts, investigates codebase
 * for path validation, and produces a review report with findings and recommendation.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintReviewAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-review'
  protected get usageFeature(): string {
    return 'blueprint-review'
  }
  readonly agentId: string

  private readonly phaseContext: PhaseContext

  constructor(params: { workspaceId: string; blueprintId: string; phaseContext: PhaseContext }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.agentId = `blueprint-review-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:review'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('review', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Perform a comprehensive review of the blueprint artifacts before BUILD begins.',
      '',
      'Analyze: spec ↔ plan coverage, plan ↔ tasks decomposition, end-to-end traceability,',
      'constitution compliance, risk assessment, and quality checks.',
      '',
      'Validate file paths against the actual codebase structure.',
      '',
      'Produce a structured review report and emit a `blueprint-phase-complete` block',
      'with findings counts and your recommendation (proceed / fix_critical / re_specify).'
    ].join('\n')
  }
}

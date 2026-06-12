/**
 * Blueprint Tasks Adapter — read-only decomposer that produces wave-ordered implementation tasks.
 *
 * CLI config: --permission-mode plan, --effort xhigh, --goal "condition"
 *
 * One-shot phase: agent reads spec + plan artifacts, investigates codebase,
 * produces a structured task list with waves, dependencies, and file ownership.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintTasksAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-tasks'
  readonly agentId: string

  private readonly phaseContext: PhaseContext

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.agentId = `blueprint-tasks-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:tasks'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('tasks', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Decompose the implementation plan into wave-ordered, dependency-respecting tasks.',
      '',
      'Start by reviewing the spec and plan artifacts, then investigate the codebase',
      'to validate file paths and identify existing patterns the tasks should follow.',
      '',
      'Each task must be atomic (1-5 files), independently verifiable, and have',
      'explicit file paths. Same-wave tasks must have zero file overlap.',
      '',
      'Emit the tasks as a `blueprint-tasks` JSON block and a `blueprint-phase-complete` block.'
    ].join('\n')
  }
}

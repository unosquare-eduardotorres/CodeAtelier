import { MpaBaseAdapter } from './mpa-base.adapter'
import { buildPlannerSystemPrompt } from '../../mpa-prompts'
import type { AgentRole } from '../../../../shared/types'
import type { GrillDecision, MpaPlanArtifact } from '../../../../shared/mpa-types'

/**
 * MPA Planner Adapter — read-only architect that produces implementation plans.
 *
 * CLI config: --permission-mode plan, --effort high, --goal "condition"
 */
export class MpaPlannerAdapter extends MpaBaseAdapter {
  readonly role: AgentRole = 'mpa-planner'
  readonly agentId: string

  private readonly goal: string
  private readonly grillDecisions?: GrillDecision[]
  private readonly previousPlan?: { contentJson: MpaPlanArtifact }
  private readonly userFeedback?: string

  constructor(params: {
    workspaceId: string
    goal: string
    grillDecisions?: GrillDecision[]
    previousPlan?: { contentJson: MpaPlanArtifact }
    userFeedback?: string
  }) {
    super({ workspaceId: params.workspaceId })
    this.goal = params.goal
    this.grillDecisions = params.grillDecisions
    this.previousPlan = params.previousPlan
    this.userFeedback = params.userFeedback
    this.agentId = `mpa-planner-${params.workspaceId}`
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPlannerSystemPrompt({
      goal: this.goal,
      workspaceName: this.workspaceName,
      detectedTechs: this.detectedTechs,
      grillDecisions: this.grillDecisions,
      previousPlan: this.previousPlan,
      userFeedback: this.userFeedback,
      model: this.resolvedModel
    })
  }

  protected getPhaseMessage(): string {
    if (this.previousPlan && this.userFeedback) {
      return 'Revise the plan based on the feedback above.'
    }
    return 'Investigate the codebase and produce your implementation plan.'
  }
}

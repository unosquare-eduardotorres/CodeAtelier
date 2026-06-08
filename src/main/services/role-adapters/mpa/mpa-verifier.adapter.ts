import { MpaBaseAdapter } from './mpa-base.adapter'
import { buildVerifierSystemPrompt } from '../../mpa-prompts'
import type { AgentRole } from '../../../../shared/types'
import type { MpaPlanArtifact } from '../../../../shared/mpa-types'

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
}

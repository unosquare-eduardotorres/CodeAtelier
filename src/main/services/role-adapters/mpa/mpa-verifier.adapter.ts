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

  constructor(params: {
    workspaceId: string
    goal: string
    plan: MpaPlanArtifact
  }) {
    super({ workspaceId: params.workspaceId })
    this.goal = params.goal
    this.plan = params.plan
    this.agentId = `mpa-verifier-${params.workspaceId}`
  }

  protected buildPhaseSystemPrompt(): string {
    return buildVerifierSystemPrompt({
      goal: this.goal,
      plan: this.plan,
      workspaceName: this.workspaceName
    })
  }

  protected getPhaseMessage(): string {
    return 'Begin verification. Check every plan item against the actual codebase.'
  }
}

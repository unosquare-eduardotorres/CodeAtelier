/**
 * Blueprint Plan Revision Adapter — one conversational turn of "change this".
 *
 * Runs when the human clicks Request Changes at the approval gate. It resumes
 * the REVIEW conversation, so the agent already has the spec, plan, tasks and
 * its own review report in context and can make a targeted edit instead of
 * re-deriving the plan from scratch (which is what a full rewind to PLAN costs:
 * plan + tasks + review, ~20 minutes, before the human can look again).
 *
 * Read-only, like every other blueprint phase adapter. The only thing this turn
 * is allowed to change is the plan artifact, and it changes it by *emitting* a
 * revised plan — never by writing to the repo.
 *
 * Reuses role `blueprint-review` and model action `blueprint:review`: a revision
 * turn is review-phase work, and giving it its own role would mean a new entry
 * in every model-config mapping for no behavioural gain.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintPlanRevisionAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-review'
  protected get usageFeature(): string {
    return 'blueprint-plan-revision'
  }
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly feedback: string
  private readonly round: number

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    feedback: string
    round: number
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.feedback = params.feedback
    this.round = params.round
    this.agentId = `blueprint-plan-revision-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:review'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('review', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      `## Change request from the human (round ${this.round})`,
      '',
      this.feedback,
      '',
      '---',
      '',
      'This is a direct instruction from the person who owns this work. It is a',
      'requirement, not a suggestion, and it outranks your earlier choices.',
      '',
      'Revise the **plan** to satisfy it. You already have the spec, plan, tasks and',
      'your own review report in this conversation — make a targeted revision, do not',
      'rewrite the plan from scratch and do not discard decisions that this request',
      'did not object to.',
      '',
      '**Do not modify any files.** This turn changes the plan artifact only, and it',
      'does so by emitting it below. Read the codebase freely to check feasibility.',
      '',
      'Reply with exactly two fenced blocks:',
      '',
      '1. A `blueprint-plan-revision` JSON block:',
      '',
      '```blueprint-plan-revision',
      '{',
      '  "summary": "<one or two sentences: what you changed and why>",',
      '  "changes": ["<one bullet per concrete change>"],',
      '  "concerns": ["<anything you think is wrong or infeasible about the request — empty array if none>"],',
      '  "planMarkdown": "<the COMPLETE revised plan, not a diff>"',
      '}',
      '```',
      '',
      '2. Then the same revised plan as plain markdown, for the human to read.',
      '',
      'If you believe the request is mistaken or infeasible, still emit the block —',
      'put your objection in `concerns` and leave the plan as close to unchanged as',
      'honesty allows. Silently doing something else reads to the human exactly like',
      'their feedback having been thrown away, which is the failure this loop exists',
      'to fix.'
    ].join('\n')
  }
}

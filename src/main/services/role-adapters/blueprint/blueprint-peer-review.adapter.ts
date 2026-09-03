/**
 * Blueprint Peer-Review Adapter — per-task advisory review (M5).
 *
 * CLI config: --permission-mode plan, goalMode: enforce (/goal via stdin)
 *
 * A cheap model reviews ONE task's diff against its work packet. The rubric is
 * the closed four-category peer rubric (PEER_RUBRIC_CATEGORIES) — style
 * opinions are dropped by the parser, not passed to the builder.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPeerReviewSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'
import type { BlueprintWorkPacket } from '../../../../shared/blueprint-types'
import { renderWorkPacket } from '../../../../shared/work-packet-prompt'

export class BlueprintPeerReviewAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-review' // reuses the review role's CLI profile
  protected get usageFeature(): string {
    return 'blueprint-peer-review'
  }
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly diff: string
  private readonly packet: BlueprintWorkPacket | null
  private readonly taskDescription: string

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    /** Task-scoped diff (baseline..HEAD, write-set filtered). */
    diff: string
    /** The work packet the task was built against — the review contract. */
    packet: BlueprintWorkPacket | null
    taskDescription: string
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.diff = params.diff
    this.packet = params.packet
    this.taskDescription = params.taskDescription
    this.agentId = `blueprint-peer-review-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:peer-review'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPeerReviewSystemPrompt(this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      `Peer review of task: ${this.taskDescription}`,
      '',
      'You are a peer reviewer. The deterministic gates already passed — tests',
      'went red→green and the write-set was respected. Your job is the inverse:',
      'what the work packet required that the diff did not do.',
      '',
      'Judge ONLY against these four categories:',
      '- ac-coverage: an acceptance criterion the diff does not satisfy',
      '- packet-compliance: the diff ignores something the work packet specified',
      '- stub-residue: TODO / debug logging / commented-out code left behind',
      '- write-set: files changed that the packet write-set does not cover',
      '',
      'Findings outside these categories are dropped. Style opinions are not',
      'findings.',
      '',
      this.packet
        ? ['The work packet this task was built against:', '', renderWorkPacket(this.packet)].join(
            '\n'
          )
        : '(no work packet was recorded for this task — judge the diff alone)',
      '',
      'Every finding must name a file, a one-sentence issue, and a mechanically',
      'actionable requiredChange (a builder must be able to act on it without',
      'guessing).',
      '',
      'Emit a `blueprint-review-findings` block with a findings array. An empty',
      'findings array is a valid, common result.',
      '',
      '--- TASK DIFF (baseline..HEAD, write-set scoped) ---',
      this.diff || '(empty diff — nothing was changed)',
      '--- END DIFF ---'
    ].join('\n')
  }
}

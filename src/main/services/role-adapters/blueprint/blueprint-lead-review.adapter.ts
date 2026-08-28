/**
 * Blueprint Lead-Review-Pass Adapter — post-verify whole-diff lead review (M6.1).
 *
 * CLI config: --permission-mode plan, --effort high, goalMode: enforce (/goal via stdin)
 *
 * The lead sees the whole feature diff AND the verify report — unlike the
 * code-review layer it judges cross-task failure modes: code that passes its
 * tests while diverging from the spec, and code written to satisfy the test
 * rather than the intent. Findings use the closed lead rubric
 * (LEAD_RUBRIC_CATEGORIES) and are parsed by the existing `parseLeadReview`.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildLeadReviewPassSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintLeadReviewAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-review' // reuses the review role's CLI profile
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly diff: string
  private readonly verifySummary: string

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    /** Whole-feature diff (baseline..HEAD) — the lead's primary input. */
    diff: string
    /** Condensed verify outcome (overallStatus + findings) for context. */
    verifySummary: string
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.diff = params.diff
    this.verifySummary = params.verifySummary
    this.agentId = `blueprint-lead-review-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:lead-review'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildLeadReviewPassSystemPrompt(this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Lead review of the complete feature diff, after verification passed.',
      '',
      'You are the lead reviewer. The gates and the verifier have already run —',
      'your job is the cross-task judgment they structurally cannot make:',
      '- spec-drift: passes its tests but diverges from the spec, plan or ACs',
      '- test-gaming: satisfies the letter of a test while missing what it checks',
      '- correctness: real bugs the gates could not execute',
      '- ac-coverage: an acceptance criterion the diff does not satisfy',
      '- packet-compliance: the diff ignores something the work packet specified',
      '- stub-residue: TODO / debug logging / commented-out code left behind',
      '- write-set: files changed that the tasks\u2019 write-sets do not cover',
      '',
      'The verify phase reported:',
      this.verifySummary || '(no verify report available)',
      '',
      'The full feature diff (baseline..HEAD) is provided below. Judge what the',
      'diff actually does against the spec — not what it was meant to do.',
      '',
      'Every finding must name a file, a one-sentence issue, and a mechanically',
      'actionable requiredChange (a builder must be able to act on it without',
      'guessing). Findings outside the rubric categories above are dropped.',
      '',
      'Emit a `blueprint-review-findings` block with a findings array and your',
      'verdict: approved / changes-required. The verdict is approved only when',
      'there are zero findings.',
      '',
      '--- FEATURE DIFF (baseline..HEAD) ---',
      this.diff || '(empty diff — nothing was built)',
      '--- END DIFF ---'
    ].join('\n')
  }
}

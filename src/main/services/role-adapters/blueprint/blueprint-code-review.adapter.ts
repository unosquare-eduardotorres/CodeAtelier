/**
 * Blueprint Code-Review Adapter — adversarial external reviewer over the
 * whole-feature diff (M7.2).
 *
 * CLI config: --permission-mode plan, --effort high, goalMode: enforce (/goal via stdin)
 *
 * External-reviewer stance: the reviewer sees the diff and the workspace
 * conventions, NOT the builders' reasoning. It judges the code as a stranger
 * would — the only artifacts it receives are spec/plan/build (per
 * PHASE_ARTIFACT_RELEVANCE), and the diff is injected directly by this
 * adapter rather than arriving as an artifact.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { PhaseContext } from '../../../../shared/blueprint-types'

export class BlueprintCodeReviewAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-review' // reuses the review role's CLI profile
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly diff: string

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    /** Whole-feature diff (baseline..HEAD) — the reviewer's primary input. */
    diff: string
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.diff = params.diff
    this.agentId = `blueprint-code-review-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:code-review'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('code-review', this.phaseContext)
  }

  getPhaseMessage(): string {
    return [
      'Review the complete diff of this feature as an external reviewer.',
      '',
      'You did not write this code and you do not have the builders\u2019 reasoning.',
      'Judge what the diff actually does against the spec and the workspace',
      'conventions — not what it was meant to do.',
      '',
      'The full feature diff (baseline..HEAD) is provided below. Review it for:',
      '- correctness bugs, edge cases, and error handling',
      '- security issues (injection, path traversal, secrets)',
      '- performance traps (N+1, unbounded growth, sync I/O on hot paths)',
      '- convention violations visible in the diff',
      '- test coverage gaps for changed behaviour',
      '',
      'For every finding, name the file (and line when possible), classify the',
      'severity (critical / high / medium / low), and give a one-line summary.',
      'Suggest a concrete fix where you can.',
      '',
      'Emit a `blueprint-phase-complete` block with phase: "code-review",',
      'status: "complete", a findings array, and your verdict:',
      'approve / fix_required / concerns_noted.',
      '',
      '--- FEATURE DIFF (baseline..HEAD) ---',
      this.diff || '(empty diff — nothing was built)',
      '--- END DIFF ---'
    ].join('\n')
  }
}

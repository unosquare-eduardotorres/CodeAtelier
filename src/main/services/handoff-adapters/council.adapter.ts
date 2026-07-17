/**
 * council.adapter — Converts Council session + verdict into a HandoffEnvelope.
 *
 * Extracts verdict sections (agrees, clashes, blind spots, recommendation),
 * individual advisor scores, and revisions.
 */

import { HandoffSourceAdapter } from './base.adapter'
import type {
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef,
  HandoffSource
} from '../../../shared/handoff-types'
import type { CouncilSession } from '../../../shared/types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface CouncilAdapterInput {
  session: CouncilSession
  planRecordId?: string
}

// ── Adapter ──────────────────────────────────────────────────────────

class CouncilHandoffAdapter extends HandoffSourceAdapter<CouncilAdapterInput> {
  readonly source: HandoffSource = 'council'

  extractIntent(input: CouncilAdapterInput): string {
    const verdict = input.session.verdict
    if (verdict) {
      return `Apply council verdict (score: ${verdict.overallScore}/10): ${verdict.sections.oneThingFirst}`
    }
    return `Council review session ${input.session.id}`
  }

  extractOriginalGoal(input: CouncilAdapterInput): string {
    return input.session.inputContent.slice(0, 500)
  }

  extractContextSummary(input: CouncilAdapterInput): string {
    const lines: string[] = []
    const verdict = input.session.verdict
    lines.push(`## Council Review Summary`)
    lines.push(`**Input Type:** ${input.session.inputType}`)
    lines.push(`**Phase:** ${input.session.phase}`)

    if (verdict) {
      lines.push(`**Overall Score:** ${verdict.overallScore}/10`)

      lines.push(`\n### Agreements`)
      lines.push(verdict.sections.agrees)

      lines.push(`\n### Clashes`)
      lines.push(verdict.sections.clashes)

      lines.push(`\n### Blind Spots`)
      lines.push(verdict.sections.blindSpots)

      lines.push(`\n### Recommendation`)
      lines.push(verdict.sections.recommendation)

      lines.push(`\n### Priority Action`)
      lines.push(verdict.sections.oneThingFirst)

      if (verdict.individualScores) {
        lines.push(`\n### Individual Scores`)
        for (const [role, score] of Object.entries(verdict.individualScores)) {
          lines.push(`- **${role}**: ${score}/10`)
        }
      }
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: CouncilAdapterInput): CompletedStep[] {
    const steps: CompletedStep[] = []

    steps.push({
      title: 'Council review completed',
      outcome: `${input.session.reviews.length} advisor review(s), ${input.session.peerReviews.length} peer review(s)`,
    })

    if (input.session.verdict) {
      steps.push({
        title: 'Verdict rendered',
        outcome: `Overall score: ${input.session.verdict.overallScore}/10`,
      })
    }

    return steps
  }

  extractRemainingWork(input: CouncilAdapterInput): RemainingStep[] {
    const verdict = input.session.verdict
    if (!verdict?.revisions) return []

    return verdict.revisions.map((revision, i) => ({
      title: `Revision ${i + 1}`,
      description: typeof revision === 'string' ? revision : JSON.stringify(revision),
      priority: 'medium' as const,
    }))
  }

  extractDecisions(input: CouncilAdapterInput): HandoffDecision[] {
    const verdict = input.session.verdict
    if (!verdict) return []

    const decisions: HandoffDecision[] = []

    if (verdict.sections.recommendation) {
      decisions.push({
        what: 'Council recommendation',
        why: verdict.sections.recommendation,
      })
    }

    if (verdict.sections.oneThingFirst) {
      decisions.push({
        what: 'Priority action',
        why: verdict.sections.oneThingFirst,
      })
    }

    return decisions
  }

  extractConstraints(input: CouncilAdapterInput): string[] {
    const verdict = input.session.verdict
    if (!verdict?.sections.clashes) return []
    // Extract key constraints from the clashes section
    return [`Council clash areas: ${verdict.sections.clashes.slice(0, 200)}`]
  }

  extractRisks(input: CouncilAdapterInput): HandoffRisk[] {
    const verdict = input.session.verdict
    if (!verdict?.sections.blindSpots) return []

    return [{
      risk: 'Blind spots identified by council',
      severity: 'medium',
      mitigation: verdict.sections.blindSpots.slice(0, 500),
    }]
  }

  extractArtifacts(input: CouncilAdapterInput): ArtifactRef[] {
    return [{
      type: 'plan',
      path: `council-session:${input.session.id}`,
      description: `Council session with verdict`,
    }]
  }

  extractStructuredPlanRef(input: CouncilAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: CouncilAdapterInput): Record<string, unknown> {
    return {
      councilSessionId: input.session.id,
      overallScore: input.session.verdict?.overallScore,
      individualScores: input.session.verdict?.individualScores,
      phase: input.session.phase,
    }
  }
}

export const councilAdapter = new CouncilHandoffAdapter()

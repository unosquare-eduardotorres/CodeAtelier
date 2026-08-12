/**
 * grill.adapter — Converts Grill session data into a HandoffEnvelope.
 *
 * Extracts decisions (organized by track), track scores, constraints,
 * and risks from the GrillStructuredPlan + GrillSession.
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
import type { GrillStructuredPlan, GrillTrackScore } from '../../../shared/types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface GrillAdapterInput {
  ideaTitle: string
  ideaDescription: string
  session: {
    id: string
    trackScores: GrillTrackScore[]
    iterationCount: number
    status: string
  }
  plan: GrillStructuredPlan | null
  planRecordId?: string // If already registered in plans table
}

// ── Adapter ──────────────────────────────────────────────────────────

class GrillHandoffAdapter extends HandoffSourceAdapter<GrillAdapterInput> {
  readonly source: HandoffSource = 'grill'

  extractIntent(input: GrillAdapterInput): string {
    if (input.plan) {
      return `Implement grilled plan: ${input.plan.title}`
    }
    return `Implement idea: ${input.ideaTitle}`
  }

  extractOriginalGoal(input: GrillAdapterInput): string {
    return input.ideaDescription || input.ideaTitle
  }

  extractContextSummary(input: GrillAdapterInput): string {
    const lines: string[] = []
    lines.push(`## Grill Evaluation Summary`)
    lines.push(`**Idea:** ${input.ideaTitle}`)
    lines.push(`**Iterations:** ${input.session.iterationCount}`)
    lines.push(`**Status:** ${input.session.status}`)

    if (input.session.trackScores.length > 0) {
      lines.push(`\n### Track Scores`)
      for (const ts of input.session.trackScores) {
        lines.push(`- **${ts.trackId}**: ${ts.score}/10 (${ts.scoreLabel})`)
      }
    }

    if (input.plan) {
      lines.push(`\n### Plan: ${input.plan.title}`)
      lines.push(input.plan.summary)
      lines.push(`\n**Goal Type:** ${input.plan.goalType}`)
      lines.push(`**Items:** ${input.plan.items.length}`)
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: GrillAdapterInput): CompletedStep[] {
    const steps: CompletedStep[] = []

    steps.push({
      title: 'Grill evaluation completed',
      outcome: `Evaluated across ${input.session.trackScores.length} tracks, ${input.session.iterationCount} iterations`
    })

    if (input.plan) {
      steps.push({
        title: 'Structured plan generated',
        outcome: `${input.plan.items.length} implementation items identified`
      })
    }

    return steps
  }

  extractRemainingWork(input: GrillAdapterInput): RemainingStep[] {
    if (!input.plan) return []

    return input.plan.items.map((item) => ({
      title: item.title,
      description: item.description,
      priority: 'medium' as const,
      estimatedComplexity: Math.min(
        10,
        Math.max(1, (item.files?.length ?? 0) + (item.dependsOn?.length ?? 0))
      )
    }))
  }

  extractDecisions(input: GrillAdapterInput): HandoffDecision[] {
    if (!input.plan) return []

    return input.plan.decisions.flatMap((track) =>
      track.items.map((d) => ({
        what: `[${track.trackName}] ${d.question} → ${d.answer}`,
        why: d.rationale
      }))
    )
  }

  extractConstraints(input: GrillAdapterInput): string[] {
    return input.plan?.constraints ?? []
  }

  extractRisks(input: GrillAdapterInput): HandoffRisk[] {
    if (!input.plan?.risks) return []
    return input.plan.risks.map((r) => ({
      risk: r,
      severity: 'medium' as const
    }))
  }

  extractArtifacts(input: GrillAdapterInput): ArtifactRef[] {
    const refs: ArtifactRef[] = []
    if (input.plan) {
      refs.push({
        type: 'plan',
        path: `grill-session:${input.session.id}`,
        description: `Grill plan: ${input.plan.title}`
      })
    }
    return refs
  }

  extractFilesToReadFirst(input: GrillAdapterInput): string[] {
    if (!input.plan) return []
    return [...new Set(input.plan.items.flatMap((i) => i.files ?? []))]
  }

  extractStructuredPlanRef(input: GrillAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: GrillAdapterInput): Record<string, unknown> {
    return {
      grillSessionId: input.session.id,
      trackScores: input.session.trackScores,
      goalType: input.plan?.goalType
    }
  }
}

export const grillAdapter = new GrillHandoffAdapter()

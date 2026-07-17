/**
 * mpa.adapter — Converts MPA campaign + goals into a HandoffEnvelope.
 *
 * Maps campaign outcomes, goal statuses, and verification results
 * to the unified handoff format.
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
import type { MpaCampaign, MeasurableGoal, MpaCampaignGoalStatus } from '../../../shared/mpa-types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface MpaAdapterInput {
  campaign: MpaCampaign
  goals: Array<{
    goal: MeasurableGoal
    status: MpaCampaignGoalStatus
  }>
  planRecordId?: string
}

// ── Adapter ──────────────────────────────────────────────────────────

class MpaHandoffAdapter extends HandoffSourceAdapter<MpaAdapterInput> {
  readonly source: HandoffSource = 'mpa'

  extractIntent(input: MpaAdapterInput): string {
    const completed = input.goals.filter((g) => g.status === 'completed').length
    const failed = input.goals.filter((g) => g.status === 'failed').length

    if (failed > 0) {
      return `Address ${failed} failed goal(s) from campaign: ${input.campaign.title}`
    }
    if (completed === input.goals.length) {
      return `Campaign complete: ${input.campaign.title} — all ${completed} goals met`
    }
    return `Continue campaign: ${input.campaign.title} (${completed}/${input.goals.length} complete)`
  }

  extractOriginalGoal(input: MpaAdapterInput): string {
    return input.campaign.originalPlanMd.slice(0, 500)
  }

  extractContextSummary(input: MpaAdapterInput): string {
    const lines: string[] = []
    lines.push(`## MPA Campaign Summary`)
    lines.push(`**Title:** ${input.campaign.title}`)
    lines.push(`**Status:** ${input.campaign.status}`)

    const completed = input.goals.filter((g) => g.status === 'completed').length
    const failed = input.goals.filter((g) => g.status === 'failed').length
    const pending = input.goals.filter((g) => g.status === 'pending').length
    lines.push(`**Goals:** ${completed} completed, ${failed} failed, ${pending} pending`)

    lines.push(`\n### Goals`)
    for (const { goal, status } of input.goals) {
      const marker = status === 'completed' ? '✓' : status === 'failed' ? '✗' : '○'
      lines.push(`- ${marker} **${goal.title}** (${status}) — ${goal.outcome}`)
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: MpaAdapterInput): CompletedStep[] {
    return input.goals
      .filter((g) => g.status === 'completed')
      .map(({ goal }) => ({
        title: goal.title,
        outcome: goal.outcome,
      }))
  }

  extractRemainingWork(input: MpaAdapterInput): RemainingStep[] {
    return input.goals
      .filter((g) => g.status === 'pending' || g.status === 'failed')
      .map(({ goal, status }) => ({
        title: goal.title,
        description: `${goal.outcome}\n\nSuccess criteria:\n${goal.successCriteria.map((c) => `- ${c}`).join('\n')}`,
        priority: status === 'failed' ? 'high' as const : 'medium' as const,
        estimatedComplexity: goal.phases.length * 3,
      }))
  }

  extractDecisions(_input: MpaAdapterInput): HandoffDecision[] {
    // MPA campaigns don't produce explicit decisions
    return []
  }

  extractConstraints(_input: MpaAdapterInput): string[] {
    return []
  }

  extractRisks(input: MpaAdapterInput): HandoffRisk[] {
    const failed = input.goals.filter((g) => g.status === 'failed')
    return failed.map(({ goal }) => ({
      risk: `Goal failed: ${goal.title}`,
      severity: 'high' as const,
      mitigation: `Review and retry: ${goal.outcome}`,
    }))
  }

  extractArtifacts(input: MpaAdapterInput): ArtifactRef[] {
    return [{
      type: 'plan',
      path: `mpa-campaign:${input.campaign.id}`,
      description: `MPA campaign: ${input.campaign.title}`,
    }]
  }

  extractStructuredPlanRef(input: MpaAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: MpaAdapterInput): Record<string, unknown> {
    return {
      campaignId: input.campaign.id,
      campaignStatus: input.campaign.status,
      totalGoals: input.goals.length,
      completedGoals: input.goals.filter((g) => g.status === 'completed').length,
      failedGoals: input.goals.filter((g) => g.status === 'failed').length,
    }
  }
}

export const mpaAdapter = new MpaHandoffAdapter()

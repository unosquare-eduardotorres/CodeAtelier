/**
 * blueprint.adapter — Converts Blueprint pipeline state into a HandoffEnvelope.
 *
 * Only for cross-feature handoffs (Blueprint → Chat, Blueprint → Goals).
 * Internal phase transitions remain in the Blueprint state machine.
 *
 * Maps phases to completedWork/remainingWork, tasks to artifacts, and
 * settings to decisions.
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
import type {
  BlueprintWithDetails
} from '../../../shared/blueprint-types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface BlueprintAdapterInput {
  blueprint: BlueprintWithDetails
  planRecordId?: string
}

// ── Adapter ──────────────────────────────────────────────────────────

class BlueprintHandoffAdapter extends HandoffSourceAdapter<BlueprintAdapterInput> {
  readonly source: HandoffSource = 'blueprint'

  extractIntent(input: BlueprintAdapterInput): string {
    const { blueprint } = input
    if (blueprint.status === 'complete') {
      return `Blueprint complete: ${blueprint.title} — apply build results`
    }
    return `Continue blueprint: ${blueprint.title} (${blueprint.status})`
  }

  extractOriginalGoal(input: BlueprintAdapterInput): string {
    return input.blueprint.description
  }

  extractContextSummary(input: BlueprintAdapterInput): string {
    const { blueprint } = input
    const lines: string[] = []
    lines.push(`## Blueprint Summary`)
    lines.push(`**Title:** ${blueprint.title}`)
    lines.push(`**Status:** ${blueprint.status}`)
    lines.push(`**Current Phase:** ${blueprint.currentPhase}`)
    lines.push(`**Priority:** ${blueprint.priority}`)

    if (blueprint.phases.length > 0) {
      lines.push(`\n### Phase Progress`)
      for (const phase of blueprint.phases) {
        const marker = phase.status === 'complete' ? '✓' : phase.status === 'active' ? '▶' : '○'
        lines.push(`- ${marker} **${phase.phase}**: ${phase.status}`)
      }
    }

    if (blueprint.tasks.length > 0) {
      const completed = blueprint.tasks.filter((t) => t.status === 'complete').length
      lines.push(`\n### Tasks: ${completed}/${blueprint.tasks.length} complete`)
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: BlueprintAdapterInput): CompletedStep[] {
    const steps: CompletedStep[] = []

    for (const phase of input.blueprint.phases) {
      if (phase.status === 'complete') {
        const artifacts = phase.artifactsJson ?? []
        steps.push({
          title: `Phase: ${phase.phase}`,
          outcome: `Completed with ${artifacts.length} artifact(s)`,
          filesModified: artifacts
            .filter((a) => a.filePath)
            .map((a) => a.filePath!),
        })
      }
    }

    for (const task of input.blueprint.tasks) {
      if (task.status === 'complete') {
        steps.push({
          title: task.description.slice(0, 100),
          outcome: `Task completed (wave ${task.wave})`,
          filesModified: task.filePathsJson ?? [],
        })
      }
    }

    return steps
  }

  extractRemainingWork(input: BlueprintAdapterInput): RemainingStep[] {
    const remaining: RemainingStep[] = []

    // Remaining phases
    for (const phase of input.blueprint.phases) {
      if (phase.status === 'pending' || phase.status === 'active') {
        remaining.push({
          title: `Phase: ${phase.phase}`,
          description: `Blueprint phase ${phase.phase} (${phase.status})`,
          priority: 'medium',
        })
      }
    }

    // Remaining tasks
    for (const task of input.blueprint.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        remaining.push({
          title: task.description.slice(0, 100),
          description: task.userStory ?? task.description,
          priority: 'medium',
          estimatedComplexity: Math.min(10, Math.max(1, (task.filePathsJson?.length ?? 0) + (task.dependsOnJson?.length ?? 0))),
        })
      }
    }

    return remaining
  }

  extractDecisions(input: BlueprintAdapterInput): HandoffDecision[] {
    const settings = input.blueprint.settingsJson ?? {}
    const decisions: HandoffDecision[] = []

    // Convert relevant settings to decisions
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'string' || typeof value === 'boolean') {
        decisions.push({
          what: `Blueprint setting: ${key}`,
          why: String(value),
        })
      }
    }

    return decisions
  }

  extractConstraints(input: BlueprintAdapterInput): string[] {
    const constraints: string[] = []
    if (input.blueprint.constitutionSnapshot) {
      constraints.push('Blueprint has a constitution snapshot — respect its guidelines')
    }
    return constraints
  }

  extractRisks(input: BlueprintAdapterInput): HandoffRisk[] {
    const failedTasks = input.blueprint.tasks.filter((t) => t.status === 'failed')
    if (failedTasks.length === 0) return []

    return [{
      risk: `${failedTasks.length} task(s) failed during blueprint execution`,
      severity: failedTasks.length > 3 ? 'high' : 'medium',
      mitigation: `Review failed tasks: ${failedTasks.map((t) => t.taskId).join(', ')}`,
    }]
  }

  extractArtifacts(input: BlueprintAdapterInput): ArtifactRef[] {
    const refs: ArtifactRef[] = [{
      type: 'blueprint',
      path: `blueprint:${input.blueprint.id}`,
      description: `Blueprint: ${input.blueprint.title}`,
    }]

    // Include phase artifacts
    for (const phase of input.blueprint.phases) {
      if (phase.status === 'complete' && phase.artifactsJson?.length) {
        for (const artifact of phase.artifactsJson) {
          if (artifact.filePath) {
            refs.push({
              type: 'spec',
              path: artifact.filePath,
              description: `${phase.phase} artifact: ${artifact.type}`,
            })
          }
        }
      }
    }

    return refs
  }

  extractFilesToReadFirst(input: BlueprintAdapterInput): string[] {
    const files = new Set<string>()
    for (const task of input.blueprint.tasks) {
      for (const file of task.filePathsJson ?? []) {
        files.add(file)
      }
    }
    return [...files].slice(0, 20) // Cap at 20 files
  }

  extractStructuredPlanRef(input: BlueprintAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: BlueprintAdapterInput): Record<string, unknown> {
    return {
      blueprintId: input.blueprint.id,
      status: input.blueprint.status,
      currentPhase: input.blueprint.currentPhase,
      priority: input.blueprint.priority,
      taskCount: input.blueprint.tasks.length,
      completedTasks: input.blueprint.tasks.filter((t) => t.status === 'complete').length,
    }
  }
}

export const blueprintAdapter = new BlueprintHandoffAdapter()

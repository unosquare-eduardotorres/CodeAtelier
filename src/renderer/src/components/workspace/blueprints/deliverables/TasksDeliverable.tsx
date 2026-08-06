/**
 * TasksDeliverable — renders execution decomposition (waves, tasks, user stories).
 *
 * Shows wave execution flow diagram, task table (reuses BlueprintTasksCard),
 * user story mapping, and MVP scope.
 */

import { useMemo, type JSX } from 'react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { BlueprintTasksCard } from '../BlueprintPlanCard'
import MermaidDiagram from '@renderer/components/common/MermaidDiagram'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'

// ── Types ──

interface WaveData {
  wave: number
  name?: string
  tasks?: Array<Record<string, unknown>>
  [key: string]: unknown
}

interface UserStoryMapping {
  id: string
  title: string
  priority?: string
  taskIds: string[]
}

// ── Helpers ──

function buildWaveFlow(waves: WaveData[]): string | null {
  if (waves.length <= 1) return null
  const lines = ['graph LR']
  for (const w of waves) {
    const taskCount = w.tasks?.length ?? 0
    const rawLabel = w.name ? `${w.name}` : `Wave ${w.wave}`
    const label = rawLabel.replace(/["<>&[\]]/g, ' ')
    lines.push(`  W${w.wave}["${label}<br/>${taskCount} tasks"]`)
    if (w.wave > 1) {
      lines.push(`  W${w.wave - 1} --> W${w.wave}`)
    }
  }
  return lines.join('\n')
}

function extractUserStories(waves: WaveData[]): UserStoryMapping[] {
  const storyMap = new Map<string, UserStoryMapping>()
  for (const w of waves) {
    for (const t of w.tasks ?? []) {
      const us = (t.userStory as string) ?? null
      const taskId = String(t.taskId ?? t.id ?? '')
      if (us && taskId) {
        const existing = storyMap.get(us)
        if (existing) {
          existing.taskIds.push(taskId)
        } else {
          storyMap.set(us, { id: us, title: us, taskIds: [taskId] })
        }
      }
    }
  }
  return Array.from(storyMap.values())
}

// ── Component ──

export function TasksDeliverable({
  phase,
  duration,
  tasks: dbTasks
}: {
  phase: BlueprintPhase
  duration: number | null
  tasks: BlueprintTask[]
}): JSX.Element {
  const config = PHASE_ICONS.tasks
  const tasksArt = findArtifact(phase.artifactsJson, 'tasks', 'blueprint-tasks')
  const json = tasksArt?.contentJson as Record<string, unknown> | undefined

  const waves = useMemo(() => (json?.waves as WaveData[]) ?? [], [json])
  const flatTasks = useMemo(() => {
    if (waves.length > 0) {
      return waves.flatMap((w) => w.tasks ?? [])
    }
    return (json?.tasks ?? json?.items ?? []) as Array<Record<string, unknown>>
  }, [waves, json])

  const totalTasks = flatTasks.length || dbTasks.length
  const waveCount = waves.length || new Set(dbTasks.map((t) => t.wave)).size || 1

  const mvpScope = (json?.mvpScope as string) ?? null
  const parallelOps = (json?.parallelOpportunities as number) ?? 0
  const userStories = useMemo(() => extractUserStories(waves), [waves])
  const userStoryPhases = (json?.userStoryPhases as unknown[]) ?? []
  const discoveries = extractDiscoveries(phase.artifactsJson)

  const diagram = useMemo(() => buildWaveFlow(waves), [waves])

  // Fallback to markdown
  if (!json && tasksArt?.contentMd) {
    return (
      <div>
        <DeliverableHeader
          config={config}
          summary="Task decomposition completed"
          duration={duration}
        />
        <CappedMarkdownBlock content={tasksArt.contentMd} label="Task Details" className="" />
      </div>
    )
  }

  if (!json) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No tasks artifact found" duration={duration} />
        <p className="text-xs text-text-muted italic">
          The tasks artifact was not produced by this phase.
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`${totalTasks} tasks in ${waveCount} wave${waveCount > 1 ? 's' : ''}`}
        duration={duration}
      />

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricTile label="Total Tasks" value={totalTasks} />
        <MetricTile label="Waves" value={waveCount} />
        <MetricTile label="Parallel" value={`${parallelOps} tasks`} />
        <MetricTile label="User Stories" value={userStories.length || userStoryPhases.length} />
      </div>

      {/* MVP Scope */}
      {mvpScope && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            MVP Scope
          </h3>
          <p className="text-sm text-text-secondary leading-relaxed border-l-2 border-accent/30 pl-4 italic">
            {mvpScope}
          </p>
        </div>
      )}

      {/* Wave flow diagram */}
      {diagram && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Wave Execution Flow
          </h3>
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 overflow-hidden">
            <MermaidDiagram definition={diagram} id="wave-flow" />
          </div>
        </div>
      )}

      {/* Task table (reused component) */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Tasks by Wave
        </h3>
        <BlueprintTasksCard tasks={json} />
      </div>

      {/* User story mapping */}
      {userStories.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            User Story Mapping
          </h3>
          <div className="rounded-xl border border-border-subtle overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-overlay border-b border-border-subtle">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Story
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Tasks
                  </th>
                </tr>
              </thead>
              <tbody>
                {userStories.map((story) => (
                  <tr key={story.id} className="border-b border-border-subtle last:border-b-0">
                    <td className="px-4 py-2 text-text-primary font-medium">{story.title}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {story.taskIds.map((tid) => (
                          <span
                            key={tid}
                            className="inline-block text-xs font-mono bg-surface-inset px-1.5 py-0.5 rounded text-text-secondary"
                          >
                            {tid}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}

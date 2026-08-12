/**
 * BuildDeliverable — renders implementation results.
 *
 * Shows task completion metrics, progress bar, task execution table,
 * and file lists (created / modified).
 */

import { useState, useMemo, type JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  AlertTriangle,
  ChevronDown,
  SkipForward,
  Undo2
} from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { useBlueprintStore } from '../../../../store/blueprint.store'
import { rendererLog } from '../../../../utils/logger'
import { PHASE_ICONS } from '../phase-icons'
import { FileChips } from '../BlueprintPlanCard'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'
import { formatDurationMs } from '../detail/phase-summaries'

// ── Component ──

export function BuildDeliverable({
  phase,
  duration,
  tasks: dbTasks
}: {
  phase: BlueprintPhase
  duration: number | null
  tasks: BlueprintTask[]
}): JSX.Element {
  const config = PHASE_ICONS.build
  const build = findArtifact(phase.artifactsJson, 'build', 'build-metrics')
  const buildPartial = findArtifact(phase.artifactsJson, 'build-partial')
  const json = build?.contentJson as Record<string, unknown> | undefined

  const tasksCompleted =
    (json?.tasksCompleted as number) ?? dbTasks.filter((t) => t.status === 'complete').length
  const totalTasks = (json?.totalTasks as number) ?? dbTasks.length
  const filesCreated = (json?.filesCreated as string[]) ?? []
  const filesModified = (json?.filesModified as string[]) ?? []
  const discoveries = extractDiscoveries(phase.artifactsJson)
  const deviations =
    (json?.deviations as Array<{ rule: number; description: string; files?: string[] }>) ?? []

  const progressPct =
    totalTasks > 0 ? Math.min(100, Math.round((tasksCompleted / totalTasks) * 100)) : 0
  const durationStr = duration != null ? formatDurationMs(duration) : null

  // Group tasks by wave from DB
  const tasksByWave = useMemo(() => {
    const map = new Map<number, BlueprintTask[]>()
    for (const t of dbTasks) {
      const wave = t.wave ?? 0
      if (!map.has(wave)) map.set(wave, [])
      map.get(wave)!.push(t)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b)
  }, [dbTasks])

  // Collapsible file list state
  const [showCreated, setShowCreated] = useState(false)
  const [showModified, setShowModified] = useState(false)

  // BP-TASK-USER-SKIP-01: optimistic overlay so the row updates before the
  // blueprint reload lands. taskId -> skippedAt (null = explicitly un-skipped).
  const [skipOverlay, setSkipOverlay] = useState<Record<string, string | null>>({})
  const [skipPending, setSkipPending] = useState<string | null>(null)
  const loadBlueprint = useBlueprintStore((s) => s.loadBlueprint)

  const toggleSkip = async (task: BlueprintTask, skipped: boolean): Promise<void> => {
    setSkipPending(task.taskId)
    try {
      const res = await window.api.blueprintSkipTask({
        blueprintId: phase.blueprintId,
        taskId: task.taskId,
        skipped
      })
      setSkipOverlay((prev) => ({ ...prev, [task.taskId]: res.skippedAt }))
      await loadBlueprint(phase.blueprintId)
    } catch (error) {
      rendererLog.error('Failed to change task skip state:', error)
    } finally {
      setSkipPending(null)
    }
  }

  // Markdown fallback — older blueprints may have only contentMd, no structured JSON
  if (totalTasks === 0 && !json && build?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="Build completed" duration={duration} />
        <CappedMarkdownBlock content={build.contentMd} label="Build Report" className="mt-4" />
      </div>
    )
  }

  if (totalTasks === 0 && !json) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No build data found" duration={duration} />
        <p className="text-xs text-text-muted italic">
          The build artifact was not produced by this phase.
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`${tasksCompleted}/${totalTasks} tasks complete`}
        duration={duration}
      />

      {/* Partial build warning */}
      {buildPartial && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-warning/20 bg-warning/5 mb-6">
          <AlertTriangle size={16} className="text-warning flex-shrink-0" />
          <span className="text-sm text-text-secondary">Build stopped — partial results shown</span>
        </div>
      )}

      {/* Metrics */}
      <div className={`grid gap-3 mb-6 ${durationStr ? 'grid-cols-4' : 'grid-cols-3'}`}>
        <MetricTile
          label="Tasks"
          value={`${tasksCompleted}/${totalTasks} ✓`}
          variant={tasksCompleted === totalTasks ? 'success' : 'default'}
        />
        <MetricTile label="Created" value={`${filesCreated.length} files`} />
        <MetricTile label="Modified" value={`${filesModified.length} files`} />
        {durationStr && <MetricTile label="Duration" value={durationStr} />}
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <div className="flex-1 h-3 bg-surface-inset rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-success rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-sm font-mono text-text-muted tabular-nums">{progressPct}%</span>
        </div>
      </div>

      {/* Task execution table */}
      {tasksByWave.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Task Execution
          </h3>
          <div className="rounded-xl border border-border-subtle overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-overlay border-b border-border-subtle">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-16">
                    Wave
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-20">
                    Task
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Description
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-28">
                    Status
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-24">
                    Skip
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasksByWave.map(([wave, tasks]) =>
                  tasks.map((task, i) => (
                    <tr
                      key={task.taskId}
                      className={`border-b border-border-subtle last:border-b-0 ${i % 2 === 1 ? 'bg-surface-inset/30' : ''}`}
                    >
                      {i === 0 && (
                        <td
                          className="px-4 py-2 text-xs font-mono text-text-muted align-top"
                          rowSpan={tasks.length}
                        >
                          W{wave}
                        </td>
                      )}
                      <td className="px-4 py-2 text-xs font-mono text-text-secondary">
                        {task.taskId}
                      </td>
                      <td className="px-4 py-2 text-text-secondary">{task.description}</td>
                      <td className="px-4 py-2">
                        {resolveSkippedAt(task, skipOverlay) ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-text-muted"
                            title={`Skipped by you on ${resolveSkippedAt(task, skipOverlay)}`}
                          >
                            <SkipForward size={12} /> Skipped by you
                          </span>
                        ) : (
                          <TaskStatusBadge status={task.status} />
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <SkipTaskButton
                          isSkipped={resolveSkippedAt(task, skipOverlay) != null}
                          isPending={skipPending === task.taskId}
                          onClick={() =>
                            void toggleSkip(task, resolveSkippedAt(task, skipOverlay) == null)
                          }
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Files created */}
      {filesCreated.length > 0 && (
        <CollapsibleFileSection
          label={`Files Created (${filesCreated.length})`}
          files={filesCreated}
          isOpen={showCreated}
          onToggle={() => setShowCreated(!showCreated)}
        />
      )}

      {/* Files modified */}
      {filesModified.length > 0 && (
        <CollapsibleFileSection
          label={`Files Modified (${filesModified.length})`}
          files={filesModified}
          isOpen={showModified}
          onToggle={() => setShowModified(!showModified)}
        />
      )}

      {/* Deviations */}
      {deviations.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            <AlertTriangle size={12} className="inline mr-1 text-warning" />
            Deviations ({deviations.length})
          </h3>
          <div className="space-y-2">
            {deviations.map((d, i) => (
              <div key={i} className="rounded-lg border border-warning/10 bg-warning/5 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-semibold text-warning bg-warning/10 px-1.5 py-0.5 rounded">
                    Rule {d.rule}
                  </span>
                </div>
                <p className="text-sm text-text-secondary">{d.description}</p>
                {d.files && d.files.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {d.files.map((f) => (
                      <span
                        key={f}
                        className="text-[10px] font-mono text-text-muted bg-surface-inset px-1.5 py-0.5 rounded"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}

// ── User-skip helpers ──

/** Optimistic overlay wins over the persisted value until the reload lands. */
function resolveSkippedAt(
  task: BlueprintTask,
  overlay: Record<string, string | null>
): string | null {
  return task.taskId in overlay ? overlay[task.taskId] : task.skippedByUserAt
}

function SkipTaskButton({
  isSkipped,
  isPending,
  onClick
}: {
  isSkipped: boolean
  isPending: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      data-testid="blueprint-task-skip-toggle"
      title={
        isSkipped
          ? 'Un-skip this task — it will run on the next build attempt'
          : 'Skip this task — the decision survives retries'
      }
      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary disabled:opacity-40 transition-colors"
    >
      {isPending ? (
        <Loader2 size={12} className="animate-spin" />
      ) : isSkipped ? (
        <Undo2 size={12} />
      ) : (
        <SkipForward size={12} />
      )}
      {isSkipped ? 'Undo' : 'Skip'}
    </button>
  )
}

// ── Task Status Badge ──

function TaskStatusBadge({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'complete':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-success">
          <CheckCircle2 size={12} /> Complete
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-danger">
          <XCircle size={12} /> Failed
        </span>
      )
    case 'active':
    case 'in_progress':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-accent">
          <Loader2 size={12} className="animate-spin" /> Active
        </span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs text-text-muted">
          <Circle size={12} /> Pending
        </span>
      )
  }
}

// ── Collapsible File Section ──

function CollapsibleFileSection({
  label,
  files,
  isOpen,
  onToggle
}: {
  label: string
  files: string[]
  isOpen: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 hover:text-text-secondary transition-colors"
      >
        <ChevronDown size={12} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        {label}
      </button>
      {isOpen && <FileChips files={files} />}
    </div>
  )
}

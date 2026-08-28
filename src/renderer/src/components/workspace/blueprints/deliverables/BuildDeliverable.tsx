/**
 * BuildDeliverable — renders implementation results.
 *
 * Shows task completion metrics, progress bar, task execution table,
 * and file lists (created / modified).
 */

import { useState, useMemo, type JSX } from 'react'
import {
  CheckCircle2,
  CheckCheck,
  XCircle,
  Loader2,
  Circle,
  AlertTriangle,
  ChevronDown,
  SkipForward,
  Undo2
} from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import type { GateReport } from '../../../../../../shared/gate-types'
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

  // M9.4 — persisted wave-gate evidence (P1.1). One artifact per wave; survives
  // reload, unlike the transient taskGates event.
  const waveGateReports = phase.artifactsJson
    .filter((a) => a.type === 'wave-gates')
    .map((a) => a.contentJson as { wave: number; report: GateReport })
    .filter((w) => w && typeof w.wave === 'number' && w.report?.gates)
    .sort((a, b) => a.wave - b.wave)

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
  // blueprint reload lands. taskId -> resolved skip state (null skippedAt = un-skipped).
  const [skipOverlay, setSkipOverlay] = useState<Record<string, SkipState>>({})
  const [skipPending, setSkipPending] = useState<string | null>(null)
  // Inline note capture for "accept as done" — per-row draft, and the bulk draft.
  const [acceptDraft, setAcceptDraft] = useState<{ taskId: string; note: string } | null>(null)
  const [bulkDraft, setBulkDraft] = useState<string | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  const loadBlueprint = useBlueprintStore((s) => s.loadBlueprint)

  const toggleSkip = async (
    task: BlueprintTask,
    skipped: boolean,
    note?: string
  ): Promise<void> => {
    setSkipPending(task.taskId)
    try {
      const res = await window.api.blueprintSkipTask({
        blueprintId: phase.blueprintId,
        taskId: task.taskId,
        skipped,
        ...(note ? { note } : {})
      })
      setSkipOverlay((prev) => ({
        ...prev,
        [task.taskId]: { skippedAt: res.skippedAt, outcomeKind: res.outcomeKind }
      }))
      setAcceptDraft(null)
      await loadBlueprint(phase.blueprintId)
    } catch (error) {
      rendererLog.error('Failed to change task skip state:', error)
    } finally {
      setSkipPending(null)
    }
  }

  // Failed tasks arrive in clusters, so closing them out one at a time is the
  // slow half of the same problem. Only rows not already user-closed are touched.
  const acceptableFailed = dbTasks.filter(
    (t) => t.status === 'failed' && resolveSkip(t, skipOverlay).skippedAt == null
  )

  const acceptAllFailed = async (note: string): Promise<void> => {
    setBulkPending(true)
    try {
      for (const task of acceptableFailed) {
        const res = await window.api.blueprintSkipTask({
          blueprintId: phase.blueprintId,
          taskId: task.taskId,
          skipped: true,
          ...(note ? { note } : {})
        })
        setSkipOverlay((prev) => ({
          ...prev,
          [task.taskId]: { skippedAt: res.skippedAt, outcomeKind: res.outcomeKind }
        }))
      }
      setBulkDraft(null)
      await loadBlueprint(phase.blueprintId)
    } catch (error) {
      rendererLog.error('Failed to accept failed tasks:', error)
    } finally {
      setBulkPending(false)
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

          {acceptableFailed.length > 1 && (
            <BulkAcceptBar
              count={acceptableFailed.length}
              draft={bulkDraft}
              isPending={bulkPending}
              onOpen={() => setBulkDraft('')}
              onChange={setBulkDraft}
              onCancel={() => setBulkDraft(null)}
              onConfirm={() => void acceptAllFailed((bulkDraft ?? '').trim())}
            />
          )}
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
                  <th className="text-right px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-40">
                    Action
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
                      <td className="px-4 py-2 text-text-secondary">
                        {task.description}
                        {acceptDraft?.taskId === task.taskId && (
                          <AcceptNoteInput
                            note={acceptDraft.note}
                            isPending={skipPending === task.taskId}
                            onChange={(note) => setAcceptDraft({ taskId: task.taskId, note })}
                            onCancel={() => setAcceptDraft(null)}
                            onConfirm={() => void toggleSkip(task, true, acceptDraft.note.trim())}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <TaskStatusBadge task={task} skip={resolveSkip(task, skipOverlay)} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <TaskActionButton
                          isSkipped={resolveSkip(task, skipOverlay).skippedAt != null}
                          isFailed={task.status === 'failed'}
                          isPending={skipPending === task.taskId}
                          onClick={() => {
                            const isSkipped = resolveSkip(task, skipOverlay).skippedAt != null
                            if (isSkipped) {
                              void toggleSkip(task, false)
                            } else if (task.status === 'failed') {
                              setAcceptDraft({ taskId: task.taskId, note: '' })
                            } else {
                              void toggleSkip(task, true)
                            }
                          }}
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

      {/* Wave-gate evidence (M9.4) — lint/build/full-suite per wave, persisted */}
      {waveGateReports.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Wave Gates
          </h3>
          <div className="space-y-2">
            {waveGateReports.map(({ wave, report }) => (
              <WaveGateRow key={wave} wave={wave} report={report} />
            ))}
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

// ── Wave-gate evidence (M9.4) ──

const GATE_VERDICT_STYLE: Record<string, string> = {
  pass: 'text-success bg-success/10',
  fail: 'text-danger bg-danger/10',
  unverifiable: 'text-warning bg-warning/10'
}

function WaveGateRow({ wave, report }: { wave: number; report: GateReport }): JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-inset/30 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono font-semibold text-text-secondary">Wave {wave}</span>
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
            report.overall === 'fail'
              ? 'text-danger bg-danger/10'
              : report.overall === 'unverifiable'
                ? 'text-warning bg-warning/10'
                : 'text-success bg-success/10'
          }`}
        >
          {report.overall}
        </span>
        {report.gates.map((g) => (
          <span
            key={g.name}
            title={g.evidence.join('\n')}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${GATE_VERDICT_STYLE[g.verdict] ?? 'text-text-muted bg-surface-inset'}`}
          >
            {g.name}:{g.verdict}
            {g.verdict === 'unverifiable' && g.reason ? ` (${g.reason})` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── User-skip helpers ──

type SkipState = { skippedAt: string | null; outcomeKind: string | null }

/** Optimistic overlay wins over the persisted value until the reload lands. */
function resolveSkip(task: BlueprintTask, overlay: Record<string, SkipState>): SkipState {
  return overlay[task.taskId] ?? { skippedAt: task.skippedByUserAt, outcomeKind: task.outcomeKind }
}

function TaskActionButton({
  isSkipped,
  isFailed,
  isPending,
  onClick
}: {
  isSkipped: boolean
  isFailed: boolean
  isPending: boolean
  onClick: () => void
}): JSX.Element {
  const label = isSkipped ? 'Undo' : isFailed ? 'Accept as done' : 'Skip'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      data-testid="blueprint-task-skip-toggle"
      title={
        isSkipped
          ? 'Reopen this task — it will run on the next build attempt'
          : isFailed
            ? 'Accept as done — the work is verified externally. The decision survives retries.'
            : 'Skip this task — the decision survives retries'
      }
      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary disabled:opacity-40 transition-colors"
    >
      {isPending ? (
        <Loader2 size={12} className="animate-spin" />
      ) : isSkipped ? (
        <Undo2 size={12} />
      ) : isFailed ? (
        <CheckCheck size={12} />
      ) : (
        <SkipForward size={12} />
      )}
      {label}
    </button>
  )
}

function AcceptNoteInput({
  note,
  isPending,
  onChange,
  onCancel,
  onConfirm
}: {
  note: string
  isPending: boolean
  onChange: (note: string) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 mt-2">
      <input
        type="text"
        autoFocus
        value={note}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Why is this done? (optional)"
        data-testid="blueprint-task-accept-note"
        className="flex-1 text-xs bg-surface-inset border border-border-subtle rounded-lg px-2 py-1 text-text-secondary placeholder:text-text-muted focus:outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={onConfirm}
        disabled={isPending}
        data-testid="blueprint-task-accept-confirm"
        className="text-xs text-success hover:opacity-80 disabled:opacity-40"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-text-muted hover:text-text-secondary"
      >
        Cancel
      </button>
    </div>
  )
}

function BulkAcceptBar({
  count,
  draft,
  isPending,
  onOpen,
  onChange,
  onCancel,
  onConfirm
}: {
  count: number
  draft: string | null
  isPending: boolean
  onOpen: () => void
  onChange: (note: string) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-2 mb-3 rounded-xl border border-border-subtle bg-surface-inset/40">
      <AlertTriangle size={14} className="text-warning flex-shrink-0" />
      <span className="text-xs text-text-secondary flex-1">
        {count} failed task{count > 1 ? 's' : ''} — accept them if the work is verified externally.
      </span>
      {draft == null ? (
        <button
          type="button"
          onClick={onOpen}
          data-testid="blueprint-task-accept-all"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
        >
          <CheckCheck size={12} /> Accept all as done
        </button>
      ) : (
        <AcceptNoteInput
          note={draft}
          isPending={isPending}
          onChange={onChange}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </div>
  )
}

// ── Task Status Badge ──

/**
 * A user-closed row and a wave-drained row both carried `status = 'skipped'`
 * and read as a generic skip — the UI half of "nothing tells me a decision was
 * already made here". `outcomeKind` separates them.
 */
function TaskStatusBadge({ task, skip }: { task: BlueprintTask; skip: SkipState }): JSX.Element {
  if (skip.skippedAt) {
    const accepted = skip.outcomeKind === 'accepted_by_user'
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs ${accepted ? 'text-success' : 'text-text-muted'}`}
        title={
          (accepted
            ? `Accepted by you on ${skip.skippedAt}`
            : `Skipped by you on ${skip.skippedAt}`) +
          (task.resolutionNote ? ` — ${task.resolutionNote}` : '')
        }
      >
        {accepted ? <CheckCheck size={12} /> : <SkipForward size={12} />}
        {accepted ? 'Accepted by you' : 'Skipped by you'}
      </span>
    )
  }

  switch (task.status) {
    case 'complete':
      return task.outcomeKind === 'unproven' ? (
        <span
          className="inline-flex items-center gap-1 text-xs text-warning"
          title="Complete — every claimed file exists, but none could be proven written during this run."
        >
          <AlertTriangle size={12} /> Complete (unproven)
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-success">
          <CheckCircle2 size={12} /> Complete
        </span>
      )
    case 'failed':
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-danger"
          title={task.failureReason ?? undefined}
        >
          <XCircle size={12} /> Failed
        </span>
      )
    case 'skipped':
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-text-muted"
          title="Skipped when the wave drained — not a decision you made"
        >
          <SkipForward size={12} /> Skipped (wave drained)
        </span>
      )
    case 'running':
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

/**
 * BlueprintExecutionPanel — collapsible right panel showing all waves, tasks,
 * plan, and completion metrics for a blueprint execution.
 *
 * Two tabs:
 *   - Tasks: all waves as accordions, task rows with status icons + expand
 *   - Plan: renders BlueprintPlanCard from stored plan artifact
 *
 * Data comes from blueprint.store (currentBlueprint.tasks for DB-backed data,
 * waveTasks for live overlay during build). Works for active + historical runs.
 */

import { useState, useCallback, useMemo, useEffect, useRef, type JSX } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Target,
  ListTodo,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  SkipForward,
  Clock,
  GripVertical,
  Copy
} from 'lucide-react'
import type {
  BlueprintTask,
  BlueprintTaskStatus,
  BlueprintPhaseType
} from '../../../../../shared/blueprint-types'
import { BlueprintPlanCard } from './BlueprintPlanCard'
import { copyTextToClipboard } from '@renderer/utils/clipboard'

// ── Marker Parsing ─────────────────────────────────────────────────────────

interface ParsedMarkers {
  clean: string
  userStory: string | null
  parallel: boolean
}

/** Strip leading [US1]/[P]/[S] markers from a task description. */
function parseTaskMarkers(description: string): ParsedMarkers {
  let userStory: string | null = null
  let parallel = false
  const clean = description
    .replace(/\[(US\d+)\]/gi, (_, us) => {
      userStory = us.toUpperCase()
      return ''
    })
    .replace(/\[P\]/gi, () => {
      parallel = true
      return ''
    })
    .replace(/\[S\]/gi, '')
    .trim()
  return { clean, userStory, parallel }
}

/** Format a duration between two timestamps as "took Xs" or "took Xm Ys". */
function formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `took ${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `took ${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

/** Split a goal condition string into individual criteria bullets. */
function splitGoalCriteria(goal: string): string[] {
  // Split on sentence boundaries ('. ' followed by uppercase or number)
  return goal
    .split(/\.\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/\.$/, '').trim())
    .filter((s) => s.length > 0)
}

// ── Status Icons ────────────────────────────────────────────────────────────

const TASK_STATUS_ICON: Record<BlueprintTaskStatus, JSX.Element> = {
  pending: <Circle size={14} className="text-text-muted" />,
  running: <Loader2 size={14} className="text-info animate-spin" />,
  complete: <CheckCircle2 size={14} className="text-success" />,
  failed: <XCircle size={14} className="text-danger" />,
  skipped: <SkipForward size={14} className="text-text-muted" />
}

// ── Task Row ────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: BlueprintTask
  liveStatus?: BlueprintTaskStatus
  goal?: string
}

function TaskRow({ task, liveStatus, goal }: TaskRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = liveStatus ?? task.status
  const { clean, userStory, parallel } = parseTaskMarkers(task.description)

  return (
    <div
      className={`border-b border-border-subtle/50 last:border-b-0 ${status === 'failed' ? 'border-l-2 border-l-danger/60' : ''}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-hover transition-colors cursor-pointer group"
      >
        <span className="mt-0.5">{TASK_STATUS_ICON[status]}</span>
        <span className="text-xs font-mono text-text-muted flex-shrink-0 mt-px">{task.taskId}</span>
        <span className="text-sm text-text-primary line-clamp-3 flex-1 min-w-0">{clean}</span>
        {/* Marker badges */}
        {userStory && (
          <span className="text-[10px] font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded flex-shrink-0">
            {userStory}
          </span>
        )}
        {parallel && (
          <span className="text-[10px] font-semibold text-info bg-info/10 px-1.5 py-0.5 rounded flex-shrink-0">
            P
          </span>
        )}
        <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-px">
          Details
        </span>
        <span className="flex-shrink-0 mt-0.5 w-5 h-5 rounded-full border border-border-subtle flex items-center justify-center group-hover:ring-1 group-hover:ring-accent/30 transition-all">
          {expanded ? (
            <ChevronDown size={12} className="text-text-muted" />
          ) : (
            <ChevronRight size={12} className="text-text-muted" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pl-8 space-y-2">
          {/* Full description (wrapped, no clamp) */}
          <p className="text-xs text-text-secondary leading-relaxed">{clean}</p>

          {/* Files */}
          {task.filePathsJson.length > 0 && (
            <div>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                Files
              </span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {task.filePathsJson.map((f) => (
                  <span
                    key={f}
                    className="group/file inline-flex items-center gap-1 text-xs font-mono text-text-secondary bg-surface-inset px-2 py-1 rounded"
                  >
                    {f}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void copyTextToClipboard(f)
                      }}
                      className="opacity-0 group-hover/file:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
                      title="Copy path"
                    >
                      <Copy size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {task.dependsOnJson.length > 0 && (
            <div>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                Depends on
              </span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {task.dependsOnJson.map((d) => (
                  <span
                    key={d}
                    className="text-[9px] font-mono text-text-secondary bg-surface-inset px-1.5 py-0.5 rounded"
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* User Story (only if it's a longer sentence, not just an ID matching the badge) */}
          {task.userStory && task.userStory.length > 6 && (
            <div>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                User Story
              </span>
              <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{task.userStory}</p>
            </div>
          )}

          {/* Goal → criteria checklist */}
          {goal &&
            (() => {
              const criteria = splitGoalCriteria(goal)
              return (
                <div>
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                    Goal criteria
                  </span>
                  {criteria.length > 1 ? (
                    <ul className="mt-0.5 space-y-0.5">
                      {criteria.map((c, i) => (
                        <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
                          <span className="text-text-muted mt-px">•</span>
                          <span className="leading-relaxed">{c}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{goal}</p>
                  )}
                </div>
              )
            })()}

          {/* Duration instead of two timestamps */}
          {task.startedAt && (
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <Clock size={12} />
              <span>
                Started{' '}
                {new Date(task.startedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit'
                })}
                {task.completedAt && ` · ${formatDuration(task.startedAt, task.completedAt)}`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Wave Accordion ──────────────────────────────────────────────────────────

interface WaveAccordionProps {
  waveNum: number
  tasks: BlueprintTask[]
  waveTasks: Record<string, BlueprintTaskStatus>
  taskGoals: Record<string, string>
  defaultOpen?: boolean
}

function WaveAccordion({
  waveNum,
  tasks,
  waveTasks,
  taskGoals,
  defaultOpen = false
}: WaveAccordionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const waveRef = useRef<HTMLDivElement>(null)

  const completedCount = tasks.filter((t) => {
    const status = waveTasks[t.taskId] ?? t.status
    return status === 'complete'
  }).length

  const hasRunning = tasks.some((t) => (waveTasks[t.taskId] ?? t.status) === 'running')
  const hasFailed = tasks.some((t) => (waveTasks[t.taskId] ?? t.status) === 'failed')
  const allComplete = completedCount === tasks.length && tasks.length > 0

  // Detect remediation wave — all tasks have R-prefixed IDs
  const isRemediation = tasks.length > 0 && tasks.every((t) => t.taskId.startsWith('R'))

  // Auto-open wave when it becomes active (has running tasks)
  useEffect(() => {
    if (hasRunning && !open) {
      setOpen(true)
      // Auto-scroll to this wave
      waveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [hasRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-collapse wave when all tasks complete (and no failures)
  useEffect(() => {
    if (allComplete && !hasFailed && open) {
      setOpen(false)
    }
  }, [allComplete, hasFailed]) // eslint-disable-line react-hooks/exhaustive-deps

  const progressColor = hasFailed
    ? 'text-danger'
    : hasRunning
      ? 'text-info'
      : allComplete
        ? 'text-success'
        : 'text-text-muted'

  return (
    <div
      ref={waveRef}
      className={`rounded-lg border overflow-hidden ${isRemediation ? 'border-warning/30' : 'border-border-subtle'}`}
    >
      {/* Sticky wave header */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay hover:bg-surface-hover/50 transition-colors sticky top-0 z-[1]"
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted" />
        ) : (
          <ChevronRight size={14} className="text-text-muted" />
        )}
        <span
          className={`text-sm font-semibold ${isRemediation ? 'text-warning' : 'text-text-primary'}`}
        >
          Wave {waveNum}
          {isRemediation && (
            <span className="text-xs font-normal ml-1.5 text-warning/70">(Remediation)</span>
          )}
        </span>
        {allComplete && <CheckCircle2 size={14} className="text-success" />}
        <span className={`text-xs font-medium ml-auto ${progressColor}`}>
          {completedCount}/{tasks.length}
        </span>
      </button>

      {/* Smooth height transition */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden bg-surface-base">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              liveStatus={waveTasks[task.taskId]}
              goal={taskGoals[task.taskId]}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Phase Completion Metrics ────────────────────────────────────────────────

function PhaseCompletionCard({
  phase,
  metrics
}: {
  phase: BlueprintPhaseType
  metrics: Record<string, unknown>
}): JSX.Element {
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
  const tasksCompleted = metrics.tasksCompleted as number | undefined
  const totalTasks = metrics.totalTasks as number | undefined
  const filesCreated = metrics.filesCreated as string[] | undefined
  const filesModified = metrics.filesModified as string[] | undefined
  const recommendation = metrics.recommendation as string | undefined

  return (
    <div className="rounded-lg border border-success/20 bg-success/5 p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={12} className="text-success" />
        <span className="text-xs font-semibold text-text-primary">{phaseLabel} Phase Complete</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        {tasksCompleted !== undefined && totalTasks !== undefined && (
          <div>
            <span className="text-text-muted">Tasks: </span>
            <span className="text-text-primary font-medium">
              {tasksCompleted}/{totalTasks}
            </span>
          </div>
        )}
        {filesCreated && filesCreated.length > 0 && (
          <div>
            <span className="text-text-muted">Created: </span>
            <span className="text-text-primary font-medium">{filesCreated.length}</span>
          </div>
        )}
        {filesModified && filesModified.length > 0 && (
          <div>
            <span className="text-text-muted">Modified: </span>
            <span className="text-text-primary font-medium">{filesModified.length}</span>
          </div>
        )}
      </div>
      {recommendation && <p className="text-[10px] text-text-secondary italic">{recommendation}</p>}
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────────

type PanelTab = 'tasks' | 'plan'

export interface BlueprintExecutionPanelProps {
  tasks: BlueprintTask[]
  waveTasks: Record<string, BlueprintTaskStatus>
  taskGoals: Record<string, string>
  currentWave: { wave: number; taskCount: number } | null
  phaseCompletions: Partial<Record<BlueprintPhaseType, Record<string, unknown>>>
  /** Plan artifact for the Plan tab (from phase artifacts contentJson) */
  planArtifact: Record<string, unknown> | null
  currentGoal: string | null
  /** Current phase — drives contextual empty state messaging */
  currentPhase: BlueprintPhaseType | null
  /** Callback when panel is resized via drag handle */
  onResize?: (width: number) => void
}

/** Phase-aware empty state message for the Tasks tab. */
const PHASE_TASK_MESSAGE: Partial<Record<BlueprintPhaseType, { title: string; subtitle: string }>> =
  {
    specify: {
      title: 'Analyzing requirements',
      subtitle: 'Tasks will be created once the spec, plan, and task breakdown phases complete.'
    },
    clarify: {
      title: 'Clarifying requirements',
      subtitle: 'Tasks will be created once the plan and task breakdown phases complete.'
    },
    plan: {
      title: 'Creating the plan',
      subtitle: 'Tasks will be created after the plan is broken down into executable work.'
    },
    tasks: {
      title: 'Breaking down tasks',
      subtitle: "Tasks are being generated now — they'll appear here momentarily."
    },
    review: {
      title: 'Reviewing the plan',
      subtitle: "Tasks have been defined — they'll load once review is complete."
    }
  }

export default function BlueprintExecutionPanel({
  tasks,
  waveTasks,
  taskGoals,
  currentWave,
  phaseCompletions,
  planArtifact,
  currentGoal,
  currentPhase,
  onResize
}: BlueprintExecutionPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<PanelTab>('tasks')
  const [goalExpanded, setGoalExpanded] = useState(false)

  // ── Resize drag handle ──
  // Track active drag listeners so we can clean up on unmount if mid-drag
  const dragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null)

  useEffect(() => {
    return () => {
      // Safety cleanup: remove drag listeners if component unmounts mid-drag
      if (dragListenersRef.current) {
        window.removeEventListener('mousemove', dragListenersRef.current.move)
        window.removeEventListener('mouseup', dragListenersRef.current.up)
        dragListenersRef.current = null
      }
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onResize) return
      e.preventDefault()
      const startX = e.clientX
      const panel = (e.target as HTMLElement).closest('[data-panel-root]') as HTMLElement | null
      const startWidth = panel?.offsetWidth ?? 320

      const onMouseMove = (ev: MouseEvent): void => {
        // Dragging left = increase width (panel is on the right)
        const delta = startX - ev.clientX
        const newWidth = Math.min(560, Math.max(280, startWidth + delta))
        onResize(newWidth)
      }
      const onMouseUp = (): void => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        dragListenersRef.current = null
      }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      dragListenersRef.current = { move: onMouseMove, up: onMouseUp }
    },
    [onResize]
  )

  // Group tasks by wave
  const tasksByWave = useMemo(() => {
    const groups = new Map<number, BlueprintTask[]>()
    for (const task of tasks) {
      const wave = task.wave
      if (!groups.has(wave)) groups.set(wave, [])
      groups.get(wave)!.push(task)
    }
    return new Map([...groups.entries()].sort(([a], [b]) => a - b))
  }, [tasks])

  const totalDone = tasks.filter((t) => {
    const status = waveTasks[t.taskId] ?? t.status
    return status === 'complete'
  }).length

  return (
    <div
      data-panel-root
      className="flex flex-col h-full min-h-0 bg-surface-base border-l border-border-subtle relative"
    >
      {/* Drag handle for resizing */}
      {onResize && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 flex items-center justify-center hover:bg-accent/20 transition-colors group"
          title="Drag to resize"
        >
          <GripVertical
            size={10}
            className="text-text-muted/0 group-hover:text-text-muted transition-colors"
          />
        </div>
      )}
      {/* Tab bar */}
      <div className="flex border-b border-border-subtle px-2 pt-2 gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab('tasks')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'tasks'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <ListTodo size={14} />
          Tasks
          {tasks.length > 0 && (
            <span className="text-[11px] font-mono text-text-muted">
              {totalDone}/{tasks.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('plan')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'plan'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <FileText size={14} />
          Plan
        </button>
      </div>

      {/* Current goal strip (click to expand) */}
      {currentGoal && (
        <button
          type="button"
          onClick={() => setGoalExpanded(!goalExpanded)}
          className="w-full px-3 py-2 border-b border-border-subtle flex items-start gap-2 flex-shrink-0 text-left hover:bg-surface-hover/30 transition-colors"
        >
          <Target size={12} className="text-accent mt-0.5 flex-shrink-0" />
          <p
            className={`text-xs text-text-secondary leading-relaxed ${goalExpanded ? '' : 'line-clamp-2'}`}
          >
            {currentGoal}
          </p>
        </button>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
        {activeTab === 'tasks' && (
          <>
            {/* Phase completion metrics (top of tasks tab) */}
            {Object.entries(phaseCompletions).map(([phase, metrics]) => (
              <PhaseCompletionCard
                key={phase}
                phase={phase as BlueprintPhaseType}
                metrics={metrics}
              />
            ))}

            {/* Wave accordions */}
            {tasks.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 rounded-full bg-surface-inset mx-auto mb-3 flex items-center justify-center">
                  <ListTodo size={20} className="text-text-muted" />
                </div>
                {(() => {
                  const msg = currentPhase ? PHASE_TASK_MESSAGE[currentPhase] : null
                  return (
                    <>
                      <p className="text-sm font-medium text-text-secondary mb-1">
                        {msg?.title ?? 'No tasks yet'}
                      </p>
                      <p className="text-xs text-text-muted max-w-[220px] mx-auto">
                        {msg?.subtitle ?? 'Tasks will appear here during the build phase.'}
                      </p>
                    </>
                  )
                })()}
              </div>
            ) : (
              [...tasksByWave.entries()].map(([waveNum, waveTasks_]) => (
                <WaveAccordion
                  key={waveNum}
                  waveNum={waveNum}
                  tasks={waveTasks_}
                  waveTasks={waveTasks}
                  taskGoals={taskGoals}
                  defaultOpen={currentWave?.wave === waveNum}
                />
              ))
            )}

            {/* Status legend */}
            {tasks.length > 0 && (
              <div className="flex items-center gap-3 pt-2 border-t border-border-subtle/50">
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <Loader2 size={12} className="animate-spin text-info" /> running
                </span>
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <CheckCircle2 size={12} className="text-success" /> complete
                </span>
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <XCircle size={12} className="text-danger" /> failed
                </span>
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <SkipForward size={12} /> skipped
                </span>
              </div>
            )}
          </>
        )}

        {activeTab === 'plan' && (
          <>
            {planArtifact ? (
              <BlueprintPlanCard plan={planArtifact} />
            ) : (
              <div className="text-center py-8">
                <FileText size={24} className="text-text-muted mx-auto mb-2" />
                <p className="text-xs text-text-muted">
                  Plan will appear here after the plan phase
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

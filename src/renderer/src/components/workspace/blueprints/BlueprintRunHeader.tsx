/**
 * BlueprintRunHeader — redesigned run header with stepper, progress, and task info.
 *
 * Row 1: Status dot · phase chip · title · 7-step mini stepper · elapsed · panel toggle · stop
 * Row 2 (build/verify): Progress bar + percentage · tasks chip · wave chip · current task
 * Row 2 (other phases): Goal label + goal text
 */

import { useState, useEffect, type JSX } from 'react'
import {
  StopCircle,
  Clock,
  Layers,
  ListTodo,
  Loader2,
  Target,
  Wrench,
  Zap,
  ClipboardList
} from 'lucide-react'
import { PHASE_ICONS, type PhaseIconKey } from './phase-icons'
import { formatPhaseDuration } from '@renderer/store/blueprint.store'
import type { BlueprintPhaseType } from '../../../../../shared/blueprint-types'

// ── Phase order for step counter ──

const PHASE_ORDER: PhaseIconKey[] = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify']

function getPhaseIndex(phase: BlueprintPhaseType | null): number {
  if (!phase) return -1
  return PHASE_ORDER.indexOf(phase as PhaseIconKey)
}

// ── Strip task markers ──

function stripTaskMarkers(description: string): string {
  return description.replace(/^(\s*\[(?:US\d+|P|S)\]\s*)+/i, '').trim()
}

// ── PhaseElapsed — live-ticking per-phase elapsed ──

function PhaseElapsed({ startedAt, ticking }: { startedAt: number; ticking: boolean }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!ticking) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [ticking])
  return <>{formatPhaseDuration(ticking ? now - startedAt : Date.now() - startedAt)}</>
}

// ── Props ──

export interface BlueprintRunHeaderProps {
  isRunning: boolean
  currentPhase: BlueprintPhaseType | null
  blueprintTitle: string | null
  pipelineStartedAt: number | null
  phaseDurations: Partial<Record<BlueprintPhaseType, number>>
  phaseStartedAt: number | null
  pendingApproval: boolean
  // Task progress
  tasksDone: number
  taskTotal: number
  totalWaves: number
  currentWave: { wave: number; taskCount: number } | null
  runningTasks: Record<string, { taskId: string; description: string }>
  currentGoal: string | null
  // Panel
  panelOpen: boolean
  onTogglePanel: () => void
  // Actions
  onCancel: () => void
  // Tab bar
  activeTab: 'execution' | 'deliverables'
  onTabChange: (tab: 'execution' | 'deliverables') => void
  hasCompletedPhases: boolean
}

export function BlueprintRunHeader({
  isRunning,
  currentPhase,
  blueprintTitle,
  pipelineStartedAt,
  phaseDurations: _phaseDurations,
  phaseStartedAt,
  pendingApproval,
  tasksDone,
  taskTotal,
  totalWaves,
  currentWave,
  runningTasks,
  currentGoal,
  panelOpen,
  onTogglePanel,
  onCancel,
  activeTab,
  onTabChange,
  hasCompletedPhases
}: BlueprintRunHeaderProps): JSX.Element {
  // Live-ticking total elapsed
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isRunning])
  const totalElapsed = pipelineStartedAt ? now - pipelineStartedAt : null

  // Phase chip
  const phaseConfig = currentPhase ? PHASE_ICONS[currentPhase as PhaseIconKey] : null
  const PhaseIcon = phaseConfig?.icon
  const phaseIdx = getPhaseIndex(currentPhase)

  // Status
  const statusDotClass = pendingApproval
    ? 'bg-info animate-pulse'
    : isRunning
      ? 'bg-success animate-pulse'
      : 'bg-text-muted'

  // Progress
  const progressPct = taskTotal > 0 ? Math.min(100, Math.round((tasksDone / taskTotal) * 100)) : 0
  const showProgress = (currentPhase === 'build' || currentPhase === 'verify') && taskTotal > 0

  // Goal expand
  const [goalExpanded, setGoalExpanded] = useState(false)

  return (
    <div className="space-y-0">
      {/* ── Row 1: Status + Phase + Title + Stepper + Controls ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-raised rounded-t-xl border border-border-subtle">
        {/* Status dot in ring */}
        <div className="relative flex-shrink-0">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusDotClass}`} />
          {isRunning && (
            <span className={`absolute inset-[-2px] rounded-full border-2 border-success/30 animate-ping`} />
          )}
        </div>

        {/* Phase chip — merged with step counter + per-phase elapsed */}
        {phaseConfig && PhaseIcon && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md bg-accent/15 text-accent">
            <PhaseIcon size={14} />
            {phaseConfig.label}
            <span className="text-accent/70 font-mono text-[11px]">
              {phaseIdx + 1}/{PHASE_ORDER.length}
            </span>
            {phaseStartedAt && (
              <>
                <span className="text-accent/40">·</span>
                <span className="font-mono text-[11px] text-accent/70 tabular-nums">
                  <PhaseElapsed startedAt={phaseStartedAt} ticking={isRunning} />
                </span>
              </>
            )}
          </span>
        )}

        {/* Title */}
        {blueprintTitle && (
          <span className="text-lg font-display text-text-primary truncate flex-1 min-w-0">
            {blueprintTitle}
          </span>
        )}

        {/* Total Elapsed */}
        {totalElapsed !== null && (
          <span className="flex items-center gap-1 text-sm text-text-muted tabular-nums flex-shrink-0">
            <Clock size={12} />
            {formatPhaseDuration(totalElapsed)}
          </span>
        )}

        {/* Panel toggle (hidden on deliverables tab) */}
        {activeTab === 'execution' && (
          <button
            type="button"
            onClick={onTogglePanel}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              panelOpen
                ? 'bg-accent/15 text-accent border-accent/30'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover border-border-subtle'
            }`}
            title={panelOpen ? 'Hide execution panel' : 'Show execution panel'}
          >
            <Layers size={14} />
            Tasks
            {taskTotal > 0 && (
              <span className="text-[10px] font-mono bg-surface-inset px-1 py-0.5 rounded">
                {tasksDone}/{taskTotal}
              </span>
            )}
          </button>
        )}

        {/* Stop button */}
        {isRunning && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded-lg transition-colors"
          >
            <StopCircle size={14} />
            Stop
          </button>
        )}
      </div>

      {/* ── Row 2: View toggle tabs (show after first phase completes) ── */}
      {hasCompletedPhases && (
        <div
          className="flex items-center gap-1 px-4 py-2 bg-surface-raised border-x border-border-subtle"
          role="tablist"
          aria-label="Blueprint view"
        >
          <button
            type="button"
            onClick={() => onTabChange('execution')}
            className={`
              inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 outline-none
              ${activeTab === 'execution'
                ? 'bg-surface-overlay text-text-primary shadow-sm border border-border-default'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50'
              }
            `}
            role="tab"
            aria-selected={activeTab === 'execution'}
          >
            <Zap size={14} />
            Live Execution
          </button>
          <button
            type="button"
            onClick={() => onTabChange('deliverables')}
            className={`
              inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 outline-none
              ${activeTab === 'deliverables'
                ? 'bg-surface-overlay text-text-primary shadow-sm border border-border-default'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50'
              }
            `}
            role="tab"
            aria-selected={activeTab === 'deliverables'}
          >
            <ClipboardList size={14} />
            Phase Deliverables
          </button>
        </div>
      )}

      {/* ── Row 3: Progress bar (build/verify) or Goal (other phases) ── */}
      {showProgress ? (
        <div className="flex items-center gap-3 px-4 py-2 bg-surface-raised border-x border-b border-border-subtle rounded-b-xl">
          {/* Full-width progress bar */}
          <div className="flex-1 h-2 bg-surface-inset rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-success rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-xs font-mono text-text-muted tabular-nums flex-shrink-0">{progressPct}%</span>

          {/* Tasks chip */}
          <span className="inline-flex items-center gap-1 text-xs text-text-secondary bg-surface-inset px-2 py-0.5 rounded-md flex-shrink-0">
            <ListTodo size={12} />
            {tasksDone}/{taskTotal} tasks
          </span>

          {/* Wave chip */}
          {currentWave && (
            <span className="inline-flex items-center gap-1 text-xs text-text-secondary bg-surface-inset px-2 py-0.5 rounded-md flex-shrink-0">
              <Layers size={12} />
              Wave {currentWave.wave}{totalWaves > 0 ? `/${totalWaves}` : ''}
              {currentPhase === 'verify' && tasksDone === taskTotal && ' ✓'}
            </span>
          )}

          {/* Running task chips — shows active parallel tasks */}
          {Object.keys(runningTasks).length > 0 && currentPhase === 'build' && (
            Object.keys(runningTasks).length === 1 ? (() => {
              const task = Object.values(runningTasks)[0]
              return (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-md flex-1 min-w-0 truncate text-info bg-info/10"
                  title={`${task.taskId} · ${stripTaskMarkers(task.description)}`}
                >
                  {task.taskId.startsWith('R') ? (
                    <Wrench size={12} className="flex-shrink-0" />
                  ) : (
                    <Loader2 size={12} className="animate-spin flex-shrink-0" />
                  )}
                  {task.taskId.startsWith('R') && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider flex-shrink-0">Remediation</span>
                  )}
                  {task.taskId} · {stripTaskMarkers(task.description)}
                </span>
              )
            })() : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-md text-info bg-info/10">
                <Loader2 size={12} className="animate-spin flex-shrink-0" />
                {Object.keys(runningTasks).length} tasks running
              </span>
            )
          )}
        </div>
      ) : currentGoal && isRunning ? (
        <button
          type="button"
          onClick={() => setGoalExpanded(!goalExpanded)}
          className="w-full flex items-center gap-2 px-4 py-2 bg-surface-raised border-x border-b border-border-subtle rounded-b-xl text-left hover:bg-surface-hover/30 transition-colors"
        >
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-accent uppercase tracking-wider flex-shrink-0">
            <Target size={10} />
            Goal
          </span>
          <p className={`text-xs text-text-secondary flex-1 min-w-0 ${goalExpanded ? '' : 'line-clamp-1'}`}>
            {currentGoal}
          </p>
        </button>
      ) : (
        /* Empty bottom border to close the rounded container */
        <div className="h-0 bg-surface-raised border-x border-b border-border-subtle rounded-b-xl" />
      )}
    </div>
  )
}

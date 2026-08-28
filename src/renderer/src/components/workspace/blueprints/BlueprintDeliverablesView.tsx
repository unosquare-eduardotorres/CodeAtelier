/**
 * BlueprintDeliverablesView — full-width phase-by-phase deliverable viewer.
 *
 * Replaces the 3-column execution grid with a phase selector + structured
 * visual summary of what each completed phase produced. All data comes from
 * artifactsJson — never raw JSON.
 */

import { useState, useEffect, useMemo, type JSX } from 'react'
import {
  Layers,
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  SkipForward,
  AlertTriangle
} from 'lucide-react'
import type {
  BlueprintWithDetails,
  BlueprintPhase,
  BlueprintPhaseType
} from '../../../../../shared/blueprint-types'
import { PHASE_ICONS, type PhaseIconKey } from './phase-icons'
import { SpecifyDeliverable } from './deliverables/SpecifyDeliverable'
import { ClarifyDeliverable } from './deliverables/ClarifyDeliverable'
import { PlanDeliverable } from './deliverables/PlanDeliverable'
import { TasksDeliverable } from './deliverables/TasksDeliverable'
import { ReviewDeliverable } from './deliverables/ReviewDeliverable'
import { BuildDeliverable } from './deliverables/BuildDeliverable'
import { CodeReviewDeliverable } from './deliverables/CodeReviewDeliverable'
import { VerifyDeliverable } from './deliverables/VerifyDeliverable'

// ── Props ──

export interface BlueprintDeliverablesViewProps {
  blueprint: BlueprintWithDetails | null
  phaseDurations: Partial<Record<BlueprintPhaseType, number>>
  clarifyAwaitingInput: boolean
  clarifyQuestions: boolean
  pendingApproval: boolean
  onSwitchToExecution: () => void
}

// ── Phase Selector Pill ──

function PhaseSelector({
  phase,
  isSelected,
  onClick
}: {
  phase: BlueprintPhase
  isSelected: boolean
  onClick: () => void
}): JSX.Element {
  const config = PHASE_ICONS[phase.phase as PhaseIconKey]
  if (!config) return <></>
  const Icon = config.icon
  const isComplete = phase.status === 'complete'
  const isActive = phase.status === 'active'
  const isPending = phase.status === 'pending'
  const isFailed = phase.status === 'failed'
  const isSkipped = phase.status === 'skipped'

  const canSelect = isComplete || isFailed

  return (
    <button
      type="button"
      onClick={canSelect ? onClick : undefined}
      disabled={!canSelect}
      className={`
        inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
        focus-visible:ring-2 focus-visible:ring-primary/50 outline-none
        ${isSelected ? 'bg-surface-overlay text-text-primary shadow-sm border border-border-default' : ''}
        ${!isSelected && isComplete ? 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50 cursor-pointer' : ''}
        ${!isSelected && isFailed ? 'text-danger/80 hover:text-danger hover:bg-danger/5 cursor-pointer' : ''}
        ${isPending || isSkipped ? 'text-text-muted opacity-50 cursor-default' : ''}
        ${isActive ? 'text-accent opacity-70 cursor-default' : ''}
      `}
      role="tab"
      aria-selected={isSelected}
    >
      {isComplete && <CheckCircle2 size={14} className="text-success" />}
      {isFailed && <XCircle size={14} className="text-danger" />}
      {isActive && <Loader2 size={14} className="animate-spin text-accent" />}
      {isPending && <Circle size={14} className="text-text-muted" />}
      {isSkipped && <SkipForward size={14} className="text-text-muted" />}
      <Icon size={14} />
      {config.label}
    </button>
  )
}

// ── Interaction Banner ──

function InteractionBanner({
  type,
  onSwitch
}: {
  type: 'clarify' | 'approval'
  onSwitch: () => void
}): JSX.Element {
  return (
    <div className="mx-6 mt-4 flex items-center gap-3 px-4 py-3 rounded-xl border border-info/30 bg-info/5">
      <AlertTriangle size={16} className="text-info flex-shrink-0" />
      <span className="text-sm text-text-secondary flex-1">
        {type === 'clarify'
          ? 'The Clarify phase needs your input to continue.'
          : 'Review complete — your approval is needed to proceed to Build.'}
      </span>
      <button
        type="button"
        onClick={onSwitch}
        className="px-3 py-1.5 text-xs font-medium bg-info/15 text-info rounded-lg hover:bg-info/25 transition-colors"
      >
        Switch to Live Execution
      </button>
    </div>
  )
}

// ── Empty State ──

function EmptyDeliverableState({ currentPhase }: { currentPhase: string | null }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Layers size={32} className="text-text-muted mb-4" />
      <h3 className="text-sm font-semibold text-text-primary mb-1">No deliverables yet</h3>
      <p className="text-xs text-text-secondary max-w-sm">
        {currentPhase
          ? `The ${currentPhase} phase is currently running. Deliverables will appear here as each phase completes.`
          : 'Start a blueprint to see phase deliverables.'}
      </p>
    </div>
  )
}

// ── Phase Content Router ──

function PhaseDeliverableContent({
  phase,
  blueprint,
  phaseDurations
}: {
  phase: BlueprintPhase
  blueprint: BlueprintWithDetails
  phaseDurations: Partial<Record<BlueprintPhaseType, number>>
}): JSX.Element {
  const storeDuration = phaseDurations[phase.phase as BlueprintPhaseType]
  const duration =
    storeDuration ??
    (phase.startedAt && phase.completedAt
      ? Math.max(0, new Date(phase.completedAt).getTime() - new Date(phase.startedAt).getTime())
      : null)

  switch (phase.phase) {
    case 'specify':
      return <SpecifyDeliverable phase={phase} duration={duration} />
    case 'clarify':
      return <ClarifyDeliverable phase={phase} duration={duration} />
    case 'plan':
      return <PlanDeliverable phase={phase} duration={duration} />
    case 'tasks':
      return <TasksDeliverable phase={phase} duration={duration} tasks={blueprint.tasks} />
    case 'review':
      return <ReviewDeliverable phase={phase} duration={duration} />
    case 'build':
      return <BuildDeliverable phase={phase} duration={duration} tasks={blueprint.tasks} />
    case 'code-review':
      return (
        <CodeReviewDeliverable phase={phase} duration={duration} tasks={blueprint.tasks} />
      )
    case 'verify':
      return <VerifyDeliverable phase={phase} duration={duration} />
    default:
      return <p className="text-xs text-text-muted italic">No renderer for phase: {phase.phase}</p>
  }
}

// ── Main Component ──

export function BlueprintDeliverablesView({
  blueprint,
  phaseDurations,
  clarifyAwaitingInput,
  clarifyQuestions,
  pendingApproval,
  onSwitchToExecution
}: BlueprintDeliverablesViewProps): JSX.Element {
  const phases = blueprint?.phases ?? []

  // Auto-select last completed phase
  const lastCompleted = useMemo(
    () => [...phases].reverse().find((p) => p.status === 'complete' || p.status === 'failed'),
    [phases]
  )

  const [selectedPhase, setSelectedPhase] = useState<string | null>(lastCompleted?.phase ?? null)

  // Track the last-completed phase key so we can auto-advance the selector
  const lastCompletedPhase = lastCompleted?.phase ?? null
  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync: auto-select newly completed phase */
  useEffect(() => {
    if (lastCompletedPhase) {
      setSelectedPhase(lastCompletedPhase)
    }
  }, [lastCompletedPhase])
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedPhaseData = phases.find((p) => p.phase === selectedPhase) ?? null
  const currentPhase = phases.find((p) => p.status === 'active')?.phase ?? null

  // Does the pipeline need user input?
  const needsInput = clarifyAwaitingInput || clarifyQuestions || pendingApproval
  const bannerType = clarifyAwaitingInput || clarifyQuestions ? 'clarify' : 'approval'

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
      {/* Notification banners */}
      {needsInput && <InteractionBanner type={bannerType} onSwitch={onSwitchToExecution} />}

      {/* Phase selector — horizontal pill bar */}
      <div className="sticky top-0 z-10 bg-surface-raised/95 backdrop-blur-sm border-b border-border-subtle px-6 py-3">
        <div
          className="flex items-center gap-2 flex-wrap max-w-7xl mx-auto"
          role="tablist"
          aria-label="Phase deliverables"
        >
          {phases.map((phase) => (
            <PhaseSelector
              key={phase.phase}
              phase={phase}
              isSelected={selectedPhase === phase.phase}
              onClick={() => setSelectedPhase(phase.phase)}
            />
          ))}
        </div>
      </div>

      {/* Phase content — full width, scrollable */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-7xl mx-auto w-full">
          {selectedPhaseData && blueprint ? (
            <PhaseDeliverableContent
              phase={selectedPhaseData}
              blueprint={blueprint}
              phaseDurations={phaseDurations}
            />
          ) : (
            <EmptyDeliverableState currentPhase={currentPhase} />
          )}
        </div>
      </div>
    </div>
  )
}

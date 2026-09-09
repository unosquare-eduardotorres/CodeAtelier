/**
 * PhaseEvidence — the detail view's phase navigation.
 *
 * Replaces the PhaseJourney accordion: the same pill-bar grammar the live
 * execution view uses (one navigation model instead of two), routing through
 * the shared PhaseDeliverableRouter so every phase — including code-review —
 * renders rich in both views. The failed phase auto-selects on a failed run;
 * otherwise the last completed phase does.
 *
 * Rows carry the one-line summary from phase-summaries as the pill title so
 * the accordion's information isn't lost.
 */

import { useState, useMemo, type JSX } from 'react'
import { CheckCircle2, XCircle, Loader2, Circle, SkipForward } from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS, type PhaseIconKey } from '../phase-icons'
import { getPhaseSummary } from './phase-summaries'
import { PhaseDeliverableRouter } from '../deliverables/PhaseDeliverableRouter'

function PhasePill({
  phase,
  tasks,
  isSelected,
  onClick
}: {
  phase: BlueprintPhase
  tasks: BlueprintTask[]
  isSelected: boolean
  onClick: () => void
}): JSX.Element | null {
  const config = PHASE_ICONS[phase.phase as PhaseIconKey]
  if (!config) return null
  const Icon = config.icon
  const { summary } = getPhaseSummary(phase, tasks)

  const canSelect = phase.status === 'complete' || phase.status === 'failed' || phase.status === 'active'

  return (
    <button
      type="button"
      onClick={canSelect ? onClick : undefined}
      disabled={!canSelect}
      title={`${config.label}${summary ? ` — ${summary}` : ''}`}
      className={`
        inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
        focus-visible:ring-2 focus-visible:ring-primary/50 outline-none
        ${isSelected ? 'bg-surface-overlay text-text-primary shadow-sm border border-border-default' : ''}
        ${!isSelected && phase.status === 'complete' ? 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50 cursor-pointer' : ''}
        ${!isSelected && phase.status === 'failed' ? 'text-danger/80 hover:text-danger hover:bg-danger/5 cursor-pointer' : ''}
        ${phase.status === 'pending' || phase.status === 'skipped' ? 'text-text-muted opacity-50 cursor-default' : ''}
        ${phase.status === 'active' ? 'text-accent opacity-70 cursor-default' : ''}
      `}
      role="tab"
      aria-selected={isSelected}
    >
      {phase.status === 'complete' && <CheckCircle2 size={14} className="text-success" />}
      {phase.status === 'failed' && <XCircle size={14} className="text-danger" />}
      {phase.status === 'active' && <Loader2 size={14} className="animate-spin text-accent" />}
      {phase.status === 'pending' && <Circle size={14} className="text-text-muted" />}
      {phase.status === 'skipped' && <SkipForward size={14} className="text-text-muted" />}
      <Icon size={14} />
      {config.label}
    </button>
  )
}

export function PhaseEvidence({
  phases,
  tasks,
  blueprintId
}: {
  phases: BlueprintPhase[]
  tasks: BlueprintTask[]
  blueprintId?: string
}): JSX.Element {
  const initial = useMemo(() => {
    const failed = phases.find((p) => p.status === 'failed')
    if (failed) return failed.phase
    const lastDone = [...phases].reverse().find((p) => p.status === 'complete')
    return lastDone?.phase ?? phases.find((p) => p.status === 'active')?.phase ?? null
  }, [phases])

  const [selected, setSelected] = useState<string | null>(initial)
  const selectedPhase = phases.find((p) => p.phase === selected) ?? null

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
      <div
        className="flex items-center gap-2 flex-wrap px-4 py-3 border-b border-border-subtle"
        role="tablist"
        aria-label="Phase evidence"
      >
        {phases.map((phase) => (
          <PhasePill
            key={phase.phase}
            phase={phase}
            tasks={tasks}
            isSelected={selected === phase.phase}
            onClick={() => setSelected(phase.phase)}
          />
        ))}
      </div>
      <div className="px-4 py-4">
        {selectedPhase ? (
          <PhaseDeliverableRouter
            phase={selectedPhase}
            tasks={tasks}
            blueprintId={blueprintId}
            duration={
              selectedPhase.startedAt && selectedPhase.completedAt
                ? Math.max(
                    0,
                    new Date(selectedPhase.completedAt).getTime() -
                      new Date(selectedPhase.startedAt).getTime()
                  )
                : null
            }
            readOnly
          />
        ) : (
          <p className="text-xs text-text-muted italic py-6 text-center">
            No phase evidence yet.
          </p>
        )}
      </div>
    </div>
  )
}

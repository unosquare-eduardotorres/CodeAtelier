/**
 * PhaseJourney — accordion list of phase cards replacing the flat
 * "Phases" + "Tasks" sections in the old detail view.
 *
 * Each row shows: phase number ① → ⑦, icon, label, status icon,
 * duration, and one-line summary. Clicking expands the per-phase
 * content rendered by PhaseJourneyItem.
 *
 * State handling:
 *   - Completed: green check, duration shown, expandable
 *   - Active: pulsing icon, auto-expanded
 *   - Failed: red row, auto-expanded
 *   - Pending: dimmed row, no chevron, "—" duration
 *   - Skipped: dimmed, "Skipped" label
 */

import { useState, useEffect, type JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  Loader2,
  SkipForward
} from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { PHASE_CONFIG } from '../phase-config'
import type { BlueprintPhaseType } from '../../../../../../shared/blueprint-types'
import { getPhaseSummary } from './phase-summaries'
import { PhaseJourneyItemContent } from './PhaseJourneyItem'

// ── Phase number circled digits ──

const PHASE_NUMBERS: Record<string, string> = {
  specify: '①',
  clarify: '②',
  plan: '③',
  tasks: '④',
  review: '⑤',
  build: '⑥',
  verify: '⑦'
}

// ── Status icon per phase status ──

function PhaseStatusIcon({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'complete':
      return <CheckCircle2 size={16} className="text-success flex-shrink-0" />
    case 'failed':
      return <XCircle size={16} className="text-danger flex-shrink-0" />
    case 'active':
      return <Loader2 size={16} className="text-info animate-spin flex-shrink-0" />
    case 'skipped':
      return <SkipForward size={14} className="text-text-muted flex-shrink-0" />
    default:
      return <div className="w-4 h-4 rounded-full border border-border-subtle flex-shrink-0" />
  }
}

// ── Main Component ──

interface PhaseJourneyProps {
  phases: BlueprintPhase[]
  tasks: BlueprintTask[]
  /** Auto-expand active/failed phases on mount */
  autoExpandActive?: boolean
}

export function PhaseJourney({ phases, tasks, autoExpandActive = true }: PhaseJourneyProps): JSX.Element {
  // Track which phases are expanded — auto-expand active + failed
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    if (autoExpandActive) {
      for (const p of phases) {
        if (p.status === 'active' || p.status === 'failed') {
          initial.add(p.id)
        }
      }
    }
    return initial
  })

  // Auto-expand newly active/failed phases
  useEffect(() => {
    if (!autoExpandActive) return
    setExpandedSet((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const p of phases) {
        if ((p.status === 'active' || p.status === 'failed') && !next.has(p.id)) {
          next.add(p.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [phases, autoExpandActive])

  const togglePhase = (phaseId: string): void => {
    setExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(phaseId)) next.delete(phaseId)
      else next.add(phaseId)
      return next
    })
  }

  return (
    <div className="space-y-1.5">
      <h5 className="text-xs font-medium text-text-secondary mb-2">Phase Journey</h5>
      {phases.map((phase) => {
        const config = PHASE_CONFIG[phase.phase as BlueprintPhaseType]
        const isExpandable = phase.status === 'complete' || phase.status === 'failed' || phase.status === 'active'
        const isExpanded = expandedSet.has(phase.id)
        const isPending = phase.status === 'pending'
        const { summary, duration } = getPhaseSummary(phase, tasks)
        const phaseNum = PHASE_NUMBERS[phase.phase] ?? ''

        return (
          <div
            key={phase.id}
            className={`rounded-lg border overflow-hidden transition-colors ${
              phase.status === 'failed'
                ? 'border-danger/30 bg-danger/5'
                : phase.status === 'active'
                ? 'border-info/30 bg-info/5'
                : 'border-border-subtle bg-surface-base'
            } ${isPending ? 'opacity-50' : ''}`}
          >
            {/* Row header */}
            <button
              type="button"
              onClick={isExpandable ? () => togglePhase(phase.id) : undefined}
              disabled={!isExpandable}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                isExpandable ? 'hover:bg-surface-hover cursor-pointer' : 'cursor-default'
              }`}
            >
              {/* Expand chevron (only for expandable) */}
              {isExpandable ? (
                <ChevronDown
                  size={14}
                  className={`text-text-muted flex-shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                />
              ) : (
                <div className="w-3.5 flex-shrink-0" />
              )}

              {/* Phase number */}
              <span className="text-sm flex-shrink-0 text-text-muted">{phaseNum}</span>

              {/* Phase icon + label */}
              {config && (() => {
                const PhaseIcon = config.icon
                return (
                  <PhaseIcon
                    size={14}
                    className={`${isPending ? 'text-text-muted' : config.color} flex-shrink-0 ${
                      phase.status === 'active' ? 'animate-pulse' : ''
                    }`}
                  />
                )
              })()}
              <span className="text-xs font-medium text-text-primary flex-shrink-0">
                {config?.label ?? phase.phase}
              </span>

              {/* Status icon */}
              <PhaseStatusIcon status={phase.status} />

              {/* Duration */}
              <span className="text-[10px] text-text-muted flex-shrink-0 font-mono">
                {duration ?? '—'}
              </span>

              {/* One-line summary (pushed right) */}
              <span className="text-xs text-text-secondary truncate ml-auto">
                {summary}
              </span>
            </button>

            {/* Expanded content */}
            {isExpanded && isExpandable && (
              <div className="border-t border-border-subtle px-4 py-3">
                <PhaseJourneyItemContent phase={phase} tasks={tasks} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

import { useState, useEffect, type JSX } from 'react'
import { CheckCircle, Circle, Loader2, XCircle, MinusCircle } from 'lucide-react'
import type {
  BlueprintPhaseType,
  BlueprintPhaseStatus
} from '../../../../../shared/blueprint-types'
import { BLUEPRINT_PHASE_ORDER } from '../../../../../shared/blueprint-types'
import { PHASE_ICONS, GATE_ICON, type PhaseIconKey } from './phase-icons'
import { formatPhaseDuration } from '@renderer/store/blueprint.store'

type TimelineStatus = BlueprintPhaseStatus | 'gate'

interface BlueprintPhaseTimelineProps {
  currentPhase: BlueprintPhaseType | null
  awaitingApproval: boolean
  phaseStatuses?: Partial<Record<BlueprintPhaseType, BlueprintPhaseStatus>>
  phaseDurations?: Partial<Record<BlueprintPhaseType, number>>
  /** Timestamp (Date.now()) when the current phase started — for live ticking */
  phaseStartedAt?: number | null
}

function StatusIcon({ status }: { status: TimelineStatus }): JSX.Element {
  switch (status) {
    case 'active':
      return <Loader2 size={16} className="text-accent animate-spin" />
    case 'complete':
      return <CheckCircle size={16} className="text-success" />
    case 'failed':
      return <XCircle size={16} className="text-danger" />
    case 'gate':
      return <GATE_ICON.icon size={16} className="text-info" />
    case 'skipped':
      return <MinusCircle size={16} className="text-text-muted" />
    default:
      return <Circle size={16} className="text-border-subtle" />
  }
}

function derivePhaseStatus(
  phase: BlueprintPhaseType,
  currentPhase: BlueprintPhaseType | null,
  phaseStatuses?: Partial<Record<BlueprintPhaseType, BlueprintPhaseStatus>>
): TimelineStatus {
  // If we have explicit status info, use it
  if (phaseStatuses?.[phase]) {
    return phaseStatuses[phase]!
  }

  // Derive from current phase position
  if (!currentPhase) return 'pending'

  const currentIdx = BLUEPRINT_PHASE_ORDER.indexOf(currentPhase)
  const phaseIdx = BLUEPRINT_PHASE_ORDER.indexOf(phase)

  if (phaseIdx < currentIdx) return 'complete'
  if (phaseIdx === currentIdx) return 'active'
  return 'pending'
}

export default function BlueprintPhaseTimeline({
  currentPhase,
  awaitingApproval,
  phaseStatuses,
  phaseDurations,
  phaseStartedAt
}: BlueprintPhaseTimelineProps): JSX.Element {
  // Live ticking elapsed for active phase
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!currentPhase || !phaseStartedAt) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [currentPhase, phaseStartedAt])

  // Build timeline entries including user gate after review
  const entries: Array<{
    phaseType: BlueprintPhaseType
    status: TimelineStatus
    isGate: boolean
  }> = []

  for (const phase of BLUEPRINT_PHASE_ORDER) {
    const status = derivePhaseStatus(phase, currentPhase, phaseStatuses)
    entries.push({ phaseType: phase, status, isGate: false })

    // Insert user gate after review phase
    if (phase === 'review' && (status === 'complete' || awaitingApproval)) {
      entries.push({
        phaseType: 'review',
        status: awaitingApproval ? 'gate' : 'complete',
        isGate: true
      })
    }
  }

  return (
    <div data-testid="blueprint-phase-timeline" className="space-y-0.5">
      <h4 className="text-xs font-medium text-text-secondary mb-2">Pipeline</h4>
      <div className="relative">
        {entries.map((entry, idx) => {
          const config = PHASE_ICONS[entry.phaseType as PhaseIconKey]
          const gateConfig = GATE_ICON
          const isCurrent =
            entry.phaseType === currentPhase && entry.status === 'active' && !entry.isGate
          const isActive = entry.status === 'active'
          const label = entry.isGate ? gateConfig.label : config.label
          const description = entry.isGate ? gateConfig.description : config.description

          // Duration: completed phases show recorded duration; active phase shows live ticking
          const duration = phaseDurations?.[entry.phaseType]
          const liveElapsed = isCurrent && phaseStartedAt ? now - phaseStartedAt : null
          const durationText = duration
            ? formatPhaseDuration(duration)
            : liveElapsed !== null
              ? formatPhaseDuration(liveElapsed)
              : null

          return (
            <div
              key={`${entry.phaseType}-${entry.isGate ? 'gate' : 'phase'}`}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors ${
                isCurrent
                  ? 'bg-accent-muted border-l-2 border-accent'
                  : entry.isGate && entry.status === 'gate'
                    ? 'border-l-2 border-info/30 bg-info-muted/30'
                    : ''
              }`}
              title={description}
            >
              {/* Status icon */}
              <StatusIcon status={entry.status} />

              {/* Label */}
              <span
                className={`text-sm font-medium flex-1 ${
                  isActive || isCurrent ? 'text-text-primary' : 'text-text-secondary'
                }`}
              >
                {label}
              </span>

              {/* Duration */}
              {durationText && (
                <span className="text-[10px] text-text-muted tabular-nums whitespace-nowrap">
                  {durationText}
                </span>
              )}

              {/* Connector line between items */}
              {idx < entries.length - 1 && (
                <div
                  className="absolute left-[19px] w-px h-1.5 bg-border-subtle"
                  style={{ marginTop: '28px' }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

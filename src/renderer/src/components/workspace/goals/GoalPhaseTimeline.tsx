import { CheckCircle, Circle, Loader2, User, XCircle } from 'lucide-react'
import type { MpaPhaseType, MpaPhaseStatus } from '../../../../../shared/mpa-types'
import { PHASE_CONFIG } from './constants'

interface PhaseEntry {
  phaseType: MpaPhaseType
  status: MpaPhaseStatus | 'gate'
  iteration: number
}

interface GoalPhaseTimelineProps {
  phases: PhaseEntry[]
  currentPhaseType: MpaPhaseType | null
  awaitingApproval: boolean
}

function StatusIcon({ status }: { status: MpaPhaseStatus | 'gate' }): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={16} className="text-accent animate-spin" />
    case 'completed':
      return <CheckCircle size={16} className="text-success" />
    case 'failed':
      return <XCircle size={16} className="text-danger" />
    case 'gate':
      return <User size={16} className="text-cyan-400" />
    case 'skipped':
      return <Circle size={16} className="text-text-muted" />
    default:
      return <Circle size={16} className="text-border-subtle" />
  }
}

export default function GoalPhaseTimeline({
  phases,
  currentPhaseType,
  awaitingApproval
}: GoalPhaseTimelineProps): JSX.Element {
  // Build timeline entries including user gate after plan
  const entries: PhaseEntry[] = []
  for (const phase of phases) {
    entries.push(phase)
    // Insert user gate after plan phase
    if (phase.phaseType === 'plan' && phase.status === 'completed') {
      entries.push({
        phaseType: 'plan',
        status: awaitingApproval ? 'gate' : 'completed',
        iteration: phase.iteration
      })
    }
  }

  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-text-secondary mb-2">Phase Timeline</h4>
      <div className="relative">
        {entries.map((entry, idx) => {
          const config = PHASE_CONFIG[entry.phaseType]
          const isGate = entry.status === 'gate'
          const isCurrent = entry.phaseType === currentPhaseType && entry.status === 'running'

          return (
            <div key={`${entry.phaseType}-${idx}`} className="flex items-start gap-3 mb-3 last:mb-0">
              {/* Connector line */}
              <div className="flex flex-col items-center">
                <StatusIcon status={entry.status} />
                {idx < entries.length - 1 && (
                  <div className="w-px h-6 bg-border-subtle mt-1" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 -mt-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text-primary">
                    {isGate ? '👤 User Review' : `${config.emoji} ${config.label}`}
                  </span>
                  {entry.iteration > 1 && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400">
                      iteration {entry.iteration}
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium animate-pulse">
                      running
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {isGate
                    ? 'Review and approve the implementation plan'
                    : config.description}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

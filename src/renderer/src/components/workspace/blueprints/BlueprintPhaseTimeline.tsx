import type { JSX } from 'react'
import { CheckCircle, Circle, Loader2, User, XCircle, MinusCircle } from 'lucide-react'
import type {
  BlueprintPhaseType,
  BlueprintPhaseStatus
} from '../../../../../shared/blueprint-types'
import { BLUEPRINT_PHASE_ORDER } from '../../../../../shared/blueprint-types'

// ── Phase Display Config ──

const PHASE_CONFIG: Record<
  BlueprintPhaseType,
  { label: string; emoji: string; description: string }
> = {
  specify: {
    label: 'Specify',
    emoji: '📋',
    description: 'Analyze the feature and produce a detailed specification'
  },
  clarify: {
    label: 'Clarify',
    emoji: '❓',
    description: 'Ask clarifying questions about ambiguous requirements'
  },
  plan: {
    label: 'Plan',
    emoji: '🗺️',
    description: 'Create a detailed implementation plan with file paths and steps'
  },
  tasks: {
    label: 'Tasks',
    emoji: '📝',
    description: 'Break the plan into ordered tasks with dependency waves'
  },
  review: {
    label: 'Review',
    emoji: '🔍',
    description: 'Review the plan and tasks for completeness and correctness'
  },
  build: {
    label: 'Build',
    emoji: '🏗️',
    description: 'Execute tasks in dependency-ordered waves'
  },
  verify: {
    label: 'Verify',
    emoji: '✅',
    description: 'Run quality checks to confirm the implementation is correct'
  }
}

type TimelineStatus = BlueprintPhaseStatus | 'gate'

interface BlueprintPhaseTimelineProps {
  currentPhase: BlueprintPhaseType | null
  awaitingApproval: boolean
  phaseStatuses?: Partial<Record<BlueprintPhaseType, BlueprintPhaseStatus>>
}

function StatusIcon({ status }: { status: TimelineStatus }): JSX.Element {
  switch (status) {
    case 'active':
      return <Loader2 size={16} className="text-emerald-400 animate-spin" />
    case 'complete':
      return <CheckCircle size={16} className="text-success" />
    case 'failed':
      return <XCircle size={16} className="text-danger" />
    case 'gate':
      return <User size={16} className="text-cyan-400" />
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
  phaseStatuses
}: BlueprintPhaseTimelineProps): JSX.Element {
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
    <div data-testid="blueprint-phase-timeline" className="space-y-1">
      <h4 className="text-xs font-medium text-text-secondary mb-2">Pipeline</h4>
      <div className="relative">
        {entries.map((entry, idx) => {
          const config = PHASE_CONFIG[entry.phaseType]
          const isCurrent =
            entry.phaseType === currentPhase && entry.status === 'active' && !entry.isGate

          return (
            <div
              key={`${entry.phaseType}-${entry.isGate ? 'gate' : 'phase'}`}
              className="flex items-start gap-3 mb-3 last:mb-0"
            >
              {/* Connector line */}
              <div className="flex flex-col items-center">
                <StatusIcon status={entry.status} />
                {idx < entries.length - 1 && <div className="w-px h-6 bg-border-subtle mt-1" />}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 -mt-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text-primary">
                    {entry.isGate ? '👤 Approval Gate' : `${config.emoji} ${config.label}`}
                  </span>
                  {isCurrent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium animate-pulse">
                      running
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {entry.isGate ? 'Review and approve before building' : config.description}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { Loader2, CheckCircle, AlertTriangle, X, Eye, Play, Landmark } from 'lucide-react'
import type { CouncilSessionStatus } from '../../../../../main/db/repositories/council-session.repository'
import type { CouncilInputType, CouncilVerdict } from '../../../../../shared/types'

// ── Types ──────────────────────────────────────────────────────────────────

export interface CouncilSessionSummary {
  id: string
  inputType: CouncilInputType
  inputContent: string
  status: CouncilSessionStatus
  verdict: CouncilVerdict | null
  createdAt: string
  completedAdvisors: string[]
}

// ── Status badge config ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  CouncilSessionStatus,
  { icon: React.ReactNode; bg: string; text: string; label: string }
> = {
  running: {
    icon: <Loader2 size={12} className="animate-spin" />,
    bg: 'bg-info/20',
    text: 'text-info',
    label: 'Running'
  },
  completed: {
    icon: <CheckCircle size={12} />,
    bg: 'bg-success/20',
    text: 'text-success',
    label: 'Completed'
  },
  failed: {
    icon: <AlertTriangle size={12} />,
    bg: 'bg-error/20',
    text: 'text-error',
    label: 'Failed'
  },
  cancelled: {
    icon: <X size={12} />,
    bg: 'bg-surface-float',
    text: 'text-text-muted',
    label: 'Cancelled'
  }
}

const INPUT_TYPE_LABELS: Record<CouncilInputType, string> = {
  plan: 'Plan',
  requirement: 'Requirement',
  question: 'Question'
}

// ── Score badge ────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }): React.JSX.Element {
  const color =
    score >= 80
      ? 'text-success bg-success/10'
      : score >= 60
        ? 'text-warning bg-warning/10'
        : 'text-error bg-error/10'

  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${color}`}>
      {score}/100
    </span>
  )
}

// ── Relative time ──────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Card component ─────────────────────────────────────────────────────────

interface CouncilSessionCardProps {
  session: CouncilSessionSummary
  onView: (sessionId: string) => void
  onResume?: (sessionId: string) => void
}

export default function CouncilSessionCard({
  session,
  onView,
  onResume
}: CouncilSessionCardProps): React.JSX.Element {
  const config = STATUS_CONFIG[session.status]
  const truncatedContent =
    session.inputContent.length > 80
      ? session.inputContent.slice(0, 80) + '…'
      : session.inputContent

  return (
    <div className="w-full flex items-center gap-3 px-3 py-2.5 bg-surface-base rounded-lg border border-border-subtle hover:bg-surface-hover transition-colors">
      {/* Icon */}
      <Landmark size={16} className="text-purple-400/50 flex-shrink-0" />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{truncatedContent}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-text-muted">
            {INPUT_TYPE_LABELS[session.inputType] ?? session.inputType}
          </span>
          {session.verdict?.overallScore != null && (
            <>
              <span className="text-[10px] text-text-muted">·</span>
              <ScoreBadge score={session.verdict.overallScore} />
            </>
          )}
          <span className="text-[10px] text-text-muted">·</span>
          <span className="text-[10px] text-text-muted">
            {session.completedAdvisors.length}/5 advisors
          </span>
          <span className="text-[10px] text-text-muted">·</span>
          <span className="text-[10px] text-text-muted">
            {relativeTime(session.createdAt)}
          </span>
        </div>
      </div>

      {/* Status badge */}
      <span
        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${config.bg} ${config.text}`}
      >
        {config.icon}
        {config.label}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {(session.status === 'completed' || session.status === 'running') && (
          <button
            type="button"
            onClick={() => onView(session.id)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-float rounded transition-colors"
          >
            <Eye size={12} />
            View
          </button>
        )}
        {(session.status === 'failed' || session.status === 'cancelled') && onResume && (
          <button
            type="button"
            onClick={() => onResume(session.id)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-400 hover:bg-amber-500/10 rounded transition-colors"
          >
            <Play size={12} />
            Resume
          </button>
        )}
      </div>
    </div>
  )
}

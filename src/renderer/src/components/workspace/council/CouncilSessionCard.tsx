import { Loader2, CheckCircle, AlertTriangle, X, Eye, Play, Landmark, Trash2, ArrowRight } from 'lucide-react'
import type {
  CouncilSessionStatus,
  CouncilInputType,
  CouncilVerdict,
  CouncilPeerReview,
  CouncilReview
} from '../../../../../shared/types'

// ── Types ──────────────────────────────────────────────────────────────────

export interface CouncilSessionSummary {
  id: string
  inputType: CouncilInputType
  inputContent: string
  status: CouncilSessionStatus
  verdict: CouncilVerdict | null
  createdAt: string
  completedAdvisors: string[]
  // Fields needed for hydration + title extraction
  peerReviews?: CouncilPeerReview[]
  advisorReviews?: CouncilReview[]
  structuredPlanJson?: string | null
  conversationId?: string | null
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

  return <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${color}`}>{score}/100</span>
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

// ── Title extraction ──────────────────────────────────────────────────────

/** Extract a human-readable title from session inputContent.
 *  Plan card flow stores raw JSON; manual flow stores plain text. */
function extractDisplayTitle(session: CouncilSessionSummary): string {
  // Try to parse as JSON (plan card stores structured plan JSON as inputContent)
  try {
    const parsed = JSON.parse(session.inputContent)
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim()
    }
  } catch {
    /* not JSON — use as plain text */
  }

  // Plain text — use first meaningful line
  const firstLine =
    session.inputContent
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? session.inputContent
  return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine
}

// ── Card component ─────────────────────────────────────────────────────────

interface CouncilSessionCardProps {
  session: CouncilSessionSummary
  planTitle?: string | null
  onView: (sessionId: string) => void
  onResume?: (sessionId: string) => void
  onDelete?: (sessionId: string) => void
  onNavigateToPlans?: () => void
}

export default function CouncilSessionCard({
  session,
  planTitle,
  onView,
  onResume,
  onDelete,
  onNavigateToPlans
}: CouncilSessionCardProps): React.JSX.Element {
  const config = STATUS_CONFIG[session.status]
  const displayTitle = extractDisplayTitle(session)

  return (
    <div data-testid="council-session-card" className="group w-full flex items-center gap-3 p-4 bg-surface-overlay rounded-lg border border-border-subtle hover:border-border-default transition-colors shadow-sm">
      {/* Icon */}
      <Landmark size={16} className="text-indigo-400/50 flex-shrink-0" />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className="text-base font-normal text-text-primary truncate"
          style={{ fontFamily: 'var(--ca-font-display)', letterSpacing: '0.01em' }}
        >
          {displayTitle}
        </p>
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
          <span className="text-[10px] text-text-muted">{relativeTime(session.createdAt)}</span>
          {planTitle && (
            <>
              <span className="text-[10px] text-text-muted">·</span>
              {onNavigateToPlans ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onNavigateToPlans() }}
                  className="flex items-center gap-0.5 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  <ArrowRight size={10} />
                  Plan: {planTitle.length > 40 ? planTitle.slice(0, 40) + '…' : planTitle}
                </button>
              ) : (
                <span className="flex items-center gap-0.5 text-[10px] text-indigo-400">
                  <ArrowRight size={10} />
                  Plan: {planTitle.length > 40 ? planTitle.slice(0, 40) + '…' : planTitle}
                </span>
              )}
            </>
          )}
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
        {(session.status === 'completed' ||
          session.status === 'running' ||
          session.status === 'failed' ||
          session.status === 'cancelled') && (
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
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(session.id)}
            className="flex items-center p-1 text-text-muted hover:text-error hover:bg-error/10 rounded transition-colors"
            aria-label="Delete session"
            title="Delete session"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

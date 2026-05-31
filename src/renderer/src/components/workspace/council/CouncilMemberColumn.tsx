/**
 * CouncilMemberColumn — renders a single advisor's streaming analysis.
 *
 * Shows:
 *   - Avatar + role name + status indicator
 *   - Live-streamed analysis text (segmented)
 *   - Tool activity badges
 *   - Score display when complete
 */

import { useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Clock
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { CouncilAdvisorRole, CouncilMemberStatus, CouncilReview } from '../../../../../shared/types'
import { COUNCIL_ADVISORS } from '../../../../../shared/constants'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import type { ToolActivity } from '../../../../../shared/types'

interface CouncilMemberColumnProps {
  role: CouncilAdvisorRole
  status: CouncilMemberStatus
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
  review: CouncilReview | null
}

function StatusBadge({ status }: { status: CouncilMemberStatus }): React.JSX.Element {
  switch (status) {
    case 'pending':
      return (
        <span className="flex items-center gap-1 text-xs text-text-secondary">
          <Clock size={12} /> Waiting
        </span>
      )
    case 'running':
      return (
        <span className="flex items-center gap-1 text-xs text-info">
          <Loader2 size={12} className="animate-spin" /> Analyzing
        </span>
      )
    case 'completed':
      return (
        <span className="flex items-center gap-1 text-xs text-success">
          <CheckCircle2 size={12} /> Done
        </span>
      )
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-xs text-error">
          <AlertTriangle size={12} /> Failed
        </span>
      )
  }
}

function VerdictBadge({ verdict }: { verdict: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    'proceed-with-changes': 'bg-success/20 text-success border-success/30',
    'needs-revision': 'bg-warning/20 text-warning border-warning/30',
    'rethink': 'bg-error/20 text-error border-error/30'
  }

  const labels: Record<string, string> = {
    'proceed-with-changes': 'Proceed',
    'needs-revision': 'Revise',
    'rethink': 'Rethink'
  }

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[verdict] ?? 'bg-surface-float text-text-body'}`}>
      {labels[verdict] ?? verdict}
    </span>
  )
}

function ToolActivityBadge({ activity }: { activity: ToolActivity }): React.JSX.Element {
  const isRunning = activity.status === 'running'
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
        isRunning
          ? 'bg-info/10 text-info border border-info/20'
          : 'bg-surface-float text-text-secondary border border-border-subtle'
      }`}
    >
      {isRunning && <Loader2 size={8} className="animate-spin" />}
      {activity.toolName.replace(/^mcp__[^_]+__/, '')}
    </span>
  )
}

export default function CouncilMemberColumn({
  role,
  status,
  segments,
  currentContent,
  currentToolActivities,
  review
}: CouncilMemberColumnProps): React.JSX.Element {
  const advisor = COUNCIL_ADVISORS[role]

  const allContent = useMemo(() => {
    const parts = segments.map((s) => s.content).join('')
    return parts + currentContent
  }, [segments, currentContent])

  const allToolActivities = useMemo(() => {
    return [
      ...segments.flatMap((s) => s.toolActivities),
      ...currentToolActivities
    ]
  }, [segments, currentToolActivities])

  const runningTools = allToolActivities.filter((t) => t.status === 'running')

  return (
    <div className="flex flex-col h-full min-w-0 border border-border-subtle rounded-lg bg-surface-overlay overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-surface-float/50">
        <span className="text-lg" role="img" aria-label={advisor.name}>
          {advisor.emoji}
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold text-text-primary truncate">
            {advisor.name}
          </span>
          <StatusBadge status={status} />
        </div>
        {review && (
          <div className="ml-auto flex items-center gap-2">
            <VerdictBadge verdict={review.verdict} />
            <span className="text-lg font-bold text-text-primary">
              {review.score}
            </span>
          </div>
        )}
      </div>

      {/* Streaming content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm">
        {status === 'pending' && (
          <div className="flex items-center justify-center h-full text-text-secondary text-xs">
            Waiting for council to convene…
          </div>
        )}

        {allContent && (
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown>{allContent}</ReactMarkdown>
          </div>
        )}

        {/* Tool activity badges */}
        {runningTools.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {runningTools.map((tool) => (
              <ToolActivityBadge key={tool.id} activity={tool} />
            ))}
          </div>
        )}
      </div>

      {/* Review summary footer (when complete) */}
      {review && (
        <div className="border-t border-border-subtle px-3 py-2 bg-surface-float/30">
          <div className="text-xs text-text-secondary mb-1">Key Findings:</div>
          <ul className="text-xs text-text-body space-y-0.5">
            {review.keyFindings.slice(0, 3).map((finding, i) => (
              <li key={i} className="truncate">• {finding}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

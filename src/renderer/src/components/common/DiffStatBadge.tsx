import { memo } from 'react'
import { countDiffLines } from '../chat/tool-activity-utils'
import type { ToolEditDiff } from '../../../../shared/types'

interface DiffStatBadgeProps {
  edits: ToolEditDiff[]
  className?: string
}

/**
 * `+N −M` line-count badge for edit/write tool rows. Emerald additions,
 * red deletions, tabular-nums so the numbers don't jitter as they stream in.
 * Render nothing when there are no diffs (legacy messages degrade gracefully).
 */
function DiffStatBadge({ edits, className }: DiffStatBadgeProps): React.JSX.Element | null {
  if (!edits.length) return null
  const { additions, deletions } = countDiffLines(edits)
  if (additions === 0 && deletions === 0) return null

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] leading-none font-medium tabular-nums flex-shrink-0 ${className ?? ''}`}
      data-testid="diff-stat-badge"
    >
      <span className="text-emerald-400">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  )
}

export default memo(DiffStatBadge)

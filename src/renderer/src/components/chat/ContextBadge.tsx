import type { ContextUsageLevel } from '../../../../shared/types'

interface ContextBadgeProps {
  percentage: number
  level: ContextUsageLevel
  compact?: boolean
}

const LEVEL_STYLES: Record<ContextUsageLevel, string> = {
  green: 'bg-success/10 text-success border-success/20',
  yellow: 'bg-warning/10 text-warning border-warning/20',
  red: 'bg-danger/10 text-danger border-danger/20',
  critical: 'bg-danger/20 text-danger border-danger/30 animate-pulse'
}

export default function ContextBadge({
  percentage,
  level,
  compact = false
}: ContextBadgeProps): React.JSX.Element {
  const style = LEVEL_STYLES[level]

  if (compact) {
    return (
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${style}`}
        title={`Context usage: ${percentage}%`}
      >
        {percentage}%
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${style}`}
      title={`Context window: ${percentage}% used${level === 'critical' ? ' — consider /compact' : ''}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {percentage}% context
    </span>
  )
}

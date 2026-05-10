interface RateLimitBadgeProps {
  utilization: number // 0.0–1.0
  status: 'allowed' | 'allowed_warning' | 'rejected'
}

export default function RateLimitBadge({
  utilization,
  status
}: RateLimitBadgeProps): React.JSX.Element | null {
  // Don't render for 'allowed' status — only show when there's a warning or rejection
  if (status === 'allowed') return null

  const percentage = Math.round(utilization * 100)

  const resetsTooltip =
    status === 'rejected'
      ? `Rate limit reached — ${percentage}% utilized`
      : `Rate limit: ${percentage}% utilized`

  const style =
    status === 'rejected'
      ? 'bg-danger/10 text-danger border-danger/20 animate-pulse'
      : 'bg-warning/10 text-warning border-warning/20'

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${style}`}
      title={resetsTooltip}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      Claude Usage {percentage}%
    </span>
  )
}

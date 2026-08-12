import { Zap } from 'lucide-react'

export default function TokenImpactBadge({
  impact,
  toolCount
}: {
  impact: 'low' | 'medium' | 'high'
  toolCount: number
}): React.JSX.Element {
  const config = {
    low: {
      label: 'Low',
      bgClass: 'bg-success-muted border-success/30',
      textClass: 'text-success'
    },
    medium: {
      label: 'Medium',
      bgClass: 'bg-warning-muted border-warning/30',
      textClass: 'text-warning'
    },
    high: { label: 'High', bgClass: 'bg-danger-muted border-danger/30', textClass: 'text-danger' }
  }
  const c = config[impact]
  return (
    <span
      data-testid="token-impact-badge"
      className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] font-medium ${c.bgClass} ${c.textClass}`}
    >
      <Zap size={11} />
      {c.label} impact · <span className="font-mono tabular-nums">{toolCount}</span> tools
    </span>
  )
}

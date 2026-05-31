import { Zap } from 'lucide-react'

export default function TokenImpactBadge({
  impact,
  toolCount
}: {
  impact: 'low' | 'medium' | 'high'
  toolCount: number
}): React.JSX.Element {
  const config = {
    low: { label: 'Low', bgClass: 'bg-success-muted', textClass: 'text-success' },
    medium: { label: 'Medium', bgClass: 'bg-warning-muted', textClass: 'text-warning' },
    high: { label: 'High', bgClass: 'bg-danger-muted', textClass: 'text-danger' }
  }
  const c = config[impact]
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.bgClass} ${c.textClass}`}
    >
      <Zap size={8} />
      {c.label} impact · {toolCount} tools
    </span>
  )
}

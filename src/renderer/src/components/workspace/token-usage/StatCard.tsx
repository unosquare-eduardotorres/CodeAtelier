import type { LucideIcon } from 'lucide-react'

/**
 * Reusable stat card: icon + label + value + subtitle.
 * Extracted from TokenUsagePage to eliminate 3 identical card patterns.
 */
export default function StatCard({
  icon: Icon,
  label,
  value,
  subtitle
}: {
  icon: LucideIcon
  label: string
  value: string | number
  subtitle: string
}): React.JSX.Element {
  return (
    <div className="bg-surface-overlay border border-border-subtle rounded-lg p-4 shadow-sm">
      <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
        <Icon size={12} />
        {label}
      </div>
      <div className="text-2xl font-display font-normal text-text-primary truncate">
        {value}
      </div>
      <div className="text-xs text-text-secondary mt-1">{subtitle}</div>
    </div>
  )
}

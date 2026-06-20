import type { JSX } from 'react'

const statusConfig: Record<string, { color: string; label: string }> = {
  draft: { color: 'text-text-muted bg-surface-hover', label: 'Draft' },
  specifying: { color: 'text-emerald-400 bg-emerald-500/10', label: 'Specifying' },
  clarifying: { color: 'text-cyan-400 bg-cyan-500/10', label: 'Clarifying' },
  planning: { color: 'text-blue-400 bg-blue-500/10', label: 'Planning' },
  tasking: { color: 'text-purple-400 bg-purple-500/10', label: 'Creating Tasks' },
  reviewing: { color: 'text-indigo-400 bg-indigo-500/10', label: 'Reviewing' },
  building: { color: 'text-emerald-400 bg-emerald-500/10', label: 'Building' },
  verifying: { color: 'text-teal-400 bg-teal-500/10', label: 'Verifying' },
  complete: { color: 'text-success bg-success/10', label: 'Complete' },
  failed: { color: 'text-danger bg-danger/10', label: 'Failed' },
  cancelled: { color: 'text-text-muted bg-surface-hover', label: 'Cancelled' }
}

export default function StatusBadge({ status }: { status: string }): JSX.Element {
  const c = statusConfig[status] ?? statusConfig.draft
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${c.color}`}>{c.label}</span>
  )
}

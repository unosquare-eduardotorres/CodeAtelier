import type { JSX } from 'react'

const statusConfig: Record<string, { color: string; label: string }> = {
  draft: { color: 'text-text-muted bg-surface-float', label: 'Draft' },
  pending: { color: 'text-text-muted bg-surface-float', label: 'Pending' },
  active: { color: 'text-accent bg-accent-muted', label: 'Running' },
  skipped: { color: 'text-text-muted bg-surface-float', label: 'Skipped' },
  specifying: { color: 'text-accent bg-accent-muted', label: 'Specifying' },
  clarifying: { color: 'text-info bg-info-muted', label: 'Clarifying' },
  planning: { color: 'text-info bg-info-muted', label: 'Planning' },
  tasking: { color: 'text-accent bg-accent-muted', label: 'Creating Tasks' },
  reviewing: { color: 'text-accent bg-accent-muted', label: 'Reviewing' },
  building: { color: 'text-accent bg-accent-muted', label: 'Building' },
  verifying: { color: 'text-accent bg-accent-muted', label: 'Verifying' },
  codeReviewing: { color: 'text-accent bg-accent-muted', label: 'Code Reviewing' },
  complete: { color: 'text-success bg-success-muted', label: 'Complete' },
  failed: { color: 'text-danger bg-danger-muted', label: 'Failed' },
  cancelled: { color: 'text-text-muted bg-surface-float', label: 'Stopped' }
}

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const c = statusConfig[status] ?? statusConfig.draft
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${c.color}`}>{c.label}</span>
  )
}

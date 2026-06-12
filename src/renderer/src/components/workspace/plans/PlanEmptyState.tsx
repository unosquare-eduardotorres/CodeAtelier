/**
 * PlanEmptyState — shown when no plans exist in the registry.
 */

import { ClipboardList } from 'lucide-react'

export default function PlanEmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-12 h-12 rounded-xl bg-surface-overlay flex items-center justify-center mb-4">
        <ClipboardList size={24} className="text-text-muted" />
      </div>
      <h4 className="text-sm font-semibold text-text-primary mb-2">No plans yet</h4>
      <p className="text-xs text-text-secondary max-w-xs leading-relaxed">
        Plans appear here automatically when you:
      </p>
      <ul className="text-xs text-text-secondary mt-2 space-y-1 text-left">
        <li className="flex items-start gap-2">
          <span className="text-text-muted mt-0.5">•</span>
          Create a plan in Chat (Plan mode)
        </li>
        <li className="flex items-start gap-2">
          <span className="text-text-muted mt-0.5">•</span>
          Generate a plan from a Grill session
        </li>
        <li className="flex items-start gap-2">
          <span className="text-text-muted mt-0.5">•</span>
          Create a remediation plan from an Audit
        </li>
      </ul>
    </div>
  )
}

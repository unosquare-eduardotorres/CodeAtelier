/**
 * plan-status-icons — shared phase status icons and styling utilities.
 *
 * Used by PlanProgressBar and TaskPlanCard (PlanHelpers) for consistent
 * status visualization across the plan execution UI.
 */

import React from 'react'
import { CheckCircle2, Circle, Loader2, XCircle, SkipForward } from 'lucide-react'

export const PHASE_STATUS_ICON: Record<string, React.JSX.Element> = {
  pending: <Circle size={14} className="text-text-muted" />,
  started: <Loader2 size={14} className="text-info animate-spin" />,
  in_progress: <Loader2 size={14} className="text-info animate-spin" />,
  completed: <CheckCircle2 size={14} className="text-success" />,
  failed: <XCircle size={14} className="text-danger" />,
  skipped: <SkipForward size={14} className="text-text-muted" />
}

export function statusDotColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-success'
    case 'started':
    case 'in_progress':
      return 'bg-info animate-pulse'
    case 'failed':
      return 'bg-danger'
    case 'skipped':
      return 'bg-text-muted'
    default:
      return 'bg-border-subtle'
  }
}

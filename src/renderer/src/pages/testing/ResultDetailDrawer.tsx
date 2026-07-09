/**
 * ResultDetailDrawer — Full-height slide-over panel for viewing result details.
 *
 * Replaces inline accordion expansion in both RunsView and ScenarioCatalog.
 * Provides a single scroll region so transcripts are comfortable to read.
 */

import { useEffect, useCallback } from 'react'
import { X, CheckCircle2, XCircle, AlertTriangle, Loader2, Clock } from 'lucide-react'
import type { E2EResultStatus } from '../../../../shared/types'
import ResultDetailPanel from './ResultDetailPanel'

export interface DrawerTarget {
  resultId: string
  title: string
  status?: E2EResultStatus
  durationMs?: number | null
}

interface ResultDetailDrawerProps {
  target: DrawerTarget | null
  onClose: () => void
}

function statusIcon(status: E2EResultStatus | undefined): React.JSX.Element | null {
  switch (status) {
    case 'passed':
      return <CheckCircle2 size={16} className="text-success shrink-0" />
    case 'failed':
      return <XCircle size={16} className="text-danger shrink-0" />
    case 'error':
      return <AlertTriangle size={16} className="text-warning shrink-0" />
    case 'running':
      return <Loader2 size={16} className="text-info animate-spin shrink-0" />
    default:
      return null
  }
}

function statusBadgeClass(status: E2EResultStatus | undefined): string {
  switch (status) {
    case 'passed':
      return 'bg-success/20 text-success'
    case 'failed':
      return 'bg-danger/20 text-danger'
    case 'error':
      return 'bg-warning/20 text-warning'
    case 'running':
      return 'bg-info/20 text-info'
    default:
      return 'bg-surface-base text-text-muted'
  }
}

export default function ResultDetailDrawer({
  target,
  onClose
}: ResultDetailDrawerProps): React.JSX.Element | null {
  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (!target) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [target, handleKeyDown])

  if (!target) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 transition-opacity"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 flex w-[600px] max-w-[90vw] flex-col border-l border-border-subtle bg-surface-overlay shadow-2xl"
        role="dialog"
        aria-label={`Result details for ${target.title}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {statusIcon(target.status)}
            <h2 className="text-sm font-semibold text-text-body truncate">{target.title}</h2>
            {target.status && (
              <span className={`text-xs px-1.5 py-0.5 rounded-lg shrink-0 ${statusBadgeClass(target.status)}`}>
                {target.status}
              </span>
            )}
            {target.durationMs != null && target.durationMs > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted tabular-nums shrink-0">
                <Clock size={10} />
                {(target.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-surface-raised transition-colors text-text-muted hover:text-text-body shrink-0"
            aria-label="Close drawer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — single scroll region */}
        <div className="flex-1 overflow-y-auto">
          <ResultDetailPanel resultId={target.resultId} scenarioTitle={target.title} />
        </div>
      </div>
    </>
  )
}

import { useEffect, useState, useCallback } from 'react'
import {
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  FileText,
  AlertTriangle
} from 'lucide-react'

interface CheckpointApprovalRequest {
  id: string
  type: 'phase_gate' | 'merge_approval' | 'destructive_action'
  title: string
  summary: string
  details: {
    what: string
    why: string
    risk: string
    changedFiles?: string[]
    testResults?: string
  }
  createdAt: string
}

const TYPE_BADGES: Record<CheckpointApprovalRequest['type'], { label: string; className: string }> =
  {
    phase_gate: {
      label: 'Phase Gate',
      className: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    },
    merge_approval: {
      label: 'Merge Approval',
      className: 'bg-amber-500/20 text-amber-400 border-amber-500/30'
    },
    destructive_action: {
      label: 'Destructive Action',
      className: 'bg-red-500/20 text-red-400 border-red-500/30'
    }
  }

export default function CheckpointApprovalModal(): React.JSX.Element | null {
  const [requests, setRequests] = useState<CheckpointApprovalRequest[]>([])
  const [filesExpanded, setFilesExpanded] = useState(false)

  useEffect(() => {
    const cleanup = window.api.onCheckpointApprovalRequest((data) => {
      setRequests((prev) => [...prev, data])
    })
    return cleanup
  }, [])

  const handleRespond = useCallback((checkpointId: string, approved: boolean) => {
    window.api.respondCheckpointApproval(checkpointId, approved)
    setRequests((prev) => prev.filter((r) => r.id !== checkpointId))
    setFilesExpanded(false)
  }, [])

  if (requests.length === 0) return null

  const current = requests[0]
  const badge = TYPE_BADGES[current.type]

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="checkpoint-approval-title"
    >
      <div data-testid="checkpoint-approval-modal" className="bg-surface-float border border-border-default rounded-xl shadow-2xl overflow-hidden w-[520px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 bg-surface-overlay border-b border-border-default">
          <ShieldCheck size={20} className="text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h3
              id="checkpoint-approval-title"
              className="text-sm font-semibold text-text-primary truncate"
            >
              {current.title}
            </h3>
            <p className="text-xs text-text-secondary mt-0.5">{current.summary}</p>
          </div>
          <span
            data-testid="checkpoint-type-badge"
            className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.className}`}
          >
            {badge.label}
          </span>
          {requests.length > 1 && (
            <span className="text-xs text-text-secondary bg-surface-overlay px-2 py-0.5 rounded-full border border-border-default">
              +{requests.length - 1} more
            </span>
          )}
        </div>

        {/* Details */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          {/* What */}
          <div>
            <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1">
              What
            </p>
            <p className="text-sm text-text-body">{current.details.what}</p>
          </div>

          {/* Why */}
          <div>
            <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1">
              Why this needs approval
            </p>
            <p className="text-sm text-text-body">{current.details.why}</p>
          </div>

          {/* Risk */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
            <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider mb-0.5">
                Risk
              </p>
              <p className="text-xs text-text-body">{current.details.risk}</p>
            </div>
          </div>

          {/* Changed files (collapsible) */}
          {current.details.changedFiles && current.details.changedFiles.length > 0 && (
            <div>
              <button
                data-testid="checkpoint-files-toggle"
                onClick={() => setFilesExpanded(!filesExpanded)}
                className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-wider hover:text-text-primary transition-colors"
              >
                <FileText size={12} />
                Changed Files ({current.details.changedFiles.length})
                {filesExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {filesExpanded && (
                <div className="mt-1.5 max-h-32 overflow-y-auto rounded-lg bg-surface-overlay p-2">
                  {current.details.changedFiles.map((file) => (
                    <p key={file} className="text-xs text-text-body font-mono py-0.5 truncate">
                      {file}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Test results */}
          {current.details.testResults && (
            <div>
              <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1">
                Test Results
              </p>
              <pre className="text-xs text-text-body bg-surface-overlay rounded-lg p-2 overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                {current.details.testResults}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-default bg-surface-overlay">
          <button
            data-testid="checkpoint-reject-btn"
            onClick={() => handleRespond(current.id, false)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            aria-label="Reject checkpoint"
          >
            <XCircle size={15} />
            Reject
          </button>
          <button
            data-testid="checkpoint-approve-btn"
            onClick={() => handleRespond(current.id, true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Approve checkpoint"
          >
            <CheckCircle2 size={15} />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

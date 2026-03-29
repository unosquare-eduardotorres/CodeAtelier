import { useEffect, useState, useCallback, useRef } from 'react'
import { ShieldAlert, Check, X } from 'lucide-react'

interface ToolApprovalRequest {
  requestId: string
  toolName: string
  toolInput: string
  agentId: string
  taskId?: string
}

/** Auto-dismiss timeout — matches service-side timeout (30s) */
const AUTO_DISMISS_MS = 28_000

export default function ToolApprovalModal(): React.JSX.Element | null {
  const [requests, setRequests] = useState<ToolApprovalRequest[]>([])
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const cleanup = window.api.onToolApprovalRequest((data) => {
      setRequests((prev) => [...prev, data])

      // Auto-dismiss after timeout (service will auto-approve)
      const timer = setTimeout(() => {
        setRequests((prev) => prev.filter((r) => r.requestId !== data.requestId))
        timerRefs.current.delete(data.requestId)
      }, AUTO_DISMISS_MS)
      timerRefs.current.set(data.requestId, timer)
    })

    return () => {
      cleanup()
      // Clear all auto-dismiss timers
      for (const timer of timerRefs.current.values()) {
        clearTimeout(timer)
      }
      timerRefs.current.clear()
    }
  }, [])

  const handleRespond = useCallback((requestId: string, approved: boolean) => {
    window.api.respondToolApproval(requestId, approved)
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId))

    // Clear auto-dismiss timer
    const timer = timerRefs.current.get(requestId)
    if (timer) {
      clearTimeout(timer)
      timerRefs.current.delete(requestId)
    }
  }, [])

  if (requests.length === 0) return null

  // Show only the most recent request (stack behavior)
  const current = requests[requests.length - 1]

  return (
    <div
      className="fixed bottom-4 right-4 z-[110] w-96 animate-in slide-in-from-bottom-4 fade-in"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="tool-approval-title"
    >
      <div className="bg-surface-float border border-border-default rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/10 border-b border-border-default">
          <ShieldAlert size={18} className="text-amber-400 flex-shrink-0" />
          <h3 id="tool-approval-title" className="text-sm font-semibold text-text-primary">
            Tool Approval Required
          </h3>
          {requests.length > 1 && (
            <span className="ml-auto text-xs text-text-secondary bg-surface-overlay px-2 py-0.5 rounded-full">
              +{requests.length - 1} more
            </span>
          )}
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">Agent:</span>
            <span className="text-xs text-text-body font-mono">{current.agentId}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">Tool:</span>
            <span className="text-xs text-amber-400 font-mono font-semibold">
              {current.toolName}
            </span>
          </div>
          {current.toolInput && (
            <div className="mt-1">
              <p className="text-xs text-text-secondary mb-1">Input:</p>
              <pre className="text-xs text-text-body bg-surface-overlay rounded-lg p-2 overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                {current.toolInput}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-default">
          <button
            onClick={() => handleRespond(current.requestId, false)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            aria-label="Deny tool execution"
          >
            <X size={14} />
            Deny
          </button>
          <button
            onClick={() => handleRespond(current.requestId, true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Approve tool execution"
          >
            <Check size={14} />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

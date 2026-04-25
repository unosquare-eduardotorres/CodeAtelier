import { useEffect, useState, useCallback, useRef } from 'react'
import { ShieldAlert, ShieldCheck, Check, CheckCheck, X } from 'lucide-react'

interface ToolApprovalRequest {
  requestId: string
  toolName: string
  toolInput: string
  agentId: string
  taskId?: string
  // Enriched from canUseTool
  title?: string
  displayName?: string
  description?: string
  hasAlwaysAllow?: boolean
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

    const timers = timerRefs.current
    return () => {
      cleanup()
      // Clear all auto-dismiss timers
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
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

  const handleAcceptAll = useCallback(() => {
    // Approve all pending requests
    for (const req of requests) {
      window.api.respondToolApproval(req.requestId, true)
    }
    // Clear all auto-dismiss timers
    for (const timer of timerRefs.current.values()) {
      clearTimeout(timer)
    }
    timerRefs.current.clear()
    setRequests([])
    // Set session-level auto-approve so no more prompts appear
    window.api.setToolApprovalMode('accept-all')
  }, [requests])

  if (requests.length === 0) return null

  // Show only the most recent request (stack behavior)
  const current = requests[requests.length - 1]

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tool-approval-title"
    >
      <div className="bg-surface-float/95 backdrop-blur-xl border border-border-default/60 rounded-2xl shadow-2xl overflow-hidden w-[440px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 bg-amber-500/10 border-b border-border-default/60">
          <ShieldAlert size={18} className="text-amber-400 flex-shrink-0" />
          <h3 id="tool-approval-title" className="text-sm font-semibold text-text-primary">
            {current.title ?? 'Tool Approval Required'}
          </h3>
          {requests.length > 1 && (
            <span className="ml-auto text-xs text-text-secondary bg-surface-overlay px-2 py-0.5 rounded-full">
              +{requests.length - 1} more
            </span>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-2.5 overflow-y-auto">
          {current.description && (
            <p className="text-xs text-text-secondary">{current.description}</p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">Agent:</span>
            <span className="text-xs text-text-body font-mono">{current.agentId}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">Tool:</span>
            <span className="text-xs text-amber-400 font-mono font-semibold">
              {current.toolName}
            </span>
            {current.displayName && (
              <span className="text-xs text-text-secondary bg-surface-overlay px-1.5 py-0.5 rounded">
                {current.displayName}
              </span>
            )}
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
        <div
          className={`grid gap-2 px-5 py-4 border-t border-border-default/60 bg-surface-overlay/50 ${
            current.hasAlwaysAllow ? 'grid-cols-2' : 'grid-cols-3'
          }`}
        >
          {/* Deny — destructive */}
          <button
            onClick={() => handleRespond(current.requestId, false)}
            className="flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-medium whitespace-nowrap text-red-300 bg-red-500/10 hover:bg-red-500/20 ring-1 ring-inset ring-red-500/20 hover:ring-red-500/40 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            aria-label="Deny tool execution"
          >
            <X size={14} />
            Deny
          </button>

          {current.hasAlwaysAllow && (
            <button
              onClick={() => handleRespond(current.requestId, true)}
              className="flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-medium whitespace-nowrap text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 ring-1 ring-inset ring-violet-500/20 hover:ring-violet-500/40 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              aria-label="Always allow this tool"
            >
              <ShieldCheck size={14} />
              Always Allow
            </button>
          )}

          {/* Accept All — secondary */}
          <button
            onClick={handleAcceptAll}
            className="flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-medium whitespace-nowrap text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 ring-1 ring-inset ring-blue-500/20 hover:ring-blue-500/40 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            aria-label="Accept all tools for this session"
          >
            <CheckCheck size={14} />
            Accept All
          </button>

          {/* Approve — primary action (filled / bolder) */}
          <button
            onClick={() => handleRespond(current.requestId, true)}
            className="flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold whitespace-nowrap text-white bg-emerald-500/80 hover:bg-emerald-500 ring-1 ring-inset ring-emerald-400/40 hover:ring-emerald-300/60 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 shadow-sm shadow-emerald-500/20"
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

import { useState, useEffect, useRef, useCallback } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface RateLimitState {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  utilization?: number
  resetsAt?: number
  rateLimitType?: string
}

const AUTO_DISMISS_MS = 30_000

export default function RateLimitBanner(): React.JSX.Element | null {
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismiss = useCallback(() => {
    setRateLimit(null)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    const cleanup = window.api.onRateLimitEvent((data) => {
      if (data.status === 'allowed') {
        // All clear — dismiss any existing banner
        dismiss()
        return
      }

      setRateLimit(data as RateLimitState)

      // Auto-dismiss warnings after timeout (keep rejected visible)
      if (timerRef.current) clearTimeout(timerRef.current)
      if (data.status === 'allowed_warning') {
        timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS)
      }
    })

    return () => {
      cleanup()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [dismiss])

  if (!rateLimit || rateLimit.status === 'allowed') return null

  const isRejected = rateLimit.status === 'rejected'
  const resetsInMin = rateLimit.resetsAt
    ? Math.max(1, Math.ceil((rateLimit.resetsAt - Date.now()) / 60_000))
    : undefined

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 text-sm border-b ${
        isRejected
          ? 'bg-danger/10 border-danger/30 text-danger'
          : 'bg-warning/10 border-warning/30 text-warning'
      }`}
    >
      <AlertTriangle size={16} className="flex-shrink-0" />
      <div className="flex-1 flex items-center gap-3">
        <span>
          {isRejected
            ? `Rate limit reached${resetsInMin ? ` — resets in ~${resetsInMin} min` : ''}`
            : `Rate limit warning${rateLimit.utilization ? ` (${Math.round(rateLimit.utilization * 100)}% utilized)` : ''}`}
        </span>
        {rateLimit.utilization !== undefined && !isRejected && (
          <div className="w-24 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className="h-full bg-warning rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, Math.round(rateLimit.utilization * 100))}%` }}
            />
          </div>
        )}
      </div>
      <button
        onClick={dismiss}
        className="p-0.5 hover:bg-surface-overlay rounded transition-colors"
        title="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'

interface ApiRetryInfo {
  attempt: number
  maxRetries: number
  retryDelayMs: number
  errorStatus: number | null
}

/**
 * Subscribes to SDK API retry events and exposes retry state.
 * Auto-clears 5s after the last retry event.
 */
export function useApiRetryState(): {
  apiRetry: ApiRetryInfo | null
  dismissApiRetry: () => void
} {
  const [apiRetry, setApiRetry] = useState<ApiRetryInfo | null>(null)
  const dismissApiRetry = useCallback(() => setApiRetry(null), [])

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = window.api.onApiRetry((data) => {
      setApiRetry(data)
      // Auto-dismiss 5s after each retry event (reset on new event)
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => setApiRetry(null), 5000)
    })
    return () => {
      cleanup()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  return { apiRetry, dismissApiRetry }
}

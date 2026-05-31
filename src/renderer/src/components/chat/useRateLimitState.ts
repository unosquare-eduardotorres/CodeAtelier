import { useState, useEffect, useCallback } from 'react'

/**
 * Subscribes to SDK rate limit events and exposes state + dismiss handler.
 */
export function useRateLimitState(): {
  rateLimitState: { status: 'allowed_warning' | 'rejected'; utilization?: number } | null
  dismissRateLimit: () => void
} {
  const [rateLimitState, setRateLimitState] = useState<{
    status: 'allowed_warning' | 'rejected'
    utilization?: number
  } | null>(null)

  const dismissRateLimit = useCallback(() => setRateLimitState(null), [])

  useEffect(() => {
    const cleanup = window.api.onRateLimitEvent((data) => {
      if (data.status === 'allowed') {
        dismissRateLimit()
        return
      }
      setRateLimitState(data as { status: 'allowed_warning' | 'rejected'; utilization?: number })
    })
    return cleanup
  }, [dismissRateLimit])

  return { rateLimitState, dismissRateLimit }
}

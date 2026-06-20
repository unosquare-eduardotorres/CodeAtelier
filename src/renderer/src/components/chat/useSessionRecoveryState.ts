import { useEffect } from 'react'
import { useChatStore } from '@renderer/store'
import type { SessionRecoveryPhase } from './SessionRecoveryBanner'

/**
 * Subscribes to session recovery IPC events, manages banner auto-dismiss.
 */
export function useSessionRecoveryState(): {
  sessionRecovery: { active: boolean; phase: SessionRecoveryPhase; message: string } | null
} {
  const sessionRecovery = useChatStore((s) => s.sessionRecovery)
  const setSessionRecovery = useChatStore((s) => s.setSessionRecovery)

  // FE-03: Track dismiss timer for cleanup on unmount
  useEffect(() => {
    let dismissTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = window.api.onSessionRecovery((data) => {
      // Clear any pending dismiss timer when new recovery data arrives
      if (dismissTimer) {
        clearTimeout(dismissTimer)
        dismissTimer = undefined
      }

      if (data.phase === 'completed') {
        // Auto-dismiss after 2s
        setSessionRecovery({
          active: true,
          phase: 'completed',
          message: data.message
        })
        dismissTimer = setTimeout(() => setSessionRecovery(null), 2000)
      } else {
        setSessionRecovery({
          active: true,
          phase: data.phase as SessionRecoveryPhase,
          message: data.message
        })
      }
    })
    return () => {
      cleanup()
      if (dismissTimer) clearTimeout(dismissTimer)
    }
  }, [setSessionRecovery])

  return { sessionRecovery }
}

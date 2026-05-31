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

  useEffect(() => {
    const cleanup = window.api.onSessionRecovery((data) => {
      if (data.phase === 'completed') {
        // Auto-dismiss after 2s
        setSessionRecovery({
          active: true,
          phase: 'completed',
          message: data.message
        })
        setTimeout(() => setSessionRecovery(null), 2000)
      } else {
        setSessionRecovery({
          active: true,
          phase: data.phase as SessionRecoveryPhase,
          message: data.message
        })
      }
    })
    return cleanup
  }, [setSessionRecovery])

  return { sessionRecovery }
}

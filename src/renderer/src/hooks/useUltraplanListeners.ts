/**
 * useUltraplanListeners — registers IPC listeners for UltraPlan lifecycle events.
 *
 * Mount at the App level to keep UltraPlan state in sync regardless of which
 * page the user is viewing.
 */

import { useEffect } from 'react'
import { useUltraplanStore } from '@renderer/store/ultraplan.store'

export function useUltraplanListeners(): void {
  useEffect(() => {
    const unsubStatus = window.api.onUltraplanStatus((data) => {
      const store = useUltraplanStore.getState()
      store.setStatus(data.status, data.sessionUrl)
      if (data.conversationId) {
        store.setConversationId(data.conversationId)
      }
    })

    const unsubApproved = window.api.onUltraplanApproved((data) => {
      const store = useUltraplanStore.getState()
      store.setApproved(data.planContent)
      if (data.conversationId) {
        store.setConversationId(data.conversationId)
      }
    })

    return () => {
      unsubStatus()
      unsubApproved()
    }
  }, [])
}

import { useState, useEffect, useCallback } from 'react'
import { useChatStore, useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../shared/constants'
import type { ExternalMcpDefinition } from '../../../../shared/constants'

/**
 * Loads available external MCP integrations for the active workspace
 * and provides a toggle handler for per-conversation activation.
 */
export function useMcpIntegrations(): {
  availableMcpIntegrations: ExternalMcpDefinition[]
  handleMcpToggle: (mcpId: string) => Promise<void>
} {
  const { activeWorkspace } = useWorkspaceStore()
  const activeConversation = useChatStore((s) => s.activeConversation)
  const [availableMcpIntegrations, setAvailableMcpIntegrations] = useState<ExternalMcpDefinition[]>(
    []
  )

  useEffect(() => {
    if (!activeWorkspace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when workspace unloads
      setAvailableMcpIntegrations([])
      return
    }
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        const available = EXTERNAL_MCP_INTEGRATIONS.filter((i) => !!settings[`${i.id}Available`])
        setAvailableMcpIntegrations(available)
      })
      .catch(() => setAvailableMcpIntegrations([]))
  }, [activeWorkspace])

  // Toggle handler — persists to DB, updates store optimistically with rollback
  const handleMcpToggle = useCallback(
    async (mcpId: string): Promise<void> => {
      if (!activeConversation) return
      const current = activeConversation.mcpOverrides ?? {}
      const updated = { ...current, [mcpId]: !current[mcpId] }

      // FE-02: Save original for rollback on API failure
      const originalConv = activeConversation

      // Optimistic update
      const updatedConv = { ...activeConversation, mcpOverrides: updated }
      useChatStore.setState((state) => ({
        activeConversation: updatedConv,
        conversations: state.conversations.map((c) => (c.id === updatedConv.id ? updatedConv : c))
      }))

      // Persist — rollback on failure
      try {
        await window.api.updateMcpOverrides({
          conversationId: activeConversation.id,
          overrides: updated
        })
      } catch (err) {
        console.error('[useMcpIntegrations] Failed to persist MCP override, rolling back:', err)
        useChatStore.setState((state) => ({
          activeConversation: originalConv,
          conversations: state.conversations.map((c) =>
            c.id === originalConv.id ? originalConv : c
          )
        }))
      }
    },
    [activeConversation]
  )

  return { availableMcpIntegrations, handleMcpToggle }
}

import { useCallback } from 'react'
import { useChatStore, useWorkspaceStore, useIdeaStore } from '@renderer/store'
import type { Workspace, Conversation } from '../../../../../shared/types'
import type { SettingsTab } from '@renderer/components/workspace/WorkspaceSettingsPanel'

interface NavigationHandlers {
  handleGoHome: () => void
  handleNavigateToChat: () => void
  handleFixInNewChat: () => void
  handleOpenIdeas: () => void
  handleCreateIdea: (data: { title: string; description?: string }) => Promise<void>
  handleStartGrillMe: () => Promise<void>
  handleNavigateToGrill: (ideaId: string) => void
  handleSendPlanToGrill: (title: string, description: string) => Promise<void>
}

/**
 * Consolidates 6+ navigation callbacks used by AppLayout.
 */
export function useNavigationHandlers(
  activeWorkspace: Workspace | null,
  activeConversation: Conversation | null,
  setView: (view: 'chat' | 'app-settings' | 'help' | 'bugs') => void,
  setSidebarView: (view: 'chat' | 'settings') => void,
  setWorkspaceSettingsTab: (tab: SettingsTab) => void,
  setShowNewChat: (show: boolean) => void,
  setPendingGrill: (
    grill: {
      ideaId: string
      conversationId: string
      ideaTitle: string
      ideaDescription?: string
      isNewSession?: boolean
    } | null
  ) => void
): NavigationHandlers {
  const clearActiveWorkspace = useWorkspaceStore((s) => s.clearActiveWorkspace)
  const { createIdea, startGrill } = useIdeaStore()

  const handleGoHome = useCallback((): void => {
    clearActiveWorkspace()
    setView('chat')
    setSidebarView('chat')
  }, [clearActiveWorkspace, setView, setSidebarView])

  const handleNavigateToChat = useCallback((): void => {
    setView('chat')
    setSidebarView('chat')
  }, [setView, setSidebarView])

  const handleFixInNewChat = useCallback((): void => {
    useChatStore.setState({ activeConversation: null, messages: [] })
    setShowNewChat(true)
    setView('chat')
    setSidebarView('chat')
  }, [setShowNewChat, setView, setSidebarView])

  const handleOpenIdeas = useCallback((): void => {
    setWorkspaceSettingsTab('ideas')
    setSidebarView('settings')
  }, [setWorkspaceSettingsTab, setSidebarView])

  const handleCreateIdea = useCallback(
    async (data: { title: string; description?: string }): Promise<void> => {
      if (!activeWorkspace) return
      await createIdea(activeWorkspace.id, data.title, data.description ?? '')
      setWorkspaceSettingsTab('ideas')
      setSidebarView('settings')
    },
    [activeWorkspace, createIdea, setWorkspaceSettingsTab, setSidebarView]
  )

  const handleStartGrillMe = useCallback(async (): Promise<void> => {
    if (!activeWorkspace || !activeConversation) return

    try {
      const idea = await createIdea(activeWorkspace.id, activeConversation.title, '')
      const { idea: updatedIdea, conversation: grillConversation } = await startGrill(
        idea.id,
        activeWorkspace.id
      )
      setWorkspaceSettingsTab('ideas')
      setSidebarView('settings')
      setPendingGrill({
        ideaId: updatedIdea.id,
        conversationId: grillConversation.id,
        ideaTitle: updatedIdea.title,
        ideaDescription: updatedIdea.description,
        isNewSession: true
      })
    } catch (error) {
      console.error('[AppLayout] Failed to start grill from /grillme command:', error)
    }
  }, [
    activeWorkspace,
    activeConversation,
    createIdea,
    startGrill,
    setWorkspaceSettingsTab,
    setSidebarView,
    setPendingGrill
  ])

  const handleNavigateToGrill = useCallback(
    (_ideaId: string) => {
      setWorkspaceSettingsTab('ideas')
      setSidebarView('settings')
    },
    [setWorkspaceSettingsTab, setSidebarView]
  )

  // Route a generated plan (e.g. from a Health audit) into a fresh Grill session.
  const handleSendPlanToGrill = useCallback(
    async (title: string, description: string): Promise<void> => {
      if (!activeWorkspace) return
      try {
        const idea = await createIdea(activeWorkspace.id, title, description)
        const { idea: updatedIdea, conversation: grillConversation } = await startGrill(
          idea.id,
          activeWorkspace.id
        )
        setWorkspaceSettingsTab('ideas')
        setSidebarView('settings')
        setPendingGrill({
          ideaId: updatedIdea.id,
          conversationId: grillConversation.id,
          ideaTitle: updatedIdea.title,
          ideaDescription: updatedIdea.description,
          isNewSession: true
        })
      } catch (error) {
        console.error('[AppLayout] Failed to send plan to grill:', error)
      }
    },
    [
      activeWorkspace,
      createIdea,
      startGrill,
      setWorkspaceSettingsTab,
      setSidebarView,
      setPendingGrill
    ]
  )

  return {
    handleGoHome,
    handleNavigateToChat,
    handleFixInNewChat,
    handleOpenIdeas,
    handleCreateIdea,
    handleStartGrillMe,
    handleNavigateToGrill,
    handleSendPlanToGrill
  }
}

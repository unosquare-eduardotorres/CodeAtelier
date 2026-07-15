/**
 * useAppKeyboardShortcuts — extracts keyboard shortcut handling from AppLayout.
 *
 * Shortcuts: Esc (back), ⌘B (sidebar), ⌘N (new chat), ⌘. (cycle mode),
 * ⌘/ (help), ⌘+/- (zoom), ⌘0 (zoom reset).
 */
import { useCallback, useEffect } from 'react'
import type { Conversation, ConversationMode, Workspace } from '../../../../../shared/types'
import { useChatStore } from '@renderer/store'

type ViewType = 'chat' | 'app-settings' | 'help' | 'bugs'

interface AppKeyboardShortcutsDeps {
  activeWorkspace: Workspace | null
  activeConversation: Conversation | null
  isStreaming: boolean
  updateMode: (mode: ConversationMode) => void
  navigateBack: () => void
  view: ViewType
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setView: (v: ViewType) => void
  setShowNewChat: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAppKeyboardShortcuts(deps: AppKeyboardShortcutsDeps): void {
  const {
    activeWorkspace,
    activeConversation,
    isStreaming,
    updateMode,
    navigateBack,
    view,
    setSidebarCollapsed,
    setView,
    setShowNewChat
  } = deps

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey

      // Esc — navigate back (context-aware)
      if (e.key === 'Escape') {
        const tag = (document.activeElement as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (document.querySelector('[role="dialog"]')) return
        e.preventDefault()
        navigateBack()
        return
      }

      if (isMeta && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed((prev) => !prev)
      }

      if (isMeta && e.key === 'n') {
        e.preventDefault()
        if (activeWorkspace) {
          useChatStore.setState({ activeConversation: null, messages: [] })
          setShowNewChat(true)
        }
      }

      if (isMeta && e.key === '.') {
        e.preventDefault()
        if (activeConversation && !isStreaming) {
          const modeCycle: Record<ConversationMode, ConversationMode> = {
            plan: 'build',
            build: 'danger',
            danger: 'plan'
          }
          updateMode(modeCycle[activeConversation.mode])
        }
      }

      if (isMeta && e.key === '/') {
        e.preventDefault()
        setView(view === 'help' ? 'chat' : 'help')
      }

      // Zoom shortcuts
      if (isMeta && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        window.api.zoomIn()
      }
      if (isMeta && e.key === '-') {
        e.preventDefault()
        window.api.zoomOut()
      }
      if (isMeta && e.key === '0') {
        e.preventDefault()
        window.api.zoomReset()
      }
    },
    [
      activeWorkspace,
      activeConversation,
      updateMode,
      isStreaming,
      navigateBack,
      view,
      setSidebarCollapsed,
      setView,
      setShowNewChat
    ]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

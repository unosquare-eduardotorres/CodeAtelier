import { useState, useEffect, useRef, useCallback } from 'react'
import {
  useChatStore,
  useChatActions,
  useWorkspaceStore,
  useCodeChangesStore
} from '@renderer/store'
import type { ConversationMode } from '../../../../shared/types'

export type ChatTab = 'chat' | 'code-changes'

const MODE_CYCLE: Record<ConversationMode, ConversationMode> = {
  plan: 'build',
  build: 'danger',
  danger: 'plan'
}

export function useChatPanelState() {
  const { activeWorkspace, agentStatus } = useWorkspaceStore()
  const { createConversation, sendMessage, loadContextUsage, updateMode, setEffort } =
    useChatActions()
  const effortLevels = useChatStore((s) => s.effortLevels)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)

  const [attachments, setAttachments] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [activeTab, setActiveTab] = useState<ChatTab>('chat')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Budget cap banner state
  const budgetCapBanner = useChatStore((s) => s.budgetCapBanner)
  const continuePastBudgetCap = useChatStore((s) => s.continuePastBudgetCap)
  const dismissBudgetCap = useChatStore((s) => s.dismissBudgetCap)

  // Code changes count for tab badge
  const pendingChangesCount = useCodeChangesStore((s) => s.files.length)
  const loadFiles = useCodeChangesStore((s) => s.loadFiles)

  // ── Effects ──

  useEffect(() => {
    if (activeConversation?.id) {
      void loadFiles(activeConversation.id)
    }
  }, [activeConversation?.id, loadFiles])

  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus()
    }
  }, [showSearch])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on conversation switch
    setActiveTab('chat')
  }, [activeConversation?.id])

  useEffect(() => {
    if (activeConversation?.id) {
      void loadContextUsage(activeConversation.id)
    }
    if (!isStreaming && activeConversation?.id) {
      const convId = activeConversation.id
      const timer = setTimeout(() => {
        void loadContextUsage(convId)
      }, 2000)
      return (): void => {
        clearTimeout(timer)
      }
    }
    return undefined
  }, [activeConversation?.id, isStreaming, loadContextUsage])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // ── Callbacks ──

  const handleCreateChat = useCallback(
    async (data: {
      title: string
      description?: string
      mode: ConversationMode
      communicationTone?: import('../../../../shared/types').CommunicationTone | null
      attachments?: string[]
      useIsolatedBranch?: boolean
      llmProvider?: string
      routingOverrides?: Partial<import('../../../../shared/types').ModelRoleMap>
      mcpOverrides?: Record<string, boolean>
    }): Promise<void> => {
      if (!activeWorkspace) return
      await createConversation(
        activeWorkspace.id,
        data.mode,
        data.title,
        undefined,
        (data.llmProvider as import('../../../../shared/types').LLMProvider) ?? undefined,
        data.routingOverrides,
        data.mcpOverrides,
        data.communicationTone
      )
      if (data.useIsolatedBranch) {
        console.info(
          '[NewConversationModal] Isolated branch requested — worktree integration pending'
        )
      }
      if (data.description) {
        sendMessage(data.description, data.attachments)
      }
    },
    [activeWorkspace, createConversation, sendMessage]
  )

  const handleCycleMode = useCallback(() => {
    if (activeConversation) {
      updateMode(MODE_CYCLE[activeConversation.mode])
    }
  }, [activeConversation, updateMode])

  const handleCloseSearch = useCallback(() => {
    setShowSearch(false)
    setSearchQuery('')
  }, [])

  const clearAttachments = useCallback(() => setAttachments([]), [])

  // Filter messages for search
  const filteredMessages = searchQuery
    ? messages.filter((m) => m.contentMd.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  return {
    activeWorkspace,
    agentStatus,
    activeConversation,
    messages,
    isStreaming,
    effortLevels,
    setEffort,
    attachments,
    setAttachments,
    clearAttachments,
    searchQuery,
    setSearchQuery,
    showSearch,
    setShowSearch,
    activeTab,
    setActiveTab,
    searchInputRef,
    budgetCapBanner,
    continuePastBudgetCap,
    dismissBudgetCap,
    pendingChangesCount,
    filteredMessages,
    handleCreateChat,
    handleCycleMode,
    handleCloseSearch
  }
}

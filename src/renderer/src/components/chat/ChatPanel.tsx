import { useState, useEffect, useRef } from 'react'
import { Search, X, Bot, ClipboardList, Hammer, Skull } from 'lucide-react'
import { useChatStore, useChatActions, useWorkspaceStore, useCodeChangesStore } from '@renderer/store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  RepoWarningBanner,
  RateLimitBadge
} from '@renderer/components/chat'
import SessionRecoveryBanner from './SessionRecoveryBanner'
import BudgetCapBanner from './BudgetCapBanner'
import NewChatPage from './NewChatPage'
import PersonaSelector from './PersonaSelector'
import ChatTabButton from './ChatTabButton'
import CodeChangesPanel from './CodeChangesPanel'
import McpPill from './McpPill'
import EffortPill from './EffortPill'
import TodoTaskBar from './TodoTaskBar'
import { StackDriftBanner, BuildProgressInline, GenerateSpecialistModal } from '@renderer/components/specialist'
import type { ConversationMode } from '../../../../shared/types'
import { useChatPanelEffects } from './useChatPanelEffects'
import { useRateLimitState } from './useRateLimitState'
import { useSessionRecoveryState } from './useSessionRecoveryState'
import { useMcpIntegrations } from './useMcpIntegrations'

type ChatTab = 'chat' | 'code-changes'

interface ChatPanelProps {
  onCreateIdea?: (data: { title: string; description?: string }) => void
  onStartGrillMe?: () => Promise<void>
  showNewChat?: boolean
  onNewChatDismiss?: () => void
  onNavigateToSettings?: () => void
}

export default function ChatPanel({
  onCreateIdea,
  onStartGrillMe,
  showNewChat,
  onNewChatDismiss,
  onNavigateToSettings
}: ChatPanelProps): React.JSX.Element {
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

  // ── Extracted hooks ──
  const { projectSpecialist, generateModalOpen, handleDismissGenerate } = useChatPanelEffects()
  const { rateLimitState } = useRateLimitState()
  const { sessionRecovery } = useSessionRecoveryState()
  const { availableMcpIntegrations, handleMcpToggle } = useMcpIntegrations()

  // Budget cap banner state
  const budgetCapBanner = useChatStore((s) => s.budgetCapBanner)
  const continuePastBudgetCap = useChatStore((s) => s.continuePastBudgetCap)
  const dismissBudgetCap = useChatStore((s) => s.dismissBudgetCap)

  // Code changes count for tab badge
  const pendingChangesCount = useCodeChangesStore((s) => s.files.length)

  // Load code changes when conversation changes
  const loadFiles = useCodeChangesStore((s) => s.loadFiles)
  useEffect(() => {
    if (activeConversation?.id) {
      void loadFiles(activeConversation.id)
    }
  }, [activeConversation?.id, loadFiles])

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus()
    }
  }, [showSearch])

  // Reset tab when conversation changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on conversation switch
    setActiveTab('chat')
  }, [activeConversation?.id])

  // Load context usage when conversation changes or streaming ends.
  // Delayed re-fetch after stream ends catches post-compaction state.
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

  // ⌘F / Ctrl+F toggle for search
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

  const handleCreateChat = async (data: {
    title: string
    description?: string
    mode: ConversationMode
    communicationTone?: import('../../../../shared/types').CommunicationTone | null
    attachments?: string[]
    useIsolatedBranch?: boolean
    llmProvider?: string
    mcpOverrides?: Record<string, boolean>
  }): Promise<void> => {
    if (!activeWorkspace) return
    await createConversation(
      activeWorkspace.id,
      data.mode,
      data.title,
      undefined,
      (data.llmProvider as import('../../../../shared/types').LLMProvider) ?? undefined,
      data.mcpOverrides,
      data.communicationTone
    )
    onNewChatDismiss?.()
    if (data.useIsolatedBranch) {
      console.info(
        '[NewConversationModal] Isolated branch requested — worktree integration pending'
      )
    }
    if (data.description) {
      sendMessage(data.description, data.attachments)
    }
  }

  // Generate-Specialist modal — lifted above early returns so it overlays the
  // empty state and NewChatPage as well as the main chat render.
  const generateModal = activeWorkspace ? (
    <GenerateSpecialistModal
      open={generateModalOpen}
      workspaceId={activeWorkspace.id}
      workspaceName={activeWorkspace.name}
      onDismiss={handleDismissGenerate}
    />
  ) : null

  // Workspace selected but no active conversation
  if (!activeConversation) {
    if (showNewChat) {
      return (
        <>
          {generateModal}
          <NewChatPage onCreateChat={handleCreateChat} onCreateIdea={onCreateIdea} />
        </>
      )
    }
    return (
      <>
        {generateModal}
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 bg-surface-raised">
          <p className="text-sm text-text-secondary">
            Select a conversation from the sidebar or start a new one.
          </p>
        </div>
      </>
    )
  }

  // Filter messages for search
  const filteredMessages = searchQuery
    ? messages.filter((m) => m.contentMd.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  return (
    <>
      {generateModal}
      <div className="flex-1 flex flex-col bg-surface-raised min-w-0 min-h-0">
        {/* Header — tabs left, persona right */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-raised">
          <div className="flex items-center gap-1" role="tablist" aria-label="Chat panel tabs">
            <ChatTabButton active={activeTab === 'chat'} onClick={() => setActiveTab('chat')}>
              Chat
            </ChatTabButton>
            <ChatTabButton
              active={activeTab === 'code-changes'}
              onClick={() => setActiveTab('code-changes')}
              badge={pendingChangesCount}
            >
              Code Changes
            </ChatTabButton>
          </div>
          {activeTab === 'chat' && (
            <div className="flex items-center gap-2">
              <BuildProgressInline specialistId={projectSpecialist?.id ?? null} />
              <PersonaSelector conversation={activeConversation} />
            </div>
          )}
        </div>

        {/* Stack drift banner */}
        {activeTab === 'chat' && activeWorkspace?.id && (
          <div className="px-6 pt-2">
            <StackDriftBanner workspaceId={activeWorkspace.id} />
          </div>
        )}

        {/* Rate limit warning banner */}
        {rateLimitState && rateLimitState.status !== 'allowed' && (
          <div className="px-6 py-2 border-b border-border-subtle">
            <RateLimitBadge
              utilization={rateLimitState.utilization ?? 0}
              status={rateLimitState.status}
            />
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'chat' && (
          <>
            {/* Search bar */}
            {showSearch && (
              <div className="flex items-center gap-2 px-6 py-2 border-b border-border-subtle bg-surface-overlay/60">
                <Search size={14} className="text-text-muted" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search messages..."
                  className="flex-1 bg-transparent text-sm text-text-body placeholder-text-muted outline-none"
                  aria-label="Search messages"
                />
                {searchQuery && (
                  <span className="text-xs text-text-secondary">
                    {filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}
                  </span>
                )}
                <button
                  onClick={() => {
                    setShowSearch(false)
                    setSearchQuery('')
                  }}
                  className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
                  aria-label="Close search"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <RepoWarningBanner onNavigateToSettings={onNavigateToSettings} />

            {sessionRecovery && (
              <SessionRecoveryBanner
                phase={sessionRecovery.phase}
                message={sessionRecovery.message}
              />
            )}

            {budgetCapBanner && (
              <BudgetCapBanner
                message={budgetCapBanner.message}
                canContinue={budgetCapBanner.canContinue}
                onContinue={continuePastBudgetCap}
                onDismiss={dismissBudgetCap}
              />
            )}

            {agentStatus === 'starting' ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                <div className="relative mb-6">
                  <div className="w-16 h-16 rounded-full border-2 border-primary/30 animate-ping absolute inset-0" />
                  <div className="w-16 h-16 rounded-full bg-primary-muted border border-primary/40 flex items-center justify-center relative">
                    <Bot size={28} className="text-primary-text animate-pulse" />
                  </div>
                </div>
                <h3 className="text-lg font-medium text-text-primary mb-2">
                  Initializing AI Agent...
                </h3>
                <p className="text-sm text-text-secondary max-w-sm">
                  Setting up the workspace context and initializing the AI agent. This may take a
                  few seconds.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce" />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <MessageList searchQuery={searchQuery} />
              </div>
            )}

            {/* Floating pill bar — mode pill + MCP pills overlaid above input */}
            {activeConversation && (
              <div className="flex items-center justify-center gap-2 py-2 pointer-events-none">
                <button
                  onClick={() => {
                    const cycle: Record<ConversationMode, ConversationMode> = {
                      plan: 'build',
                      build: 'danger',
                      danger: 'plan'
                    }
                    updateMode(cycle[activeConversation.mode])
                  }}
                  className={`pointer-events-auto inline-flex items-center gap-2 px-5 py-1.5 rounded-full text-sm font-semibold border-2 shadow-lg backdrop-blur-sm transition-all cursor-pointer hover:scale-105 ${
                    activeConversation.mode === 'plan'
                      ? 'bg-mode-plan-muted/80 text-mode-plan-text border-mode-plan-border'
                      : activeConversation.mode === 'build'
                        ? 'bg-mode-build-muted/80 text-mode-build-text border-mode-build-border'
                        : 'bg-mode-danger-muted/80 text-mode-danger-text border-mode-danger-border'
                  }`}
                  title="Click to cycle mode"
                >
                  {activeConversation.mode === 'plan' ? (
                    <>
                      <ClipboardList size={16} /> Plan Mode
                    </>
                  ) : activeConversation.mode === 'build' ? (
                    <>
                      <Hammer size={16} /> Build Mode
                    </>
                  ) : (
                    <>
                      <Skull size={16} /> Danger Mode
                    </>
                  )}
                </button>

                <EffortPill
                  effort={effortLevels[activeConversation.id] ?? 'medium'}
                  onChange={(effort) => setEffort(activeConversation.id, effort)}
                  disabled={isStreaming}
                />

                {availableMcpIntegrations.map((integration) => (
                  <McpPill
                    key={integration.id}
                    integration={integration}
                    active={!!activeConversation.mcpOverrides?.[integration.id]}
                    onToggle={() => handleMcpToggle(integration.id)}
                    disabled={isStreaming}
                  />
                ))}
              </div>
            )}

            {activeConversation && (
              <TodoTaskBar conversationId={activeConversation.id} />
            )}

            <div className="flex-shrink-0 px-6 pb-4 pt-2">
              <AttachmentDropzone
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                conversationId={activeConversation.id}
              >
                <MessageInput
                  attachments={attachments}
                  onClearAttachments={() => setAttachments([])}
                  onStartGrillMe={onStartGrillMe}
                />
              </AttachmentDropzone>
            </div>
          </>
        )}

        {activeTab === 'code-changes' && (
          <CodeChangesPanel
            conversationId={activeConversation.id}
            onNavigateToSettings={onNavigateToSettings}
          />
        )}
      </div>
    </>
  )
}

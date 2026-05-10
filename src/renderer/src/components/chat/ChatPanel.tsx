import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Bot, ClipboardList, Hammer } from 'lucide-react'
import {
  useChatStore,
  useChatActions,
  useWorkspaceStore,
  useCodeChangesStore,
  useSpecialistStore
} from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  RepoWarningBanner,
  RateLimitBadge
} from '@renderer/components/chat'
import SessionRecoveryBanner from './SessionRecoveryBanner'
import type { SessionRecoveryPhase } from './SessionRecoveryBanner'
import BudgetCapBanner from './BudgetCapBanner'
import NewChatPage from './NewChatPage'
import PersonaSelector from './PersonaSelector'
import ChatTabButton from './ChatTabButton'
import CodeChangesPanel from './CodeChangesPanel'
import McpPill from './McpPill'
import {
  StackDriftBanner,
  BuildProgressInline,
  GenerateSpecialistModal
} from '@renderer/components/specialist'
import type { ConversationMode } from '../../../../shared/types'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../shared/constants'
import type { ExternalMcpDefinition } from '../../../../shared/constants'

type ChatTab = 'chat' | 'code-changes'

interface ChatPanelProps {
  onCreateIdea?: (data: { title: string; description?: string }) => void
  onStartGrillMe?: () => Promise<void>
  showNewChat?: boolean
  onNewChatDismiss?: () => void
}

export default function ChatPanel({
  onCreateIdea,
  onStartGrillMe,
  showNewChat,
  onNewChatDismiss
}: ChatPanelProps): React.JSX.Element {
  const { activeWorkspace, agentStatus } = useWorkspaceStore()
  const { createConversation, sendMessage, loadContextUsage, updateMode } = useChatActions()
  const activeConversation = useChatStore((s) => s.activeConversation)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [attachments, setAttachments] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [activeTab, setActiveTab] = useState<ChatTab>('chat')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Load Project Specialist on workspace change
  const loadProjectSpecialist = useProjectSpecialistStore((s) => s.loadForWorkspace)
  const projectSpecialist = useProjectSpecialistStore((s) =>
    activeWorkspace?.id ? s.byWorkspace[activeWorkspace.id] : null
  )
  useEffect(() => {
    if (activeWorkspace?.id) void loadProjectSpecialist(activeWorkspace.id)
  }, [activeWorkspace?.id, loadProjectSpecialist])

  // Reload specialist store when project specialist becomes ready
  // so PersonaSelector can find it in the combobox
  const loadSpecialists = useSpecialistStore((s) => s.loadSpecialists)
  useEffect(() => {
    if (projectSpecialist?.buildStatus === 'ready') {
      void loadSpecialists()
    }
  }, [projectSpecialist?.buildStatus, loadSpecialists])

  // Generate-Specialist modal — auto-opens for pending/failed specialists,
  // session-dismissed Set prevents re-opening after "Maybe later".
  const [generateModalOpen, setGenerateModalOpen] = useState(false)
  const [dismissedWorkspaces] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const wsId = activeWorkspace?.id
    if (!wsId || !projectSpecialist) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- close modal when workspace unloads
      setGenerateModalOpen(false)
      return
    }
    if (dismissedWorkspaces.has(wsId)) return
    if (projectSpecialist.buildStatus === 'pending' || projectSpecialist.buildStatus === 'failed') {
      setGenerateModalOpen(true)
    } else {
      setGenerateModalOpen(false)
    }
  }, [activeWorkspace?.id, projectSpecialist, dismissedWorkspaces])

  const handleDismissGenerate = useCallback(() => {
    const wsId = activeWorkspace?.id
    if (wsId) dismissedWorkspaces.add(wsId)
    setGenerateModalOpen(false)
  }, [activeWorkspace, dismissedWorkspaces])

  // Code changes count for tab badge
  const pendingChangesCount = useCodeChangesStore((s) => s.files.length)

  // Rate limit state — listens to SDK rate limit events
  const [rateLimitState, setRateLimitState] = useState<{
    status: 'allowed' | 'allowed_warning' | 'rejected'
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

  // Session recovery state
  const sessionRecovery = useChatStore((s) => s.sessionRecovery)
  const setSessionRecovery = useChatStore((s) => s.setSessionRecovery)

  // Budget cap banner state
  const budgetCapBanner = useChatStore((s) => s.budgetCapBanner)
  const continuePastBudgetCap = useChatStore((s) => s.continuePastBudgetCap)
  const dismissBudgetCap = useChatStore((s) => s.dismissBudgetCap)

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
  // Delayed re-fetch after stream ends catches post-compaction state
  // in case the onPostCompact event arrives after the initial fetch.
  useEffect(() => {
    if (activeConversation?.id) {
      void loadContextUsage(activeConversation.id)
    }
    // Belt-and-suspenders: re-fetch 2s after streaming ends to capture
    // any post-compaction state the immediate fetch may have missed.
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

  // ── External MCP integrations — available pills ──
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

  // Toggle handler — persists to DB, updates store optimistically
  const handleMcpToggle = useCallback(
    async (mcpId: string): Promise<void> => {
      if (!activeConversation) return
      const current = activeConversation.mcpOverrides ?? {}
      const updated = { ...current, [mcpId]: !current[mcpId] }

      // Optimistic update
      const updatedConv = { ...activeConversation, mcpOverrides: updated }
      useChatStore.setState((state) => ({
        activeConversation: updatedConv,
        conversations: state.conversations.map((c) => (c.id === updatedConv.id ? updatedConv : c))
      }))

      // Persist
      await window.api.updateMcpOverrides({
        conversationId: activeConversation.id,
        overrides: updated
      })
    },
    [activeConversation]
  )

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
    attachments?: string[]
    useIsolatedBranch?: boolean
    llmProvider?: string
    mcpOverrides?: Record<string, boolean>
  }): Promise<void> => {
    if (!activeWorkspace) return

    // Pass per-conversation LLM provider — workspace setting is only the default,
    // not mutated on every chat creation.
    await createConversation(
      activeWorkspace.id,
      data.mode,
      data.title,
      undefined, // personaSpecialistId
      (data.llmProvider as import('../../../../shared/types').LLMProvider) ?? undefined,
      data.mcpOverrides
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
    // Empty state — no auto-show of NewChatPage
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

        {/* Stack drift banner — non-intrusive, only shown when drifted */}
        {activeTab === 'chat' && activeWorkspace?.id && (
          <div className="px-6 pt-2">
            <StackDriftBanner workspaceId={activeWorkspace.id} />
          </div>
        )}

        {/* Rate limit warning banner — only shows during warning/rejected */}
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

            {/* Repo/GitHub warning banner */}
            <RepoWarningBanner />

            {/* Session recovery banner */}
            {sessionRecovery && (
              <SessionRecoveryBanner
                phase={sessionRecovery.phase}
                message={sessionRecovery.message}
              />
            )}

            {/* Budget cap reached banner */}
            {budgetCapBanner && (
              <BudgetCapBanner
                message={budgetCapBanner.message}
                canContinue={budgetCapBanner.canContinue}
                onContinue={continuePastBudgetCap}
                onDismiss={dismissBudgetCap}
              />
            )}

            {/* Messages or initialization overlay */}
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
                {/* Mode pill */}
                <button
                  onClick={() => updateMode(activeConversation.mode === 'plan' ? 'build' : 'plan')}
                  className={`pointer-events-auto inline-flex items-center gap-2 px-5 py-1.5 rounded-full text-sm font-semibold border-2 shadow-lg backdrop-blur-sm transition-all cursor-pointer hover:scale-105 ${
                    activeConversation.mode === 'plan'
                      ? 'bg-mode-plan-muted/80 text-mode-plan-text border-mode-plan-border'
                      : 'bg-mode-build-muted/80 text-mode-build-text border-mode-build-border'
                  }`}
                  title="Click to switch mode"
                >
                  {activeConversation.mode === 'plan' ? (
                    <>
                      <ClipboardList size={16} /> Plan Mode
                    </>
                  ) : (
                    <>
                      <Hammer size={16} /> Build Mode
                    </>
                  )}
                </button>

                {/* External MCP pills — one per workspace-available integration */}
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

            {/* Input - pinned to bottom */}
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
          <CodeChangesPanel conversationId={activeConversation.id} />
        )}
      </div>
    </>
  )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Bot, ClipboardList, Hammer, Skull, AlertTriangle, Layers } from 'lucide-react'
import {
  useChatStore,
  useChatActions,
  useWorkspaceStore,
  useCodeChangesStore
} from '@renderer/store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  RepoWarningBanner,
  RateLimitBadge
} from '@renderer/components/chat'
import { IMAGE_ONLY_FALLBACK_PROMPT } from '@renderer/hooks'
import SessionRecoveryBanner from './SessionRecoveryBanner'
import BlockedByBanner from './BlockedByBanner'
import PermissionRetryBanner from './PermissionRetryBanner'
import BudgetCapBanner from './BudgetCapBanner'
import TurnLimitBanner from './TurnLimitBanner'
import NewChatPage from './NewChatPage'
import ChatTabButton from './ChatTabButton'
import CodeChangesPanel from './CodeChangesPanel'
import McpPill from './McpPill'
import EffortPill from './EffortPill'
import ContextUsageIndicator from './ContextUsageIndicator'
import TaskSummaryBadge from './TaskSummaryBadge'
import ChatExecutionPanel from './ChatExecutionPanel'
import { usePlanExecutionStore, type PlanExecution } from '@renderer/store/plan-execution.store'
import { StackDriftBanner, BuildProgressInline } from '@renderer/components/specialist'
import type { ConversationMode, ThinkingEffort } from '../../../../shared/types'
import type { SessionRecoveryPhase } from './SessionRecoveryBanner'
import { useChatPanelEffects } from './useChatPanelEffects'
import { useRateLimitState } from './useRateLimitState'
import { useApiRetryState } from './useApiRetryState'
import { useSessionRecoveryState } from './useSessionRecoveryState'
import { useMcpIntegrations } from './useMcpIntegrations'
import ApiRetryBanner from './ApiRetryBanner'
import ModelConfigPopover from './ModelConfigPopover'

type ChatTab = 'chat' | 'code-changes'

interface ChatPanelProps {
  onCreateIdea?: (data: { title: string; description?: string }) => void
  onStartGrillMe?: () => Promise<void>
  showNewChat?: boolean
  onNewChatDismiss?: () => void
  onNavigateToSettings?: () => void
}

// ── Mode configuration ───────────────────────────────────────────────────

const MODE_CONFIG: Record<
  ConversationMode,
  { icon: typeof ClipboardList; label: string; classes: string }
> = {
  plan: {
    icon: ClipboardList,
    label: 'Plan Mode',
    classes: 'bg-mode-plan-muted/80 text-mode-plan-text border-mode-plan-border'
  },
  build: {
    icon: Hammer,
    label: 'Build Mode',
    classes: 'bg-mode-build-muted/80 text-mode-build-text border-mode-build-border'
  },
  danger: {
    icon: Skull,
    label: 'Danger Mode',
    classes: 'bg-mode-danger-muted/80 text-mode-danger-text border-mode-danger-border'
  }
}

const MODE_CYCLE: Record<ConversationMode, ConversationMode> = {
  plan: 'build',
  build: 'danger',
  danger: 'plan'
}

// ── PanelToggleButton ────────────────────────────────────────────────────

function PanelToggleButton({
  panelOpen,
  onToggle,
  tasksDone,
  taskTotal,
  hasContent
}: {
  panelOpen: boolean
  onToggle: () => void
  tasksDone: number
  taskTotal: number
  hasContent: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="chat-panel-toggle"
      disabled={!hasContent}
      aria-expanded={panelOpen}
      aria-label={panelOpen ? 'Hide execution panel' : 'Show execution panel'}
      onClick={hasContent ? onToggle : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
        !hasContent
          ? 'opacity-30 cursor-not-allowed text-text-muted border-border-subtle'
          : panelOpen
            ? 'bg-accent/15 text-accent border-accent/30'
            : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover border-border-subtle'
      }`}
      title={
        !hasContent
          ? 'No plan or task content yet'
          : panelOpen
            ? 'Hide execution panel'
            : 'Show execution panel'
      }
    >
      <Layers size={14} />
      {taskTotal > 0 && (
        <span className="text-[10px] font-mono bg-surface-inset px-1 py-0.5 rounded">
          {tasksDone}/{taskTotal}
        </span>
      )}
    </button>
  )
}

// ── ModeCyclePill ────────────────────────────────────────────────────────

function ModeCyclePill({
  mode,
  onCycle
}: {
  mode: ConversationMode
  onCycle: () => void
}): React.JSX.Element {
  const { icon: Icon, label, classes } = MODE_CONFIG[mode]
  return (
    <button
      onClick={onCycle}
      className={`pointer-events-auto inline-flex items-center gap-2 px-5 py-1.5 rounded-full text-sm font-semibold border-2 shadow-lg backdrop-blur-sm transition-all cursor-pointer hover:scale-105 ${classes}`}
      title="Click to cycle mode"
    >
      <Icon size={16} /> {label}
    </button>
  )
}

// ── ChatPanelBanners ────────────────────────────────────────────────────

function ChatPanelBanners({
  activeTab,
  workspaceId,
  rateLimitState,
  apiRetry,
  sessionRecovery,
  budgetCapBanner,
  continuePastBudgetCap,
  dismissBudgetCap,
  blockedByBanner,
  switchToBlockingChat,
  stopBlockingChat,
  dismissBlockedBy,
  permissionRetry,
  retryAfterPermission,
  dismissPermissionRetry,
  turnLimitReached,
  continuePastTurnLimit,
  dismissTurnLimit,
  streamStalledConversationId,
  activeConversationId,
  isStreaming,
  dismissStallBanner
}: {
  activeTab: ChatTab
  workspaceId?: string
  rateLimitState: {
    utilization?: number
    status: 'allowed' | 'allowed_warning' | 'rejected'
  } | null
  apiRetry: { attempt: number; maxRetries: number; errorStatus?: number | null } | null
  sessionRecovery: { phase: SessionRecoveryPhase; message: string } | null
  budgetCapBanner: { message: string; canContinue: boolean } | null
  continuePastBudgetCap: () => void
  dismissBudgetCap: () => void
  blockedByBanner: { blockedConvTitle: string | undefined } | null
  switchToBlockingChat: () => void
  stopBlockingChat: () => void
  dismissBlockedBy: () => void
  permissionRetry: { conversationId: string } | null
  retryAfterPermission: () => void
  dismissPermissionRetry: () => void
  turnLimitReached: {
    continuable: boolean
    continuationsUsed: number
    continuationsMax: number
  } | null
  continuePastTurnLimit: () => void
  dismissTurnLimit: () => void
  streamStalledConversationId: string | null
  activeConversationId: string | undefined
  isStreaming: boolean
  dismissStallBanner: () => void
}): React.JSX.Element {
  return (
    <>
      {activeTab === 'chat' && workspaceId && (
        <div className="px-6 pt-2">
          <StackDriftBanner workspaceId={workspaceId} />
        </div>
      )}
      {rateLimitState && (
        <div className="px-6 py-2 border-b border-border-subtle">
          <RateLimitBadge
            utilization={rateLimitState.utilization ?? 0}
            status={rateLimitState.status}
          />
        </div>
      )}
      {apiRetry && (
        <ApiRetryBanner
          attempt={apiRetry.attempt}
          maxRetries={apiRetry.maxRetries}
          errorStatus={apiRetry.errorStatus ?? null}
        />
      )}
      {activeTab === 'chat' && sessionRecovery && (
        <SessionRecoveryBanner phase={sessionRecovery.phase} message={sessionRecovery.message} />
      )}
      {activeTab === 'chat' && budgetCapBanner && (
        <BudgetCapBanner
          message={budgetCapBanner.message}
          canContinue={budgetCapBanner.canContinue}
          onContinue={continuePastBudgetCap}
          onDismiss={dismissBudgetCap}
        />
      )}
      {activeTab === 'chat' && blockedByBanner && (
        <BlockedByBanner
          blockedConvTitle={blockedByBanner.blockedConvTitle}
          onSwitchTo={switchToBlockingChat}
          onStopAndRetry={stopBlockingChat}
          onDismiss={dismissBlockedBy}
        />
      )}
      {activeTab === 'chat' && permissionRetry && (
        <PermissionRetryBanner onRetry={retryAfterPermission} onDismiss={dismissPermissionRetry} />
      )}
      {activeTab === 'chat' && turnLimitReached && (
        <TurnLimitBanner
          continuable={turnLimitReached.continuable}
          continuationsUsed={turnLimitReached.continuationsUsed}
          continuationsMax={turnLimitReached.continuationsMax}
          onContinue={continuePastTurnLimit}
          onDismiss={dismissTurnLimit}
        />
      )}
      {/* STALL-DETECT-01: Warning banner when no real content received for 3 minutes */}
      {/* STALL-DETECT-06: Per-conversation guard — only show if THIS conversation is stalled */}
      {activeTab === 'chat' &&
        streamStalledConversationId === activeConversationId &&
        isStreaming && (
          <div
            data-testid="stream-stall-banner"
            className="mx-4 mt-2 flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-amber-300 animate-in fade-in slide-in-from-top-2 duration-300"
          >
            <AlertTriangle size={16} className="flex-shrink-0" />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">Stream may be stuck</span>
              <span className="text-xs opacity-70">
                No activity for 3 minutes — the agent may be stalled. Try clicking Stop.
              </span>
            </div>
            <button
              onClick={dismissStallBanner}
              className="flex-shrink-0 rounded p-1 text-amber-400/60 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
              aria-label="Dismiss stall warning"
            >
              <X size={14} />
            </button>
          </div>
        )}
    </>
  )
}

// ── FloatingPillBar ─────────────────────────────────────────────────────

function FloatingPillBar({
  conversation,
  isStreaming,
  effortLevel,
  mcpIntegrations,
  onCycleMode,
  onSetEffort,
  onMcpToggle
}: {
  conversation: { id: string; mode: ConversationMode; mcpOverrides?: Record<string, boolean> }
  isStreaming: boolean
  effortLevel: ThinkingEffort
  mcpIntegrations: React.ComponentProps<typeof McpPill>['integration'][]
  onCycleMode: () => void
  onSetEffort: (effort: ThinkingEffort) => void
  onMcpToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-2 pointer-events-none">
      <ModeCyclePill mode={conversation.mode} onCycle={onCycleMode} />

      <EffortPill effort={effortLevel} onChange={onSetEffort} disabled={isStreaming} />

      {mcpIntegrations.map((integration) => (
        <McpPill
          key={integration.id}
          integration={integration}
          active={!!conversation.mcpOverrides?.[integration.id]}
          onToggle={() => onMcpToggle(integration.id)}
          disabled={isStreaming}
        />
      ))}
    </div>
  )
}

// ── useChatPanelLocalEffects ────────────────────────────────────────────

function useChatPanelLocalEffects({
  conversationId,
  isStreaming,
  showSearch,
  searchInputRef,
  loadFiles,
  loadContextUsage,
  setActiveTab,
  setShowSearch
}: {
  conversationId: string | undefined
  isStreaming: boolean
  showSearch: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  loadFiles: (id: string) => Promise<void>
  loadContextUsage: (id: string) => Promise<void>
  setActiveTab: (tab: ChatTab) => void
  setShowSearch: React.Dispatch<React.SetStateAction<boolean>>
}): void {
  useEffect(() => {
    if (conversationId) {
      useCodeChangesStore.getState().resetComparison()
      void loadFiles(conversationId)
    }
  }, [conversationId, loadFiles])

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus()
  }, [showSearch, searchInputRef])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab('chat')
  }, [conversationId, setActiveTab])

  useEffect(() => {
    if (conversationId) void loadContextUsage(conversationId)
    if (!isStreaming && conversationId) {
      const timer = setTimeout(() => void loadContextUsage(conversationId), 2000)
      return (): void => {
        clearTimeout(timer)
      }
    }
    return undefined
  }, [conversationId, isStreaming, loadContextUsage])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setShowSearch])
}

// ── EmptyConversationState ──────────────────────────────────────────────

function EmptyConversationState({
  showNewChat,
  onCreateChat,
  onCreateIdea
}: {
  showNewChat?: boolean
  onCreateChat: (data: {
    title: string
    description?: string
    mode: ConversationMode
    communicationTone?: import('../../../../shared/types').CommunicationTone | null
    attachments?: string[]
    branchName?: string
    autoBranch?: boolean
    takeover?: boolean
    llmProvider?: string
    mcpOverrides?: Record<string, boolean>
    sourceAuditRunId?: string
  }) => Promise<void>
  onCreateIdea?: (data: { title: string; description?: string }) => void
}): React.JSX.Element {
  if (showNewChat) {
    return <NewChatPage onCreateChat={onCreateChat} onCreateIdea={onCreateIdea} />
  }
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8 bg-surface-raised">
      <p className="text-sm text-text-secondary">
        Select a conversation from the sidebar or start a new one.
      </p>
    </div>
  )
}

// ── ChatPanel ───────────────────────────────────────────────────────────

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

  // ── Execution panel state (persisted to localStorage) ──
  const [panelOpen, setPanelOpen] = useState(() => {
    const saved = localStorage.getItem('chat-panel-open')
    return saved === 'true'
  })
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('chat-panel-width')
    return saved ? Math.min(800, Math.max(280, parseInt(saved, 10))) : 360
  })

  useEffect(() => {
    localStorage.setItem('chat-panel-open', String(panelOpen))
  }, [panelOpen])

  // ── Auto-open panel when first plan arrives ──
  const latestPlan = usePlanExecutionStore(
    useCallback(
      (s: { latestPlanContent: Record<string, string> }) =>
        activeConversation ? (s.latestPlanContent[activeConversation.id] ?? null) : null,
      [activeConversation?.id]
    )
  )
  const prevLatestPlanRef = useRef(latestPlan)
  const [autoOpenedForPlan, setAutoOpenedForPlan] = useState(false)

  // ── Header panel toggle data ──
  const headerExecution = usePlanExecutionStore(
    useCallback(
      (s: { executions: Record<string, PlanExecution> }) =>
        activeConversation ? s.executions[activeConversation.id] : undefined,
      [activeConversation?.id]
    )
  )
  const headerAllTasks = headerExecution?.phases.flatMap((p) => p.tasks) ?? []
  const headerTasksDone = headerAllTasks.filter(
    (t) => t.status === 'complete' || t.status === 'skipped'
  ).length
  const headerTaskTotal = headerAllTasks.length
  const headerHasContent = !!latestPlan || headerTaskTotal > 0

  // Reset plan tracking on conversation switch to prevent false auto-opens
  useEffect(() => {
    prevLatestPlanRef.current = latestPlan
  }, [activeConversation?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset autoOpenedForPlan on conversation change (separate from ref reset to avoid setState-in-effect lint)
  const prevConvIdRef = useRef(activeConversation?.id)
  if (prevConvIdRef.current !== activeConversation?.id) {
    prevConvIdRef.current = activeConversation?.id
    if (autoOpenedForPlan) setAutoOpenedForPlan(false)
  }

  useEffect(() => {
    // Auto-open panel when plan content appears for the first time
    if (latestPlan && !prevLatestPlanRef.current && !panelOpen) {
      setPanelOpen(true)
      setAutoOpenedForPlan(true)
    }
    prevLatestPlanRef.current = latestPlan
  }, [latestPlan]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Narrow viewport guard ──
  useEffect(() => {
    if (!panelOpen) return
    const check = (): void => {
      if (window.innerWidth - panelWidth < 360) {
        setPanelOpen(false)
      }
    }
    window.addEventListener('resize', check)
    check() // initial check
    return () => window.removeEventListener('resize', check)
  }, [panelOpen, panelWidth])

  // ── Extracted hooks ──
  const { projectSpecialist } = useChatPanelEffects()
  const { rateLimitState } = useRateLimitState()
  const { apiRetry } = useApiRetryState()
  const { sessionRecovery } = useSessionRecoveryState()
  const { availableMcpIntegrations, handleMcpToggle } = useMcpIntegrations()

  // Budget cap banner state
  const budgetCapBanner = useChatStore((s) => s.budgetCapBanner)
  const continuePastBudgetCap = useChatStore((s) => s.continuePastBudgetCap)
  const dismissBudgetCap = useChatStore((s) => s.dismissBudgetCap)

  // Blocked-by banner state (MULTI-CHAT-04)
  const blockedByBanner = useChatStore((s) => s.blockedByBanner)
  const switchToBlockingChat = useChatStore((s) => s.switchToBlockingChat)
  const stopBlockingChat = useChatStore((s) => s.stopBlockingChat)
  const dismissBlockedBy = useChatStore((s) => s.dismissBlockedBy)

  // Retry offer after a permission request died with its turn
  const permissionRetry = useChatStore((s) => s.permissionRetry)
  const retryAfterPermission = useChatStore((s) => s.retryAfterPermission)
  const dismissPermissionRetry = useChatStore((s) => s.dismissPermissionRetry)

  // Turn limit banner state
  const turnLimitReached = useChatStore((s) => s.turnLimitReached)
  const continuePastTurnLimit = useChatStore((s) => s.continuePastTurnLimit)
  const dismissTurnLimit = useChatStore((s) => s.dismissTurnLimit)

  // STALL-DETECT-01: Stall detection banner (per-conversation)
  const streamStalledConversationId = useChatStore((s) => s.streamStalledConversationId)
  const dismissStallBanner = useChatStore((s) => s.dismissStallBanner)

  // Code changes count for tab badge
  const pendingChangesCount = useCodeChangesStore((s) => s.files.length)
  const loadFiles = useCodeChangesStore((s) => s.loadFiles)

  // ── Side effects ──
  useChatPanelLocalEffects({
    conversationId: activeConversation?.id,
    isStreaming,
    showSearch,
    searchInputRef,
    loadFiles,
    loadContextUsage,
    setActiveTab,
    setShowSearch
  })

  const handleCreateChat = async (data: {
    title: string
    description?: string
    mode: ConversationMode
    communicationTone?: import('../../../../shared/types').CommunicationTone | null
    attachments?: string[]
    branchName?: string
    autoBranch?: boolean
    takeover?: boolean
    llmProvider?: string
    routingOverrides?: Partial<import('../../../../shared/types').ModelRoleMap>
    mcpOverrides?: Record<string, boolean>
    sourceAuditRunId?: string
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
      data.communicationTone,
      data.sourceAuditRunId,
      data.branchName,
      data.autoBranch,
      data.takeover
    )
    onNewChatDismiss?.()
    // Send when there is a description OR attachments — an image-only creation
    // (title + pasted screenshot, no text) must not silently drop the image.
    const body = data.description?.trim() ?? ''
    const hasAttachments = (data.attachments?.length ?? 0) > 0
    if (body || hasAttachments) {
      sendMessage(body || IMAGE_ONLY_FALLBACK_PROMPT, data.attachments)
    }
  }

  // Workspace selected but no active conversation
  if (!activeConversation) {
    return (
      <EmptyConversationState
        showNewChat={showNewChat}
        onCreateChat={handleCreateChat}
        onCreateIdea={onCreateIdea}
      />
    )
  }

  // Filter messages for search
  const filteredMessages = searchQuery
    ? messages.filter(
        (m) => !m.hidden && m.contentMd.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : []

  return (
    <div
      data-testid="chat-panel"
      className="flex-1 flex flex-col bg-surface-raised min-w-0 min-h-0"
    >
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
            {activeConversation && <ContextUsageIndicator conversationId={activeConversation.id} />}
            <ModelConfigPopover
              snapshot={activeConversation?.modelConfigSnapshot ?? null}
              providerLabel={activeConversation?.llmProvider === 'local-llm' ? 'Local' : 'Claude'}
              conversationId={activeConversation?.id}
              workspaceId={activeWorkspace?.id}
              onRoutingUpdated={(updated) => {
                useChatStore.setState((state) => ({
                  activeConversation:
                    state.activeConversation?.id === updated.id
                      ? updated
                      : state.activeConversation,
                  conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c))
                }))
              }}
            />
            <BuildProgressInline specialistId={projectSpecialist?.id ?? null} />
            <PanelToggleButton
              panelOpen={panelOpen}
              onToggle={() => {
                setPanelOpen(!panelOpen)
                setAutoOpenedForPlan(false)
              }}
              tasksDone={headerTasksDone}
              taskTotal={headerTaskTotal}
              hasContent={headerHasContent}
            />
          </div>
        )}
      </div>

      {/* Banners */}
      <ChatPanelBanners
        activeTab={activeTab}
        workspaceId={activeWorkspace?.id}
        rateLimitState={rateLimitState}
        apiRetry={apiRetry}
        sessionRecovery={sessionRecovery}
        budgetCapBanner={budgetCapBanner}
        continuePastBudgetCap={continuePastBudgetCap}
        dismissBudgetCap={dismissBudgetCap}
        blockedByBanner={blockedByBanner}
        switchToBlockingChat={switchToBlockingChat}
        stopBlockingChat={stopBlockingChat}
        dismissBlockedBy={dismissBlockedBy}
        permissionRetry={permissionRetry}
        retryAfterPermission={retryAfterPermission}
        dismissPermissionRetry={dismissPermissionRetry}
        turnLimitReached={turnLimitReached}
        continuePastTurnLimit={continuePastTurnLimit}
        dismissTurnLimit={dismissTurnLimit}
        streamStalledConversationId={streamStalledConversationId}
        activeConversationId={activeConversation?.id}
        isStreaming={isStreaming}
        dismissStallBanner={dismissStallBanner}
      />

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

          <div
            className="flex-1 flex min-h-0"
            style={
              panelOpen
                ? { display: 'grid', gridTemplateColumns: `minmax(0,1fr) ${panelWidth}px` }
                : undefined
            }
          >
            {/* Column 1: Chat */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
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
                <FloatingPillBar
                  conversation={activeConversation}
                  isStreaming={isStreaming}
                  effortLevel={effortLevels[activeConversation.id] ?? ('medium' as const)}
                  mcpIntegrations={availableMcpIntegrations}
                  onCycleMode={() => updateMode(MODE_CYCLE[activeConversation.mode])}
                  onSetEffort={(effort) => setEffort(activeConversation.id, effort)}
                  onMcpToggle={handleMcpToggle}
                />
              )}

              {activeConversation && (
                <TaskSummaryBadge
                  conversationId={activeConversation.id}
                  panelOpen={panelOpen}
                  onTogglePanel={() => {
                    setPanelOpen(!panelOpen)
                    setAutoOpenedForPlan(false)
                  }}
                />
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
            </div>

            {/* Column 2: Execution Panel (collapsible) */}
            {panelOpen && activeConversation && (
              <ChatExecutionPanel
                key={activeConversation.id}
                conversationId={activeConversation.id}
                initialTab={autoOpenedForPlan ? 'plan' : undefined}
                onClose={() => {
                  setPanelOpen(false)
                  setAutoOpenedForPlan(false)
                }}
                onResize={(width) => {
                  setPanelWidth(width)
                  localStorage.setItem('chat-panel-width', String(width))
                }}
              />
            )}
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
  )
}

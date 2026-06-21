import { useState, useEffect, useCallback } from 'react'
import { Home, Sliders, CircleHelp, Bug } from 'lucide-react'
import { Sidebar, UnifiedSidebar } from '@renderer/components/layout'
import { ChatPanel } from '@renderer/components/chat'
import { WorkspaceSettingsContent } from '@renderer/components/workspace'
import type { SettingsTab } from '@renderer/components/workspace/WorkspaceSettingsPanel'
import { SettingsPage } from '@renderer/components/settings'
import { HelpView } from '@renderer/components/help'
import { WelcomeScreen } from '@renderer/components/welcome'
import {
  UpdateBanner,
  MemoryFeedBanner,
  BudgetWarningBanner,
  ErrorBoundary,
  ToastContainer,
  TokenDetailsModal
} from '@renderer/components/common'
import { NotificationStack } from '@renderer/components/notifications'
import { useBackgroundSessionListeners } from '@renderer/hooks/useBackgroundSessionListeners'
import { BugTrackerPage } from '@renderer/components/bugs'
import {
  useWorkspaceStore,
  useAgentStore,
  useChatStore,
  useChatActions,
  useConversationSpecialistActions,
  useSpecialistStore,
  useBugStore,
  useAuditStore,
  useIndexingStore,
  useMpaStore
} from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'

import StatusBar from './StatusBar'
import {
  useAppKeyboardShortcuts,
  useAppZoom,
  useBranchIndicator,
  useGrillStatus,
  useWorkspaceListeners,
  useNavigationHandlers
} from './hooks'

const isMac = navigator.platform.toUpperCase().includes('MAC')

// ── useAppLayoutEffects ───────────────────────────────────────────────

function useAppLayoutEffects({
  activeConversation,
  workspaceSpecialistsLength,
  loadSpecialists,
  hydrateConversationSpecialists,
  setShowNewChat,
  setAppVersion
}: {
  activeConversation: { id: string } | null
  workspaceSpecialistsLength: number
  loadSpecialists: () => Promise<void>
  hydrateConversationSpecialists: (id: string) => Promise<void>
  setShowNewChat: (v: boolean) => void
  setAppVersion: (v: string) => void
}): void {
  // Load app version
  useEffect(() => {
    window.api.getPlatformInfo().then((info) => setAppVersion(info.appVersion))
  }, [setAppVersion])

  // Auto-reset showNewChat when a conversation is selected
  useEffect(() => {
    if (activeConversation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowNewChat(false)
    }
  }, [activeConversation, setShowNewChat])

  // Load workspace specialists if empty
  useEffect(() => {
    if (workspaceSpecialistsLength === 0) {
      void loadSpecialists().catch(() => undefined)
    }
  }, [workspaceSpecialistsLength, loadSpecialists])

  // Hydrate conversation specialists
  useEffect(() => {
    if (!activeConversation?.id) return
    void hydrateConversationSpecialists(activeConversation.id).catch((error) => {
      console.error('[AppLayout] Failed to hydrate conversation specialists:', error)
    })
  }, [activeConversation?.id, hydrateConversationSpecialists])
}

// ── HeaderIconButton ─────────────────────────────────────────────────

function HeaderIconButton({
  icon: Icon,
  isActive,
  onClick,
  title,
  ariaLabel,
  badge
}: {
  icon: typeof Home
  isActive: boolean
  onClick: () => void
  title: string
  ariaLabel: string
  badge?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative p-2.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
        isActive
          ? 'text-primary-text bg-surface-overlay'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
      }`}
      title={title}
      aria-label={ariaLabel}
    >
      <Icon size={16} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 text-[9px] font-bold bg-red-500 text-white rounded-full">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

// ── AppLayout ─────────────────────────────────────────────────────────

export default function AppLayout(): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<'chat' | 'app-settings' | 'help' | 'bugs'>('chat')
  const [sidebarView, setSidebarView] = useState<'chat' | 'settings'>('chat')
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState<SettingsTab>('ideas')
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const agentStatus = useWorkspaceStore((s) => s.agentStatus)
  const sessionOutputTokens = useAgentStore((s) => s.sessionOutputTokens)
  const contextWindowTokens = useAgentStore((s) => s.contextWindowTokens)
  const { updateMode, setCompactSuggestion } = useChatActions()
  const [tokenModalOpen, setTokenModalOpen] = useState(false)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const { hydrateConversationSpecialists } = useConversationSpecialistActions()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [showNewChat, setShowNewChat] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const repoInfo = useWorkspaceStore((s) => s.repoInfo)
  const [pendingGrill, setPendingGrill] = useState<{
    ideaId: string
    conversationId: string
    ideaTitle: string
    ideaDescription?: string
    isNewSession?: boolean
  } | null>(null)

  // Multi-workspace: listen for background session status + permission events
  useBackgroundSessionListeners()

  // ── Extracted hooks ──
  const zoomFactor = useAppZoom()
  const { currentBranch, isGitRepo } = useBranchIndicator(
    activeWorkspace,
    activeConversation,
    repoInfo
  )
  const grillStatus = useGrillStatus(activeWorkspace?.id)
  useWorkspaceListeners(activeWorkspace, setWorkspaceSettingsTab, setSidebarView)
  const {
    handleGoHome,
    handleNavigateToChat,
    handleFixInNewChat,
    handleCreateIdea,
    handleStartGrillMe,
    handleNavigateToGrill,
    handleSendPlanToGrill
  } = useNavigationHandlers(
    activeWorkspace,
    activeConversation,
    setView,
    setSidebarView,
    setWorkspaceSettingsTab,
    setShowNewChat,
    setPendingGrill
  )

  const mpaStatus = useMpaStore((s) =>
    s.isRunning || s.status.status === 'paused' ? s.status : null
  )
  const councilPhase = useCouncilStore((s) => (s.isActive ? s.phase : null))

  // Bug tracker + audit status for UI
  const unresolvedBugCount = useBugStore((s) => s.unresolvedCount)
  const auditRunning = useAuditStore((s) => s.isRunning)
  const auditRerunning = useAuditStore((s) => s.rerunningTrackId)
  const isAuditActive = auditRunning || !!auditRerunning
  const isAuditPaused = useAuditStore((s) => s.isPaused)
  const lastAuditScore = useAuditStore((s) => s.currentRun?.overallScore ?? null)

  // MCP tools from Da Vinci status
  const activeMcpTools = useAgentStore((s) => {
    const davinci = s.statuses.find((st) => st.agentType === 'da-vinci')
    return davinci?.activeMcpTools
  })

  // Context usage for status bar
  const contextUsage = useChatStore((s) =>
    s.activeConversation ? s.contextUsages[s.activeConversation.id] : undefined
  )
  const indexingState = useIndexingStore((s) => s.indexingState)

  const handleZoomIn = useCallback(() => {
    window.api.zoomIn()
  }, [])
  const handleZoomOut = useCallback(() => {
    window.api.zoomOut()
  }, [])
  const handleZoomReset = useCallback(() => {
    window.api.zoomReset()
  }, [])

  const workspaceSpecialists = useSpecialistStore((state) => state.specialists)
  const loadSpecialists = useSpecialistStore((state) => state.loadSpecialists)

  // ── Side effects ──
  useAppLayoutEffects({
    activeConversation,
    workspaceSpecialistsLength: workspaceSpecialists.length,
    loadSpecialists,
    hydrateConversationSpecialists,
    setShowNewChat,
    setAppVersion
  })

  // Toggle a view — if already active, go to chat; otherwise switch to it
  const toggleView = useCallback(
    (target: 'app-settings' | 'help' | 'bugs') => {
      setView((current) => (current === target ? 'chat' : target))
    },
    []
  )

  // Navigate back — Esc key handler priority
  const navigateBack = useCallback(() => {
    if (view === 'help' || view === 'app-settings') {
      setView('chat')
      return
    }
    if (sidebarView === 'settings') {
      setSidebarView('chat')
    }
  }, [view, sidebarView])

  // Keyboard shortcuts — extracted to dedicated hook
  useAppKeyboardShortcuts({
    activeWorkspace,
    activeConversation,
    isStreaming,
    updateMode,
    navigateBack,
    setSidebarCollapsed,
    setView,
    setShowNewChat
  })

  const renderMainContent = (): React.JSX.Element => {
    if (view === 'bugs') {
      return <BugTrackerPage onBack={() => setView('chat')} />
    }
    if (view === 'help') {
      return <HelpView onBack={() => setView('chat')} />
    }
    if (view === 'app-settings') {
      return <SettingsPage onBack={() => setView('chat')} />
    }
    if (!activeWorkspace) {
      return <WelcomeScreen />
    }
    if (sidebarView === 'settings') {
      return (
        <WorkspaceSettingsContent
          tab={workspaceSettingsTab}
          onNavigateToChat={handleNavigateToChat}
          onFixInNewChat={handleFixInNewChat}
          onSettingsTabChange={(t) => setWorkspaceSettingsTab(t)}
          onSendPlanToGrill={handleSendPlanToGrill}
          pendingGrill={pendingGrill}
          onPendingGrillConsumed={() => setPendingGrill(null)}
        />
      )
    }
    return (
      <ChatPanel
        onCreateIdea={handleCreateIdea}
        onStartGrillMe={handleStartGrillMe}
        showNewChat={showNewChat}
        onNewChatDismiss={() => setShowNewChat(false)}
        onNavigateToSettings={() => {
          setWorkspaceSettingsTab('repository')
          setSidebarView('settings')
        }}
      />
    )
  }

  const showLeftSidebar = view === 'chat' && activeWorkspace !== null

  return (
    <div className="flex flex-col h-screen bg-surface-base">
      {/* Drag region for frameless window */}
      <div
        className={`h-10 flex-shrink-0 bg-surface-base border-b border-border-subtle flex items-center pr-4 relative ${isMac ? 'pl-[80px]' : 'pl-20'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-text-secondary pointer-events-none">
          Code Atelier
        </span>

        <div
          className="flex items-center gap-1.5 ml-auto relative z-10"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <HeaderIconButton icon={Home} isActive={false} onClick={handleGoHome} title="Home" ariaLabel="Home" />
          <HeaderIconButton icon={Sliders} isActive={view === 'app-settings'} onClick={() => toggleView('app-settings')} title="Settings" ariaLabel="Settings" />
          <HeaderIconButton icon={Bug} isActive={view === 'bugs'} onClick={() => toggleView('bugs')} title="Bug Tracker" ariaLabel="Bug Tracker" badge={unresolvedBugCount} />
          <HeaderIconButton icon={CircleHelp} isActive={view === 'help'} onClick={() => toggleView('help')} title={`Help (${isMac ? '⌘' : 'Ctrl+'}/)`} ariaLabel="Help" />
        </div>
      </div>

      <UpdateBanner />
      <MemoryFeedBanner />
      <BudgetWarningBanner />

      <div className="flex flex-1 min-h-0">
        {showLeftSidebar && (
          <Sidebar>
            <UnifiedSidebar
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
              onCreateIdea={handleCreateIdea}
              activeSettingsTab={workspaceSettingsTab}
              onSettingsTabChange={setWorkspaceSettingsTab}
              onViewChange={setSidebarView}
              onNewChat={() => setShowNewChat(true)}
            />
          </Sidebar>
        )}

        <ErrorBoundary>{renderMainContent()}</ErrorBoundary>
      </div>

      <ToastContainer onNavigate={(target) => setView(target as typeof view)} />
      <NotificationStack />

      <TokenDetailsModal
        isOpen={tokenModalOpen}
        workspaceId={activeWorkspace?.id ?? null}
        contextWindowTokens={contextWindowTokens}
        liveOutputTokens={sessionOutputTokens}
        onClose={() => setTokenModalOpen(false)}
      />

      <StatusBar
        activeWorkspace={activeWorkspace}
        agentStatus={agentStatus}
        appVersion={appVersion}
        currentBranch={currentBranch}
        isGitRepo={isGitRepo}
        activeMcpTools={activeMcpTools}
        contextUsage={contextUsage}
        contextWindowTokens={contextWindowTokens}
        sessionOutputTokens={sessionOutputTokens}
        zoomFactor={zoomFactor}
        isAuditActive={isAuditActive}
        isAuditPaused={isAuditPaused}
        lastAuditScore={lastAuditScore}
        grillStatus={grillStatus}
        mpaStatus={mpaStatus}
        councilPhase={councilPhase}
        indexingState={indexingState}
        sidebarView={sidebarView}
        onNavigateToSettings={(tab) => {
          setWorkspaceSettingsTab(tab as SettingsTab)
          setSidebarView('settings')
        }}
        onOpenContextModal={() => {
          if (contextUsage) {
            setCompactSuggestion({
              level: contextUsage.level,
              inputTokens: contextUsage.inputTokens,
              breakdown: contextUsage.breakdown,
              isLocalProvider: activeConversation?.llmProvider === 'local-llm'
            })
          }
        }}
        onOpenTokenModal={() => setTokenModalOpen(true)}
        onNavigateToGrill={handleNavigateToGrill}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />
    </div>
  )
}

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
  TokenDetailsModal,
  UnsavedChangesDialog
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
  useIndexingStore
} from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import { useBlueprintStore } from '@renderer/store/blueprint.store'

import StatusBar from './StatusBar'
import {
  useAppKeyboardShortcuts,
  useAppZoom,
  useBranchIndicator,
  useGrillStatus,
  useWorkspaceListeners,
  useNavigationHandlers
} from './hooks'
import { useBlueprintStatusBar } from './hooks/useBlueprintStatusBar'

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

  // ── Unsaved-changes navigation guard ──
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)

  const guardNavigation = useCallback(
    (action: () => void) => {
      const guard = useSettingsStore.getState().unsavedGuard
      if (guard?.isDirty()) {
        setPendingNav(() => action)
      } else {
        action()
      }
    },
    []
  )

  const guardedSetView = useCallback(
    (v: 'chat' | 'app-settings' | 'help' | 'bugs') => guardNavigation(() => setView(v)),
    [guardNavigation]
  )
  const guardedSetSidebarView = useCallback(
    (v: 'chat' | 'settings') => {
      // Only guard transitions AWAY from settings
      if (v !== 'settings') {
        guardNavigation(() => setSidebarView(v))
      } else {
        setSidebarView(v)
      }
    },
    [guardNavigation]
  )
  const guardedSetTab = useCallback(
    (t: SettingsTab) => guardNavigation(() => setWorkspaceSettingsTab(t)),
    [guardNavigation]
  )

  const handleNotificationNavigate = useCallback(
    (sidebar: 'chat' | 'settings', tab?: string) => {
      guardedSetSidebarView(sidebar)
      if (tab) guardedSetTab(tab as SettingsTab)
    },
    [guardedSetSidebarView, guardedSetTab]
  )

  const handleUnsavedSave = useCallback(async () => {
    const guard = useSettingsStore.getState().unsavedGuard
    if (guard) await guard.save()
    const action = pendingNav
    setPendingNav(null)
    action?.()
  }, [pendingNav])

  const handleUnsavedDiscard = useCallback(() => {
    const guard = useSettingsStore.getState().unsavedGuard
    if (guard) guard.discard()
    const action = pendingNav
    setPendingNav(null)
    action?.()
  }, [pendingNav])

  const handleUnsavedCancel = useCallback(() => {
    setPendingNav(null)
  }, [])

  // ── Pending onboard: auto-navigate to Blueprints tab ──
  const pendingOnboard = useBlueprintStore((s) => s.pendingOnboard)
  useEffect(() => {
    if (
      activeWorkspace &&
      pendingOnboard?.workspaceId === activeWorkspace.id
    ) {
      // Direct navigation — fresh workspace has no unsaved state
      setSidebarView('settings')
      setWorkspaceSettingsTab('blueprints')
    }
  }, [activeWorkspace, pendingOnboard])

  // ── Extracted hooks ──
  const zoomFactor = useAppZoom()
  const { currentBranch, isGitRepo } = useBranchIndicator(
    activeWorkspace,
    activeConversation,
    repoInfo
  )
  const grillStatus = useGrillStatus(activeWorkspace?.id)
  useWorkspaceListeners(activeWorkspace, guardedSetTab, guardedSetSidebarView)
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
    guardedSetView,
    guardedSetSidebarView,
    guardedSetTab,
    setShowNewChat,
    setPendingGrill
  )

  // Blueprint status for StatusBar indicator
  const blueprintStatus = useBlueprintStatusBar()
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  const handleNavigateToBlueprint = useCallback(() => {
    guardedSetSidebarView('settings')
    guardedSetTab('blueprints')
  }, [guardedSetSidebarView, guardedSetTab])

  const handleSwitchToWorkspaceBlueprint = useCallback(
    async (workspaceId: string) => {
      await openWorkspace(workspaceId)
      setSidebarView('settings')
      setWorkspaceSettingsTab('blueprints')
    },
    [openWorkspace]
  )

  // Bug tracker + audit status for UI
  const unresolvedBugCount = useBugStore((s) => s.unresolvedCount)
  const auditRunning = useAuditStore((s) => s.isRunning)
  const auditRerunning = useAuditStore((s) => s.rerunningTrackId)
  const isAuditActive = auditRunning || !!auditRerunning
  const isAuditPaused = useAuditStore((s) => s.isPaused)
  const lastAuditScore = useAuditStore((s) => s.currentRun?.overallScore ?? null)

  // MCP tools from specialist status
  const activeMcpTools = useAgentStore((s) => {
    const specialist = s.statuses.find((st) => st.agentType === 'specialist')
    return specialist?.activeMcpTools
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
      // Can't use the updater form with guardNavigation, so read current view
      guardNavigation(() => setView((current) => (current === target ? 'chat' : target)))
    },
    [guardNavigation]
  )

  // Navigate back — Esc key handler priority
  const navigateBack = useCallback(() => {
    if (view === 'help' || view === 'app-settings') {
      guardedSetView('chat')
      return
    }
    if (sidebarView === 'settings') {
      guardedSetSidebarView('chat')
    }
  }, [view, sidebarView, guardedSetView, guardedSetSidebarView])

  // Keyboard shortcuts — extracted to dedicated hook
  useAppKeyboardShortcuts({
    activeWorkspace,
    activeConversation,
    isStreaming,
    updateMode,
    navigateBack,
    view,
    setSidebarCollapsed,
    setView: guardedSetView,
    setShowNewChat
  })

  const renderMainContent = (): React.JSX.Element => {
    if (view === 'bugs') {
      return <BugTrackerPage onBack={() => guardedSetView('chat')} />
    }
    if (view === 'help') {
      return <HelpView onBack={() => guardedSetView('chat')} />
    }
    if (view === 'app-settings') {
      return <SettingsPage onBack={() => guardedSetView('chat')} />
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
          onSettingsTabChange={(t) => guardedSetTab(t)}
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
          guardedSetTab('repository')
          guardedSetSidebarView('settings')
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
              onSettingsTabChange={guardedSetTab}
              onViewChange={guardedSetSidebarView}
              onNewChat={() => setShowNewChat(true)}
            />
          </Sidebar>
        )}

        <ErrorBoundary>{renderMainContent()}</ErrorBoundary>
      </div>

      <ToastContainer onNavigate={(target) => guardedSetView(target as typeof view)} />
      <NotificationStack onNavigateToPage={handleNotificationNavigate} />

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
        blueprintStatus={blueprintStatus}
        indexingState={indexingState}
        sidebarView={sidebarView}
        onNavigateToSettings={(tab) => {
          guardedSetTab(tab as SettingsTab)
          guardedSetSidebarView('settings')
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
        onNavigateToBlueprint={handleNavigateToBlueprint}
        onSwitchToWorkspaceBlueprint={handleSwitchToWorkspaceBlueprint}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />

      <UnsavedChangesDialog
        isOpen={pendingNav !== null}
        onSave={handleUnsavedSave}
        onDiscard={handleUnsavedDiscard}
        onCancel={handleUnsavedCancel}
      />
    </div>
  )
}

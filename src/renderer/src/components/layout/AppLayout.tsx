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
  useIdeaStore,
  useConversationSpecialistActions,
  useSpecialistStore,
  useToastStore,
  useBugStore,
  useAuditStore,
  useIndexingStore,
  useMpaStore
} from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'

import StatusBar from './StatusBar'
import type { ConversationMode } from '../../../../shared/types'
import { useAppKeyboardShortcuts, useAppZoom, useBranchIndicator, useGrillStatus } from './hooks'

const isMac = navigator.platform.toUpperCase().includes('MAC')

export default function AppLayout(): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<'chat' | 'app-settings' | 'help' | 'bugs'>('chat')
  const [sidebarView, setSidebarView] = useState<'chat' | 'settings'>('chat')
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState<SettingsTab>('ideas')
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const agentStatus = useWorkspaceStore((s) => s.agentStatus)
  const clearActiveWorkspace = useWorkspaceStore((s) => s.clearActiveWorkspace)
  const sessionOutputTokens = useAgentStore((s) => s.sessionOutputTokens)
  const contextWindowTokens = useAgentStore((s) => s.contextWindowTokens)
  const { updateMode, setCompactSuggestion } = useChatActions()
  const [tokenModalOpen, setTokenModalOpen] = useState(false)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const { hydrateConversationSpecialists } = useConversationSpecialistActions()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [showNewChat, setShowNewChat] = useState(false)
  const { createIdea, startGrill } = useIdeaStore()
  const [appVersion, setAppVersion] = useState<string>('')
  const repoInfo = useWorkspaceStore((s) => s.repoInfo)

  // Multi-workspace: listen for background session status + permission events
  useBackgroundSessionListeners()

  // Extracted hooks — reduce AppLayout state/effect count
  const zoomFactor = useAppZoom()
  const { currentBranch, isGitRepo } = useBranchIndicator(activeWorkspace, activeConversation, repoInfo)
  const grillStatus = useGrillStatus(activeWorkspace?.id)
  const mpaStatus = useMpaStore((s) => s.isRunning || s.status.status === 'paused' ? s.status : null)
  const registerMpaListeners = useMpaStore((s) => s.registerListeners)
  const loadMpaStatus = useMpaStore((s) => s.loadStatus)

  // Council status for status bar indicator + auto-navigation
  const councilIsActive = useCouncilStore((s) => s.isActive)
  const councilPhase = useCouncilStore((s) => s.isActive ? s.phase : null)

  // Load app version once on mount
  useEffect(() => {
    window.api.getPlatformInfo().then((info) => setAppVersion(info.appVersion))
  }, [])

  // Bug tracker + toast
  const unresolvedBugCount = useBugStore((s) => s.unresolvedCount)
  const fetchBugCount = useBugStore((s) => s.fetchCount)
  const addToast = useToastStore((s) => s.addToast)

  // Audit status for status bar indicator
  const auditRunning = useAuditStore((s) => s.isRunning)
  const auditRerunning = useAuditStore((s) => s.rerunningTrackId)
  const isAuditActive = auditRunning || !!auditRerunning
  const isAuditPaused = useAuditStore((s) => s.isPaused)
  const lastAuditScore = useAuditStore((s) => s.currentRun?.overallScore ?? null)
  const loadLatestAudit = useAuditStore((s) => s.loadLatest)
  const handleAuditComplete = useAuditStore((s) => s.handleComplete)

  // Global audit listeners — keeps status bar in sync even when HealthPage is not mounted
  useEffect(() => {
    if (!activeWorkspace) return
    loadLatestAudit(activeWorkspace.id)
    const unsub = window.api.onAuditComplete(handleAuditComplete)
    return unsub
  }, [activeWorkspace?.id, loadLatestAudit, handleAuditComplete])

  // Global MPA listeners — keeps status bar in sync even when GoalPage is not mounted
  useEffect(() => {
    if (!activeWorkspace) return
    loadMpaStatus(activeWorkspace.id)
    const cleanup = registerMpaListeners()
    return cleanup
  }, [activeWorkspace?.id, registerMpaListeners, loadMpaStatus])

  // Auto-navigate to council tab when council starts
  useEffect(() => {
    if (councilIsActive) {
      setWorkspaceSettingsTab('council')
      setSidebarView('settings')
    }
  }, [councilIsActive])

  // grillStatus is now provided by useGrillStatus hook above

  /** Navigate to the grill session for a given idea */
  const handleNavigateToGrill = useCallback((_ideaId: string) => {
    // Navigate to Ideas tab (workspace settings) — the grill session will show
    setWorkspaceSettingsTab('ideas')
    setSidebarView('settings')
    // The ideas list will show the active grill for this idea
  }, [])

  // Indexing status for status bar indicator
  const indexingState = useIndexingStore((s) => s.indexingState)
  const startIndexingListener = useIndexingStore((s) => s.startListening)
  const stopIndexingListener = useIndexingStore((s) => s.stopListening)

  useEffect(() => {
    if (!activeWorkspace) return
    startIndexingListener()
    return () => stopIndexingListener()
  }, [activeWorkspace?.id, startIndexingListener, stopIndexingListener])

  // Indexing complete toast
  useEffect(() => {
    if (indexingState?.status === 'complete' && indexingState.processedChunks > 0) {
      addToast({
        type: 'success',
        message: `Semantic search ready — ${indexingState.processedChunks.toLocaleString()} symbols indexed`
      })
    }
  }, [indexingState?.status, indexingState?.processedChunks, addToast])

  // MCP tools from Da Vinci status (moved from ChatPanel header to status bar)
  const activeMcpTools = useAgentStore((s) => {
    const davinci = s.statuses.find((st) => st.agentType === 'da-vinci')
    return davinci?.activeMcpTools
  })

  // Context usage for status bar (read from chat store)
  const contextUsage = useChatStore((s) =>
    s.activeConversation ? s.contextUsages[s.activeConversation.id] : undefined
  )
  const [pendingGrill, setPendingGrill] = useState<{
    ideaId: string
    conversationId: string
    ideaTitle: string
    ideaDescription?: string
    isNewSession?: boolean
  } | null>(null)

  // Auto-reset showNewChat when a conversation is selected
  useEffect(() => {
    if (activeConversation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on selection change
      setShowNewChat(false)
    }
  }, [activeConversation])

  // Bug tracker: fetch count + listen for new bugs
  useEffect(() => {
    fetchBugCount()
    const unsub = window.api.onNewBug(() => {
      addToast({ message: 'A new bug was created', type: 'bug', onClickNavigate: 'bugs' })
      fetchBugCount()
    })
    return unsub
  }, [fetchBugCount, addToast])

  // zoomFactor is now provided by useAppZoom hook above

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

  // Ensure workspace specialists are loaded for downstream components
  useEffect(() => {
    if (workspaceSpecialists.length === 0) {
      void loadSpecialists().catch(() => undefined)
    }
  }, [workspaceSpecialists.length, loadSpecialists])

  useEffect(() => {
    if (!activeConversation?.id) {
      return
    }

    void hydrateConversationSpecialists(activeConversation.id).catch((error) => {
      console.error('[AppLayout] Failed to hydrate conversation specialists:', error)
    })
  }, [activeConversation?.id, hydrateConversationSpecialists])

  // Navigate back — Esc key handler priority
  const navigateBack = useCallback(() => {
    // Priority order:
    // 1. If on app-settings or help page → go back to chat
    // 2. If sidebar is on settings tab → switch back to chats tab
    // 3. Otherwise → no-op (already at default chat view)

    if (view === 'help') {
      setView('chat')
      return
    }
    if (view === 'app-settings') {
      setView('chat')
      return
    }
    if (sidebarView === 'settings') {
      setSidebarView('chat')
      return
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

  const handleGoHome = (): void => {
    clearActiveWorkspace()
    setView('chat')
    setSidebarView('chat')
  }

  const handleNavigateToChat = (): void => {
    setView('chat')
    setSidebarView('chat')
  }

  const handleFixInNewChat = (): void => {
    // Clear active conversation so ChatPanel shows NewChatPage
    useChatStore.setState({ activeConversation: null, messages: [] })
    setShowNewChat(true)
    setView('chat')
    setSidebarView('chat')
  }

  const handleOpenIdeas = (): void => {
    setWorkspaceSettingsTab('ideas')
    setSidebarView('settings')
  }

  const handleCreateIdea = async (data: { title: string; description?: string }): Promise<void> => {
    if (!activeWorkspace) return
    await createIdea(activeWorkspace.id, data.title, data.description ?? '')
    handleOpenIdeas()
  }

  const handleStartGrillMe = async (): Promise<void> => {
    if (!activeWorkspace || !activeConversation) return

    try {
      // 1. Create an idea from the conversation title
      const idea = await createIdea(activeWorkspace.id, activeConversation.title, '')

      // 2. Start a grill session on the new idea
      const { idea: updatedIdea, conversation: grillConversation } = await startGrill(
        idea.id,
        activeWorkspace.id
      )

      // 3. Navigate to Ideas tab with the grill page open
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
  }

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

    // No workspace → show welcome/home screen
    if (!activeWorkspace) {
      return <WelcomeScreen />
    }

    // When sidebar's settings tab is active, show selected settings content
    if (sidebarView === 'settings') {
      return (
        <WorkspaceSettingsContent
          tab={workspaceSettingsTab}
          onNavigateToChat={handleNavigateToChat}
          onFixInNewChat={handleFixInNewChat}
          onSettingsTabChange={(t) => setWorkspaceSettingsTab(t)}
          pendingGrill={pendingGrill}
          onPendingGrillConsumed={() => setPendingGrill(null)}
        />
      )
    }

    // Default: chat
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

  // Determine if sidebar should show (chat view or workspace settings view)
  const showLeftSidebar = view === 'chat' && activeWorkspace !== null

  return (
    <div className="flex flex-col h-screen bg-surface-base">
      {/* Drag region for frameless window */}
      <div
        className={`h-10 flex-shrink-0 bg-surface-base border-b border-border-subtle flex items-center pr-4 relative ${isMac ? 'pl-[80px]' : 'pl-20'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Centered title */}
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-text-secondary pointer-events-none">
          Code Atelier
        </span>

        {/* Right-aligned buttons */}
        <div
          className="flex items-center gap-1.5 ml-auto relative z-10"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={handleGoHome}
            className="p-2.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
            title="Home"
            aria-label="Home"
          >
            <Home size={16} />
          </button>
          <button
            onClick={() => setView(view === 'app-settings' ? 'chat' : 'app-settings')}
            className={`p-2.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${view === 'app-settings' ? 'text-primary-text bg-surface-overlay' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
            title="Settings"
            aria-label="Settings"
          >
            <Sliders size={16} />
          </button>
          <button
            onClick={() => setView(view === 'bugs' ? 'chat' : 'bugs')}
            className={`relative p-2.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${view === 'bugs' ? 'text-primary-text bg-surface-overlay' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
            title="Bug Tracker"
            aria-label="Bug Tracker"
          >
            <Bug size={16} />
            {unresolvedBugCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 text-[9px] font-bold bg-red-500 text-white rounded-full">
                {unresolvedBugCount > 99 ? '99+' : unresolvedBugCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setView(view === 'help' ? 'chat' : 'help')}
            className={`p-2.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${view === 'help' ? 'text-primary-text bg-surface-overlay' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
            title={`Help (${isMac ? '⌘' : 'Ctrl+'}/)`}
            aria-label="Help"
          >
            <CircleHelp size={16} />
          </button>
        </div>
      </div>

      {/* Auto-update banner */}
      <UpdateBanner />

      {/* Memory feed progress banner */}
      <MemoryFeedBanner />

      {/* Budget warning/exceeded banner */}
      <BudgetWarningBanner />

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — unified with Chats + Settings tabs */}
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

        {/* Main content — full width (no right panel) */}
        <ErrorBoundary>{renderMainContent()}</ErrorBoundary>
      </div>

      {/* Toast notifications */}
      <ToastContainer onNavigate={(target) => setView(target as typeof view)} />

      {/* Multi-workspace notification stack (permissions + completions) */}
      <NotificationStack />

      {/* Token details modal */}
      <TokenDetailsModal
        isOpen={tokenModalOpen}
        conversationId={activeConversation?.id ?? null}
        contextWindowTokens={contextWindowTokens}
        liveOutputTokens={sessionOutputTokens}
        onClose={() => setTokenModalOpen(false)}
      />

      {/* Status bar */}
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

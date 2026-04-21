import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Monitor,
  Bot,
  Zap,
  Home,
  Sliders,
  Building2,
  ClipboardList,
  Hammer,
  Braces,
  SearchCode,
  ZoomIn,
  ZoomOut,
  CircleHelp
} from 'lucide-react'
import { Sidebar, UnifiedSidebar, BottomPanel } from '@renderer/components/layout'
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
  ErrorBoundary
} from '@renderer/components/common'
import {
  useWorkspaceStore,
  useAgentStore,
  useChatStore,
  useChatActions,
  useIdeaStore,
  useConversationSpecialistActions,
  useSpecialistStore,
  useBottomPanelStore
} from '@renderer/store'

const isMac = navigator.platform.toUpperCase().includes('MAC')

/** Extracted agent status dot — avoids recreating on every AppLayout render */
function AgentStatusDot({ status }: { status: string }): React.JSX.Element {
  const dotBase = 'w-2 h-2 rounded-full inline-block'
  switch (status) {
    case 'running':
      return <span className={`${dotBase} bg-success`} title="Agent ready" />
    case 'starting':
      return <span className={`${dotBase} bg-warning animate-pulse`} title="Agent starting" />
    case 'error':
      return <span className={`${dotBase} bg-danger`} title="Agent error" />
    default:
      return <span className={`${dotBase} bg-text-muted`} title="Agent stopped" />
  }
}

export default function AppLayout(): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<'chat' | 'app-settings' | 'help'>('chat')
  const [sidebarView, setSidebarView] = useState<'chat' | 'settings'>('chat')
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState<SettingsTab>('ideas')
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const agentStatus = useWorkspaceStore((s) => s.agentStatus)
  const clearActiveWorkspace = useWorkspaceStore((s) => s.clearActiveWorkspace)
  const statuses = useAgentStore((s) => s.statuses)
  const sessionTokens = useAgentStore((s) => s.sessionTokens)
  const { updateMode } = useChatActions()
  const activeConversation = useChatStore((s) => s.activeConversation)
  const { hydrateConversationSpecialists } = useConversationSpecialistActions()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [showNewChat, setShowNewChat] = useState(false)
  const { createIdea, startGrill } = useIdeaStore()
  const [zoomFactor, setZoomFactor] = useState(1.0)

  // Bottom panel store
  const { activeTab: bottomTab, openTab, toggleTab } = useBottomPanelStore()

  // MCP tools from generalist status (moved from ChatPanel header to status bar)
  const activeMcpTools = useAgentStore((s) => {
    const generalist = s.statuses.find((st) => st.agentType === 'generalist')
    return generalist?.activeMcpTools
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

  // Load initial zoom and subscribe to changes
  useEffect(() => {
    window.api.zoomGet().then(setZoomFactor).catch(console.error)
    const unsub = window.api.onZoomChanged((factor) => setZoomFactor(factor))
    return unsub
  }, [])

  const handleZoomIn = useCallback(() => {
    window.api.zoomIn()
  }, [])
  const handleZoomOut = useCallback(() => {
    window.api.zoomOut()
  }, [])
  const handleZoomReset = useCallback(() => {
    window.api.zoomReset()
  }, [])

  const activeAgentCount = statuses.filter(
    (s) => s.status === 'thinking' || s.status === 'writing' || s.status === 'reviewing'
  ).length
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

  // #7 - Auto-open agent panel when agents activate
  const prevAgentCount = useRef(0)
  useEffect(() => {
    const wasZero = prevAgentCount.current === 0
    prevAgentCount.current = activeAgentCount

    if (wasZero && activeAgentCount > 0) {
      openTab('agents')
    }
  }, [activeAgentCount, openTab])

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

  // #18 - Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey

      // Esc key — navigate back (context-aware)
      if (e.key === 'Escape') {
        const tag = (document.activeElement as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        // Skip if a modal/dialog is open (portals render into body)
        if (document.querySelector('[role="dialog"]')) return
        e.preventDefault()
        navigateBack()
        return
      }

      if (isMeta && e.key === 'j') {
        e.preventDefault()
        toggleTab('agents')
      }

      if (isMeta && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed((prev) => !prev)
      }

      if (isMeta && e.key === 'n') {
        e.preventDefault()
        if (activeWorkspace) {
          // Clear active conversation so ChatPanel shows NewChatPage inline
          useChatStore.setState({ activeConversation: null, messages: [] })
          setShowNewChat(true)
        }
      }

      if (isMeta && e.key === '.') {
        e.preventDefault()
        if (activeConversation && !isStreaming) {
          updateMode(activeConversation.mode === 'plan' ? 'build' : 'plan')
        }
      }

      if (isMeta && e.key === '/') {
        e.preventDefault()
        setView((prev) => (prev === 'help' ? 'chat' : 'help'))
      }

      if (isMeta && e.shiftKey && e.key === 'o') {
        e.preventDefault()
        toggleTab('office')
      }

      // Zoom shortcuts — ⌘+/⌘= to zoom in, ⌘- to zoom out, ⌘0 to reset
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
    [activeWorkspace, activeConversation, updateMode, isStreaming, navigateBack, toggleTab]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleGoHome = (): void => {
    clearActiveWorkspace()
    setView('chat')
    setSidebarView('chat')
  }

  const handleNavigateToChat = (): void => {
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

      {/* Bottom panel — Agents or Office (mutually exclusive) */}
      <BottomPanel />

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-base border-t border-border-subtle text-[13px]">
        <div className="flex items-center gap-4">
          {activeWorkspace ? (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <AgentStatusDot status={agentStatus} />
              <Bot size={12} className="text-primary-text" />
              {activeWorkspace.name}
            </span>
          ) : (
            <span className="text-text-muted">No workspace selected</span>
          )}

          {activeConversation && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium flex items-center gap-1 ${
                activeConversation.mode === 'plan'
                  ? 'bg-mode-plan-muted text-mode-plan-text'
                  : 'bg-mode-build-muted text-mode-build-text'
              }`}
            >
              {activeConversation.mode === 'plan' ? (
                <ClipboardList size={10} />
              ) : (
                <Hammer size={10} />
              )}
              {activeConversation.mode === 'plan' ? 'Plan' : 'Build'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/* MCP tool indicators */}
          {activeMcpTools && activeMcpTools.length > 0 && (
            <div className="flex items-center gap-1.5">
              {activeMcpTools.includes('code-graph') && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400"
                  title="Code Graph active"
                >
                  <Braces size={10} /> CG
                </span>
              )}
              {activeMcpTools.includes('semantic-search') && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-400"
                  title="Semantic Search active"
                >
                  <SearchCode size={10} /> Sem
                </span>
              )}
            </div>
          )}

          {/* Context + tokens merged */}
          <span className="flex items-center gap-1.5 text-text-muted">
            {contextUsage && contextUsage.percentage > 0 && (
              <span
                className={
                  contextUsage.level === 'critical' || contextUsage.level === 'red'
                    ? 'text-danger'
                    : contextUsage.level === 'yellow'
                      ? 'text-warning'
                      : 'text-text-secondary'
                }
              >
                {contextUsage.percentage}%
              </span>
            )}
            <Zap size={11} />
            {sessionTokens > 0 ? `${(sessionTokens / 1000).toFixed(1)}k` : '0'} tokens
          </span>

          {/* Zoom controls */}
          <div className="flex items-center gap-0.5 border-l border-border-subtle pl-3 ml-1">
            <button
              onClick={handleZoomOut}
              className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
              aria-label="Zoom out"
              title={`Zoom Out (${isMac ? '⌘' : 'Ctrl+'}−)`}
            >
              <ZoomOut size={12} />
            </button>
            <button
              onClick={handleZoomReset}
              className="px-1 py-0.5 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors min-w-[36px] text-center"
              title={`Reset Zoom (${isMac ? '⌘' : 'Ctrl+'}0)`}
            >
              <span className="text-[11px] font-mono">{Math.round(zoomFactor * 100)}%</span>
            </button>
            <button
              onClick={handleZoomIn}
              className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
              aria-label="Zoom in"
              title={`Zoom In (${isMac ? '⌘' : 'Ctrl+'}+)`}
            >
              <ZoomIn size={12} />
            </button>
          </div>

          <button
            onClick={() => toggleTab('office')}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
              bottomTab === 'office'
                ? 'text-primary-text bg-primary-muted'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            aria-label={bottomTab === 'office' ? 'Close pixel office' : 'Open pixel office'}
            aria-pressed={bottomTab === 'office'}
            title={`Pixel Office (${isMac ? '⌘' : 'Ctrl+'}⇧O)`}
          >
            <Building2 size={12} />
            <span>Office</span>
          </button>

          <button
            onClick={() => toggleTab('agents')}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
              bottomTab === 'agents'
                ? 'text-primary-text bg-primary-muted'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            aria-label={bottomTab === 'agents' ? 'Hide agent panel' : 'Show agent panel'}
            aria-pressed={bottomTab === 'agents'}
            title={`Toggle Agent Panel (${isMac ? '⌘' : 'Ctrl+'}J)`}
          >
            <Monitor size={12} />
            <span>Agents{activeAgentCount > 0 ? ` (${activeAgentCount})` : ''}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

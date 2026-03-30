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
  ZoomIn,
  ZoomOut,
  CircleHelp,
  ExternalLink,
  ArrowLeft
} from 'lucide-react'
import { Sidebar, UnifiedSidebar } from '@renderer/components/layout'
import { ChatPanel } from '@renderer/components/chat'
import { AgentMonitor } from '@renderer/components/agents'
import { PixelOfficePanel, PhaserOfficeCanvas } from '@renderer/components/pixel-office'
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
import { NewConversationModal } from '@renderer/components/chat'
import {
  useWorkspaceStore,
  useAgentStore,
  useChatStore,
  useChatActions,
  usePixelOfficeStore,
  useIdeaStore
} from '@renderer/store'
import type { ConversationMode } from '../../../../shared/types'

const isMac = navigator.platform.toUpperCase().includes('MAC')

/** Extracted orchestrator status dot — avoids recreating on every AppLayout render */
function OrchestratorDot({ status }: { status: string }): React.JSX.Element {
  const dotBase = 'w-2 h-2 rounded-full inline-block'
  switch (status) {
    case 'running':
      return <span className={`${dotBase} bg-success`} title="Orchestrator running" />
    case 'starting':
      return (
        <span className={`${dotBase} bg-warning animate-pulse`} title="Orchestrator starting" />
      )
    case 'error':
      return <span className={`${dotBase} bg-danger`} title="Orchestrator error" />
    default:
      return <span className={`${dotBase} bg-text-muted`} title="Orchestrator stopped" />
  }
}

export default function AppLayout(): React.JSX.Element {
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<'chat' | 'app-settings' | 'help'>('chat')
  const [sidebarView, setSidebarView] = useState<'chat' | 'settings'>('chat')
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState<SettingsTab>('ideas')
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const orchestratorStatus = useWorkspaceStore((s) => s.orchestratorStatus)
  const clearActiveWorkspace = useWorkspaceStore((s) => s.clearActiveWorkspace)
  const statuses = useAgentStore((s) => s.statuses)
  const sessionTokens = useAgentStore((s) => s.sessionTokens)
  const { createConversation, updateMode, sendMessage } = useChatActions()
  const activeConversation = useChatStore((s) => s.activeConversation)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const {
    isVisible: showPixelOffice,
    isOfficeCentered,
    setOfficeCentered
  } = usePixelOfficeStore()
  const { createIdea, startGrill } = useIdeaStore()
  const [zoomFactor, setZoomFactor] = useState(1.0)
  const [pendingGrill, setPendingGrill] = useState<{
    ideaId: string
    conversationId: string
    ideaTitle: string
    ideaDescription?: string
    isNewSession?: boolean
  } | null>(null)

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

  // #7 - Auto-open agent panel when agents activate
  const prevAgentCount = useRef(0)
  useEffect(() => {
    const wasZero = prevAgentCount.current === 0
    prevAgentCount.current = activeAgentCount

    if (wasZero && activeAgentCount > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowAgentPanel(true)
    }
  }, [activeAgentCount])

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
        setShowAgentPanel((prev) => !prev)
      }

      if (isMeta && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed((prev) => !prev)
      }

      if (isMeta && e.key === 'n') {
        e.preventDefault()
        if (activeWorkspace) {
          setShowNewChatModal(true)
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
        if (isOfficeCentered) {
          setOfficeCentered(false)
        } else {
          setOfficeCentered(true)
        }
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
    [activeWorkspace, isOfficeCentered, setOfficeCentered, activeConversation, updateMode, isStreaming, navigateBack]
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

  const handleCreateIdea = async (data: {
    title: string
    description?: string
  }): Promise<void> => {
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

  const handleCreateChat = async (data: {
    title: string
    description?: string
    mode: ConversationMode
    attachments?: string[]
    useIsolatedBranch?: boolean
  }): Promise<void> => {
    if (!activeWorkspace) return
    await createConversation(activeWorkspace.id, data.mode, data.title)
    if (data.description) {
      await sendMessage(data.description, data.attachments)
    }
    if (data.useIsolatedBranch) {
      // TODO: integrate worktree IPC — creates a git worktree for this conversation
      console.info(
        '[NewConversationModal] Isolated branch requested — worktree integration pending'
      )
    }
    setShowNewChatModal(false)
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
    return <ChatPanel onCreateIdea={handleCreateIdea} onStartGrillMe={handleStartGrillMe} />
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
            />
          </Sidebar>
        )}

        {/* Office-centered layout: office in center, chat+agents stacked on right */}
        {isOfficeCentered && view === 'chat' && activeWorkspace ? (
          <>
            {/* CENTER: Pixel Office (takes the main content area) */}
            <div className="flex-1 min-h-0 relative flex flex-col">
              {/* Office header bar */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1828]/80 border-b border-[#3d3555]/50 flex-shrink-0">
                <span className="text-xs font-medium text-gray-400 flex items-center gap-2">
                  <span className="text-base">🏰</span>
                  Pixel Office
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={async () => {
                      await window.api.popoutPixelOffice()
                    }}
                    className="p-1 rounded hover:bg-[#2a2844] text-gray-500 hover:text-gray-300 transition-colors"
                    title="Open in separate window"
                    aria-label="Pop out to separate window"
                  >
                    <ExternalLink size={12} />
                  </button>
                  <button
                    onClick={() => setOfficeCentered(false)}
                    className="p-1 rounded hover:bg-[#2a2844] text-gray-500 hover:text-gray-300 transition-colors"
                    title="Back to normal layout"
                    aria-label="Close office view"
                  >
                    <ArrowLeft size={12} />
                  </button>
                </div>
              </div>
              {/* Phaser canvas */}
              <div className="flex-1 min-h-0 bg-[#0a0a14]">
                <ErrorBoundary
                  fallback={
                    <div className="p-4 text-sm text-danger bg-surface-raised">
                      Pixel Office error — click to retry
                    </div>
                  }
                >
                  <PhaserOfficeCanvas />
                </ErrorBoundary>
              </div>
            </div>

            {/* RIGHT: Chat + Agents (collapsible bottom) */}
            <div className="w-[420px] h-full min-h-0 flex flex-col border-l border-border-subtle flex-shrink-0">
              {/* Chat — fills remaining space */}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                <ErrorBoundary>
                  <ChatPanel onCreateIdea={handleCreateIdea} onStartGrillMe={handleStartGrillMe} />
                </ErrorBoundary>
              </div>

              {/* Agents — collapsible bottom */}
              {showAgentPanel && (
                <div className="max-h-[35%] min-h-0 border-t border-border-subtle flex-shrink-0 overflow-hidden">
                  <ErrorBoundary
                    fallback={
                      <div className="flex items-center justify-center p-4 text-sm text-danger bg-surface-raised">
                        Agent panel error — click to retry
                      </div>
                    }
                  >
                    <AgentMonitor
                      isCollapsed={agentPanelCollapsed}
                      onToggleCollapse={() => setAgentPanelCollapsed((prev) => !prev)}
                      variant="bottom"
                    />
                  </ErrorBoundary>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Normal layout: main content + agent panel */}
            <ErrorBoundary>{renderMainContent()}</ErrorBoundary>

            {/* Agent monitor panel — only in chat view */}
            {showAgentPanel && view === 'chat' && (
              <ErrorBoundary
                fallback={
                  <div className="w-64 flex items-center justify-center p-4 text-sm text-danger bg-surface-raised border-l border-border-subtle">
                    Agent panel error — click to retry
                  </div>
                }
              >
                <AgentMonitor
                  isCollapsed={agentPanelCollapsed}
                  onToggleCollapse={() => setAgentPanelCollapsed((prev) => !prev)}
                />
              </ErrorBoundary>
            )}
          </>
        )}
      </div>

      {/* Pixel Office bottom panel — only in non-centered mode */}
      {showPixelOffice && !isOfficeCentered && view === 'chat' && (
        <ErrorBoundary
          fallback={
            <div className="p-4 text-sm text-danger bg-surface-raised border-t border-border-subtle">
              Pixel Office error — click to retry
            </div>
          }
        >
          <PixelOfficePanel />
        </ErrorBoundary>
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-base border-t border-border-subtle text-[13px]">
        <div className="flex items-center gap-4">
          {activeWorkspace ? (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <OrchestratorDot status={orchestratorStatus} />
              <Bot size={12} className="text-primary-text" />
              {activeWorkspace.name}
            </span>
          ) : (
            <span className="text-text-muted">No workspace selected</span>
          )}

          {activeConversation && (
            <>
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
              <span className="text-text-muted truncate max-w-[200px]">
                {activeConversation.title}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-text-muted">
            <Zap size={11} />
            {sessionTokens > 0 ? `${(sessionTokens / 1000).toFixed(1)}k tokens` : '0 tokens'}
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
            onClick={() => {
              if (isOfficeCentered) {
                setOfficeCentered(false)
              } else {
                setOfficeCentered(true)
              }
            }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
              isOfficeCentered
                ? 'text-primary-text bg-primary-muted'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            aria-label={isOfficeCentered ? 'Close pixel office' : 'Open pixel office'}
            aria-pressed={isOfficeCentered}
            title={`Pixel Office (${isMac ? '⌘' : 'Ctrl+'}⇧O)`}
          >
            <Building2 size={12} />
            <span>Office</span>
          </button>

          <button
            onClick={() => setShowAgentPanel(!showAgentPanel)}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
              showAgentPanel
                ? 'text-primary-text bg-primary-muted'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            aria-label={showAgentPanel ? 'Hide agent panel' : 'Show agent panel'}
            aria-pressed={showAgentPanel}
            title={`Toggle Agent Panel (${isMac ? '⌘' : 'Ctrl+'}J)`}
          >
            <Monitor size={12} />
            <span>Agents{activeAgentCount > 0 ? ` (${activeAgentCount})` : ''}</span>
          </button>
        </div>
      </div>

      {/* New conversation modal (triggered by Cmd+N) */}
      <NewConversationModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSubmit={handleCreateChat}
        onCreateIdea={handleCreateIdea}
      />
    </div>
  )
}

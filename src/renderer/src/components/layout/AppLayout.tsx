import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Monitor,
  Bot,
  Zap,
  Home,
  Settings,
  Sliders,
  Building2,
  ClipboardList,
  Hammer
} from 'lucide-react'
import { Sidebar } from '@renderer/components/layout'
import { ChatSidebar, ChatPanel } from '@renderer/components/chat'
import { AgentMonitor } from '@renderer/components/agents'
import { PixelOfficePanel } from '@renderer/components/pixel-office'
import { WorkspaceSettingsPage } from '@renderer/components/workspace'
import { SettingsPage } from '@renderer/components/settings'
import { UpdateBanner, BrainFeedBanner, ErrorBoundary } from '@renderer/components/common'
import {
  useWorkspaceStore,
  useAgentStore,
  useChatStore,
  usePixelOfficeStore
} from '@renderer/store'

const isMac = navigator.platform.toUpperCase().includes('MAC')

/** Extracted orchestrator status dot — avoids recreating on every AppLayout render */
function OrchestratorDot({ status }: { status: string }): React.JSX.Element {
  const dotBase = 'w-2 h-2 rounded-full inline-block'
  switch (status) {
    case 'running':
      return <span className={`${dotBase} bg-green-400`} title="Orchestrator running" />
    case 'starting':
      return (
        <span className={`${dotBase} bg-yellow-400 animate-pulse`} title="Orchestrator starting" />
      )
    case 'error':
      return <span className={`${dotBase} bg-red-400`} title="Orchestrator error" />
    default:
      return <span className={`${dotBase} bg-gray-500`} title="Orchestrator stopped" />
  }
}

export default function AppLayout(): React.JSX.Element {
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<'chat' | 'settings' | 'app-settings'>('chat')
  const { activeWorkspace, orchestratorStatus, clearActiveWorkspace } = useWorkspaceStore()
  const { statuses, sessionTokens } = useAgentStore()
  const { activeConversation, createConversation, updateMode, isStreaming } = useChatStore()
  const { isVisible: showPixelOffice, togglePanel: togglePixelOffice } = usePixelOfficeStore()

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

  // #18 - Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey

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
          createConversation(activeWorkspace.id)
        }
      }

      if (isMeta && e.key === '.') {
        e.preventDefault()
        if (activeConversation && !isStreaming) {
          updateMode(activeConversation.mode === 'plan' ? 'build' : 'plan')
        }
      }

      if (isMeta && e.shiftKey && e.key === 'o') {
        e.preventDefault()
        togglePixelOffice()
      }
    },
    [
      activeWorkspace,
      createConversation,
      togglePixelOffice,
      activeConversation,
      updateMode,
      isStreaming
    ]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleGoHome = (): void => {
    clearActiveWorkspace()
    setView('chat')
  }

  const renderMainContent = (): React.JSX.Element => {
    switch (view) {
      case 'settings':
        return <WorkspaceSettingsPage onBack={() => setView('chat')} />
      case 'app-settings':
        return <SettingsPage onBack={() => setView('chat')} />
      default:
        return <ChatPanel />
    }
  }

  return (
    <div className="flex flex-col h-screen bg-surface-base">
      {/* Drag region for frameless window */}
      <div
        className={`h-10 flex-shrink-0 bg-surface-base border-b border-border-subtle flex items-center pr-4 relative ${isMac ? 'pl-[80px]' : 'pl-20'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Centered title */}
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-text-secondary pointer-events-none">
          Agent Studio
        </span>

        {/* Right-aligned buttons */}
        <div
          className="flex items-center gap-1.5 ml-auto relative z-10"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={handleGoHome}
            className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
            title="Home"
            aria-label="Home"
          >
            <Home size={16} />
          </button>
          {activeWorkspace && (
            <button
              onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
              className={`p-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${view === 'settings' ? 'text-primary-text bg-surface-overlay' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
              title="Workspace Settings"
              aria-label="Workspace Settings"
            >
              <Settings size={16} />
            </button>
          )}
          <button
            onClick={() => setView(view === 'app-settings' ? 'chat' : 'app-settings')}
            className={`p-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${view === 'app-settings' ? 'text-primary-text bg-surface-overlay' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
            title="Settings"
            aria-label="Settings"
          >
            <Sliders size={16} />
          </button>
        </div>
      </div>

      {/* Auto-update banner */}
      <UpdateBanner />

      {/* Brain feed progress banner */}
      <BrainFeedBanner />

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — only show in chat view */}
        {view === 'chat' && (
          <Sidebar>
            <ChatSidebar
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
            />
          </Sidebar>
        )}

        {/* Main content area — full width in settings views */}
        <ErrorBoundary>{renderMainContent()}</ErrorBoundary>

        {/* Agent monitor panel — only in chat view */}
        {showAgentPanel && view === 'chat' && (
          <ErrorBoundary
            fallback={
              <div className="w-64 flex items-center justify-center p-4 text-sm text-red-400 bg-surface-raised border-l border-border-subtle">
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
      </div>

      {/* Pixel Office panel — only in chat view */}
      {showPixelOffice && view === 'chat' && (
        <ErrorBoundary
          fallback={
            <div className="p-4 text-sm text-red-400 bg-surface-raised border-t border-border-subtle">
              Pixel Office error — click to retry
            </div>
          }
        >
          <PixelOfficePanel />
        </ErrorBoundary>
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-base border-t border-border-subtle text-xs">
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
                    ? 'bg-purple-600/20 text-purple-400'
                    : 'bg-amber-600/20 text-amber-400'
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

          <button
            onClick={togglePixelOffice}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
              showPixelOffice
                ? 'text-primary-text bg-primary-muted'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            aria-label={showPixelOffice ? 'Hide pixel office' : 'Show pixel office'}
            aria-pressed={showPixelOffice}
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
    </div>
  )
}

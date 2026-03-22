import { useState, useEffect, useRef, useCallback } from 'react';
import { Monitor, Bot, Zap, Home, Settings, Sliders, Building2 } from 'lucide-react';
import { Sidebar } from '@renderer/components/layout';
import { ChatSidebar, ChatPanel } from '@renderer/components/chat';
import { AgentMonitor } from '@renderer/components/agents';
import { PixelOfficePanel } from '@renderer/components/pixel-office';
import { WorkspaceSettingsPage } from '@renderer/components/workspace';
import { SettingsPage } from '@renderer/components/settings';
import { useWorkspaceStore, useAgentStore, useChatStore, usePixelOfficeStore } from '@renderer/store';

const isMac = navigator.platform.toUpperCase().includes('MAC');

export default function AppLayout(): React.JSX.Element {
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setView] = useState<'chat' | 'settings' | 'app-settings'>('chat');
  const { activeWorkspace, orchestratorStatus, clearActiveWorkspace } = useWorkspaceStore();
  const { statuses, sessionTokens } = useAgentStore();
  const { activeConversation, createConversation, updateMode, isStreaming } = useChatStore();
  const { isVisible: showPixelOffice, togglePanel: togglePixelOffice } = usePixelOfficeStore();

  const activeAgentCount = statuses.filter(
    (s) => s.status === 'thinking' || s.status === 'writing' || s.status === 'reviewing'
  ).length;

  // #7 - Auto-open agent panel when agents activate
  const prevAgentCount = useRef(0);
  useEffect(() => {
    const wasZero = prevAgentCount.current === 0;
    prevAgentCount.current = activeAgentCount;

    if (wasZero && activeAgentCount > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowAgentPanel(true);
    }
  }, [activeAgentCount]);

  // #18 - Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      if (isMeta && e.key === 'j') {
        e.preventDefault();
        setShowAgentPanel((prev) => !prev);
      }

      if (isMeta && e.key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }

      if (isMeta && e.key === 'n') {
        e.preventDefault();
        if (activeWorkspace) {
          createConversation(activeWorkspace.id);
        }
      }

      if (isMeta && e.shiftKey && e.key === 'm') {
        e.preventDefault();
        if (activeConversation && !isStreaming) {
          updateMode(activeConversation.mode === 'plan' ? 'build' : 'plan');
        }
      }

      if (isMeta && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        togglePixelOffice();
      }
    },
    [activeWorkspace, createConversation, togglePixelOffice, activeConversation, updateMode, isStreaming]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleGoHome = (): void => {
    clearActiveWorkspace();
    setView('chat');
  };

  // Orchestrator status indicator
  const orchestratorDot = (): React.JSX.Element => {
    const dotBase = 'w-2 h-2 rounded-full inline-block';
    switch (orchestratorStatus) {
      case 'running':
        return <span className={`${dotBase} bg-green-400`} title="Orchestrator running" />;
      case 'starting':
        return <span className={`${dotBase} bg-yellow-400 animate-pulse`} title="Orchestrator starting" />;
      case 'error':
        return <span className={`${dotBase} bg-red-400`} title="Orchestrator error" />;
      default:
        return <span className={`${dotBase} bg-gray-500`} title="Orchestrator stopped" />;
    }
  };

  const renderMainContent = (): React.JSX.Element => {
    switch (view) {
      case 'settings':
        return <WorkspaceSettingsPage onBack={() => setView('chat')} />;
      case 'app-settings':
        return <SettingsPage onBack={() => setView('chat')} />;
      default:
        return <ChatPanel />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900">
      {/* Drag region for frameless window */}
      <div
        className={`h-10 flex-shrink-0 bg-gray-900 border-b border-gray-700 flex items-center pr-4 relative ${isMac ? 'pl-[80px]' : 'pl-20'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Centered title */}
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-gray-400 pointer-events-none">
          Agent Studio
        </span>

        {/* Right-aligned buttons */}
        <div className="flex items-center gap-1.5 ml-auto relative z-10" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={handleGoHome}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
            title="Home"
            aria-label="Home"
          >
            <Home size={16} />
          </button>
          {activeWorkspace && (
            <button
              onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
              className={`p-1.5 rounded-md transition-colors ${view === 'settings' ? 'text-indigo-400 bg-gray-800' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
              title="Workspace Settings"
              aria-label="Workspace Settings"
            >
              <Settings size={16} />
            </button>
          )}
          <button
            onClick={() => setView(view === 'app-settings' ? 'chat' : 'app-settings')}
            className={`p-1.5 rounded-md transition-colors ${view === 'app-settings' ? 'text-indigo-400 bg-gray-800' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
            title="Settings"
            aria-label="Settings"
          >
            <Sliders size={16} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <Sidebar>
          <ChatSidebar
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          />
        </Sidebar>

        {/* Main content area */}
        {renderMainContent()}

        {/* Agent monitor panel */}
        {showAgentPanel && view === 'chat' && (
          <AgentMonitor
            isCollapsed={agentPanelCollapsed}
            onToggleCollapse={() => setAgentPanelCollapsed((prev) => !prev)}
          />
        )}
      </div>

      {/* Pixel Office panel */}
      {showPixelOffice && view === 'chat' && <PixelOfficePanel />}

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-gray-900 border-t border-gray-700 text-[11px]">
        <div className="flex items-center gap-4">
          {activeWorkspace ? (
            <span className="flex items-center gap-1.5 text-gray-400">
              {orchestratorDot()}
              <Bot size={12} className="text-indigo-400" />
              {activeWorkspace.name}
            </span>
          ) : (
            <span className="text-gray-600">No workspace selected</span>
          )}

          {activeConversation && (
            <>
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                activeConversation.mode === 'plan'
                  ? 'bg-purple-600/20 text-purple-400'
                  : 'bg-amber-600/20 text-amber-400'
              }`}>
                {activeConversation.mode === 'plan' ? '📋 Plan' : '🔨 Build'}
              </span>
              <span className="text-gray-500 truncate max-w-[200px]">
                {activeConversation.title}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-gray-500">
            <Zap size={10} />
            {sessionTokens > 0 ? `${(sessionTokens / 1000).toFixed(1)}k tokens` : '0 tokens'}
          </span>

          <button
            onClick={togglePixelOffice}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              showPixelOffice
                ? 'text-indigo-400 bg-indigo-500/10'
                : 'text-gray-500 hover:text-gray-300'
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
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              showAgentPanel
                ? 'text-indigo-400 bg-indigo-500/10'
                : 'text-gray-500 hover:text-gray-300'
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
  );
}

import { useState, useEffect } from 'react'
import { Plus, MessageSquare, FolderOpen, ChevronLeft, ChevronRight, Settings } from 'lucide-react'
import { useChatStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { ChatItem } from '@renderer/components/chat'
import { ConfirmDialog } from '@renderer/components/common'
import { SETTINGS_MENU } from '@renderer/components/workspace/WorkspaceSettingsPanel'
import type { SettingsTab } from '@renderer/components/workspace/WorkspaceSettingsPanel'

type SidebarTab = 'chats' | 'settings'

interface UnifiedSidebarProps {
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  onCreateIdea?: (data: { title: string; description?: string }) => void
  activeSettingsTab: SettingsTab
  onSettingsTabChange: (tab: SettingsTab) => void
  onViewChange: (view: 'chat' | 'settings') => void
  onNewChat?: () => void
}

export default function UnifiedSidebar({
  isCollapsed: externalCollapsed,
  onToggleCollapse,
  activeSettingsTab,
  onSettingsTabChange,
  onViewChange,
  onNewChat
}: UnifiedSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SidebarTab>('chats')
  const { activeWorkspace } = useWorkspaceStore()
  const { loadConversations, selectConversation, closeConversation, renameConversation } =
    useChatActions()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const isStreaming = useChatStore((s) => s.isStreaming)

  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // showNewChatModal state removed — new chat is now handled inline via onNewChat prop
  const isCollapsed = externalCollapsed ?? internalCollapsed
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed((c) => !c))

  // Notify parent when sidebar tab changes
  const handleTabChange = (tab: SidebarTab): void => {
    setActiveTab(tab)
    onViewChange(tab === 'settings' ? 'settings' : 'chat')
  }

  // Load conversations when workspace changes
  useEffect(() => {
    if (activeWorkspace) {
      loadConversations(activeWorkspace.id)
    }
  }, [activeWorkspace, loadConversations])

  const handleNewChat = (): void => {
    // Clear active conversation so ChatPanel renders NewChatPage inline
    useChatStore.setState({ activeConversation: null, messages: [] })
    onNewChat?.()
    handleTabChange('chats')
  }

  const sortedConversations = [...conversations]
    .filter((c) => !c.title.startsWith('\u{1F4A1} Grill:'))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  // --- Tab bar component ---
  const renderTabBar = (): React.JSX.Element => (
    <div className="flex border-b border-border-subtle flex-shrink-0">
      <button
        onClick={() => handleTabChange('settings')}
        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
          activeTab === 'settings'
            ? 'text-primary-text border-b-2 border-primary bg-primary-muted/30'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        }`}
        aria-label="Settings"
        title="Workspace Settings"
      >
        <Settings size={14} />
        {!isCollapsed && <span>Settings</span>}
      </button>
      <button
        onClick={() => handleTabChange('chats')}
        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
          activeTab === 'chats'
            ? 'text-primary-text border-b-2 border-primary bg-primary-muted/30'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        }`}
        aria-label="Chats"
        title="Chats"
      >
        <MessageSquare size={14} />
        {!isCollapsed && <span>Chats</span>}
      </button>
    </div>
  )

  // --- Collapsed view ---
  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 h-full bg-surface-raised border-r border-border-subtle">
        {/* Collapse toggle */}
        <div className="flex items-center justify-center w-full py-2 border-b border-border-subtle">
          <button
            onClick={toggleCollapse}
            className="p-2 rounded-lg hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Tab icons */}
        {renderTabBar()}

        {/* Tab content (collapsed) */}
        <div className="flex flex-col items-center gap-2 py-3 w-full flex-1 overflow-y-auto">
          {activeTab === 'chats' && (
            <>
              <button
                onClick={handleNewChat}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-overlay text-text-secondary hover:bg-primary hover:text-white transition-colors"
                aria-label="New chat"
                title="New chat"
              >
                <Plus size={14} />
              </button>
              {sortedConversations.slice(0, 8).map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    selectConversation(conv.id)
                    handleTabChange('chats')
                  }}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold transition-colors press-scale ${
                    activeConversation?.id === conv.id
                      ? 'bg-primary text-white'
                      : 'bg-surface-overlay text-text-secondary hover:bg-surface-float'
                  } ${isStreaming && activeConversation?.id === conv.id ? 'chat-icon-processing' : ''}`}
                  title={conv.title}
                  aria-label={`Open conversation: ${conv.title}`}
                >
                  {conv.title.charAt(0).toUpperCase()}
                </button>
              ))}
            </>
          )}
          {activeTab === 'settings' && (
            <div className="w-full px-1.5">
              {/* Tools group (collapsed — icons only) */}
              <div className="space-y-0.5">
                {SETTINGS_MENU.filter((item) => item.group === 'tools').map((item) => {
                  const Icon = item.icon
                  const isActive = activeSettingsTab === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSettingsTabChange(item.id)}
                      className={`flex items-center justify-center w-full px-2 py-2 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        isActive
                          ? 'bg-primary-muted text-primary-text border border-primary/20'
                          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                      }`}
                      title={item.label}
                    >
                      <Icon size={16} className={isActive ? undefined : item.iconColor} />
                    </button>
                  )
                })}
              </div>

              {/* Divider */}
              <div className="my-2 mx-1 border-t border-border-subtle" />

              {/* Configuration group (collapsed — icons only) */}
              <div className="space-y-0.5">
                {SETTINGS_MENU.filter((item) => item.group === 'configuration').map((item) => {
                  const Icon = item.icon
                  const isActive = activeSettingsTab === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSettingsTabChange(item.id)}
                      className={`flex items-center justify-center w-full px-2 py-2 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        isActive
                          ? 'bg-primary-muted text-primary-text border border-primary/20'
                          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                      }`}
                      title={item.label}
                    >
                      <Icon size={16} className={isActive ? undefined : item.iconColor} />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // --- Expanded view ---
  return (
    <>
      <div className="flex flex-col w-64 h-full bg-surface-raised border-r border-border-subtle">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen size={16} className="text-primary-text flex-shrink-0" />
            <span className="text-sm font-semibold text-text-primary truncate">
              {activeWorkspace?.name ?? 'Code Atelier'}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {activeTab === 'chats' && (
              <button
                onClick={handleNewChat}
                className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-primary-text transition-colors"
                aria-label="New chat"
                title="New Chat (Cmd+N)"
              >
                <Plus size={16} />
              </button>
            )}
            <button
              onClick={toggleCollapse}
              className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <ChevronLeft size={16} />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        {renderTabBar()}

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'chats' && (
            <div className="p-3 space-y-1.5">
              {!activeWorkspace ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <FolderOpen size={32} className="text-border-default mb-3" />
                  <p className="text-sm text-text-secondary mb-1">No workspace selected</p>
                  <p className="text-xs text-text-muted">Select a workspace to start</p>
                </div>
              ) : sortedConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <MessageSquare size={32} className="text-border-default mb-3" />
                  <p className="text-sm text-text-secondary mb-1">No conversations yet</p>
                  <p className="text-xs text-text-muted">Click + to start a chat</p>
                </div>
              ) : (
                sortedConversations.map((conv) => (
                  <ChatItem
                    key={conv.id}
                    conversation={conv}
                    isActive={activeConversation?.id === conv.id}
                    isStreaming={isStreaming && activeConversation?.id === conv.id}
                    onSelect={(id) => {
                      selectConversation(id)
                      // Ensure main content shows chat when selecting a conversation
                      onViewChange('chat')
                    }}
                    onDelete={(id) => {
                      const target = conversations.find((c) => c.id === id)
                      if (target && target.title === 'New Conversation') {
                        closeConversation(id)
                      } else {
                        setDeleteTarget(id)
                      }
                    }}
                    onRename={renameConversation}
                  />
                ))
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <nav className="p-2">
              {/* Tools group */}
              <div className="px-3 pt-1 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  Tools
                </span>
              </div>
              <div className="space-y-0.5">
                {SETTINGS_MENU.filter((item) => item.group === 'tools').map((item) => {
                  const Icon = item.icon
                  const isActive = activeSettingsTab === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSettingsTabChange(item.id)}
                      className={`flex items-center gap-2.5 w-full rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 px-3 py-2 ${
                        isActive
                          ? 'bg-primary-muted text-primary-text border border-primary/20'
                          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                      }`}
                    >
                      <Icon size={16} className={isActive ? undefined : item.iconColor} />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>

              {/* Divider between groups */}
              <div className="my-2 mx-2 border-t border-border-subtle" />

              {/* Configuration group */}
              <div className="px-3 pt-1 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  Configuration
                </span>
              </div>
              <div className="space-y-0.5">
                {SETTINGS_MENU.filter((item) => item.group === 'configuration').map((item) => {
                  const Icon = item.icon
                  const isActive = activeSettingsTab === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSettingsTabChange(item.id)}
                      className={`flex items-center gap-2.5 w-full rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 px-3 py-2 ${
                        isActive
                          ? 'bg-primary-muted text-primary-text border border-primary/20'
                          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                      }`}
                    >
                      <Icon size={16} className={isActive ? undefined : item.iconColor} />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </nav>
          )}
        </div>
      </div>

      {/* Dialogs — rendered outside sidebar container */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Conversation"
        message="Are you sure? This will permanently delete this conversation and all its messages."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          if (deleteTarget) {
            await closeConversation(deleteTarget)
            setDeleteTarget(null)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}

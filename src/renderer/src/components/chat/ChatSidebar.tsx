import { useState, useEffect } from 'react';
import { Plus, MessageSquare, FolderOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import { useChatStore, useWorkspaceStore } from '@renderer/store';
import { ChatItem } from '@renderer/components/chat';
import { ConfirmDialog } from '@renderer/components/common';

interface ChatSidebarProps {
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function ChatSidebar({
  isCollapsed: externalCollapsed,
  onToggleCollapse
}: ChatSidebarProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore();
  const {
    conversations,
    activeConversation,
    loadConversations,
    createConversation,
    selectConversation,
    closeConversation,
    renameConversation
  } = useChatStore();

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const isCollapsed = externalCollapsed ?? internalCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed((c) => !c));

  // Load conversations when workspace changes
  useEffect(() => {
    if (activeWorkspace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConversationsLoaded(false);
      loadConversations(activeWorkspace.id).then(() => {
        setConversationsLoaded(true);
      });
    }
  }, [activeWorkspace, loadConversations]);

  // Auto-create conversation when workspace is opened with no conversations
  useEffect(() => {
    if (activeWorkspace && conversationsLoaded && conversations.length === 0 && !activeConversation) {
      createConversation(activeWorkspace.id);
    }
  }, [activeWorkspace, conversationsLoaded, conversations.length, activeConversation, createConversation]);

  const handleNewChat = async (): Promise<void> => {
    if (activeWorkspace) {
      await createConversation(activeWorkspace.id, 'plan');
    }
  };

  const sortedConversations = [...conversations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 h-full bg-gray-900 border-r border-gray-700">
        {/* Header area — matches expanded header height for continuous border line */}
        <div className="flex items-center justify-center w-full py-3 border-b border-gray-700">
          <button
            onClick={toggleCollapse}
            className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex flex-col items-center gap-2 py-3 w-full flex-1">

        {/* New chat button */}
        <button
          onClick={handleNewChat}
          className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-800 text-gray-400 hover:bg-indigo-600 hover:text-white transition-colors"
          aria-label="New chat"
          title="New chat"
        >
          <Plus size={14} />
        </button>

        {/* Conversation initials */}
        {sortedConversations.slice(0, 8).map((conv) => (
          <button
            key={conv.id}
            onClick={() => selectConversation(conv.id)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold transition-colors ${
              activeConversation?.id === conv.id
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
            title={conv.title}
            aria-label={`Open conversation: ${conv.title}`}
          >
            {conv.title.charAt(0).toUpperCase()}
          </button>
        ))}

        </div>
      </div>
    );
  }

  return (
    <>
    <div className="flex flex-col w-60 h-full bg-gray-900 border-r border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={16} className="text-indigo-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-gray-200 truncate">
            {activeWorkspace?.name ?? 'Agent Studio'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleNewChat}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-indigo-400 transition-colors"
            aria-label="New chat"
            title="New Chat (Cmd+N)"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={toggleCollapse}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {!activeWorkspace ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <FolderOpen size={32} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No workspace selected</p>
            <p className="text-xs text-gray-600">Select a workspace to start</p>
          </div>
        ) : sortedConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <MessageSquare size={32} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No conversations yet</p>
            <p className="text-xs text-gray-600">Click + to start a chat</p>
          </div>
        ) : (
          sortedConversations.map((conv) => (
            <ChatItem
              key={conv.id}
              conversation={conv}
              isActive={activeConversation?.id === conv.id}
              onSelect={selectConversation}
              onDelete={(id) => {
                // Skip confirmation for new/empty conversations (no interaction yet)
                const target = conversations.find((c) => c.id === id);
                if (target && target.title === 'New Conversation') {
                  closeConversation(id);
                } else {
                  setDeleteTarget(id);
                }
              }}
              onRename={renameConversation}
            />
          ))
        )}
      </div>

    </div>

    <ConfirmDialog
      isOpen={deleteTarget !== null}
      title="Delete Conversation"
      message="Are you sure? This will permanently delete this conversation and all its messages."
      confirmLabel="Delete"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={async () => {
        if (deleteTarget) {
          await closeConversation(deleteTarget);
          setDeleteTarget(null);
        }
      }}
      onCancel={() => setDeleteTarget(null)}
    />
    </>
  );
}

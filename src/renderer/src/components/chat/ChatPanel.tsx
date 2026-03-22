import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Bot, FolderOpen } from 'lucide-react';
import { useChatStore, useWorkspaceStore } from '@renderer/store';
import { MessageList, MessageInput, AttachmentDropzone, ModeToggle } from '@renderer/components/chat';

export default function ChatPanel(): React.JSX.Element {
  const { activeWorkspace, workspaces, openWorkspace, createWorkspace, orchestratorStatus } = useWorkspaceStore();
  const { activeConversation, messages, createConversation, updateMode, isStreaming } = useChatStore();
  const [attachments, setAttachments] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
    }
  }, [showSearch]);

  const handleAddWorkspace = useCallback(async (): Promise<void> => {
    try {
      const dirPath = await window.api.selectDirectory();
      if (dirPath) {
        const name = dirPath.split('/').pop() || dirPath.split('\\').pop() || 'Untitled';
        await createWorkspace(name, dirPath);
      }
    } catch (error) {
      console.error('Failed to add workspace:', error);
    }
  }, [createWorkspace]);

  // No workspace selected — workspace selector
  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 via-gray-800/30 to-gray-900 text-center px-8">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
            <Bot size={28} className="text-indigo-400" />
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-bold text-gray-100">Agent Studio</h1>
            <p className="text-sm text-gray-500">AI-Powered Development Team</p>
          </div>
        </div>

        {/* Workspace selector card */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-6 max-w-md w-full mb-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider">
            Select a Workspace
          </h3>

          {workspaces.length > 0 ? (
            <div className="space-y-2 mb-4">
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => openWorkspace(ws.id)}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-gray-700/50 transition-colors text-left"
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-600/20 text-indigo-400 text-sm font-semibold">
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-200 truncate">{ws.name}</div>
                    <div className="text-xs text-gray-500 truncate">{ws.repoPath}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 mb-4">No workspaces yet. Add a project folder to get started.</p>
          )}
        </div>

        <button
          onClick={handleAddWorkspace}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
        >
          <FolderOpen size={16} />
          Add Workspace
        </button>
      </div>
    );
  }

  // Workspace selected but no active conversation — ready placeholder
  if (!activeConversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-900 text-center px-8">
        <div className="w-16 h-16 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center mb-4">
          <Bot size={32} className="text-indigo-400/60" />
        </div>
        <h2 className="text-lg font-semibold text-gray-300 mb-1">Ready to work</h2>
        <p className="text-sm text-gray-500 mb-6">Start a conversation with your AI development partner</p>
        <button
          onClick={() => createConversation(activeWorkspace.id, 'plan')}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          💬 Start a conversation
        </button>
      </div>
    );
  }

  // Filter messages for search
  const filteredMessages = searchQuery
    ? messages.filter((m) => m.contentMd.toLowerCase().includes(searchQuery.toLowerCase()))
    : [];

  return (
    <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
      {/* Simplified Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-700 bg-gray-900">
        <span className="text-sm font-medium text-gray-200">
          {activeConversation?.title || 'New Chat'}
        </span>
        <div className="flex items-center gap-2">
          <ModeToggle
            mode={activeConversation.mode}
            onChange={(mode) => updateMode(mode)}
            disabled={isStreaming}
          />
        <button
          onClick={() => setShowSearch((prev) => !prev)}
          className={`p-1.5 rounded-md transition-colors ${showSearch ? 'bg-gray-800 text-indigo-400' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
          aria-label="Search messages"
          aria-pressed={showSearch}
          title="Search messages"
        >
          <Search size={14} />
        </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-gray-700 bg-gray-900/60">
          <Search size={14} className="text-gray-500" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-500 outline-none"
            aria-label="Search messages"
          />
          {searchQuery && (
            <span className="text-xs text-gray-500">
              {filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={() => {
              setShowSearch(false);
              setSearchQuery('');
            }}
            className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Messages or initialization overlay */}
      {orchestratorStatus === 'starting' ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="relative mb-6">
            {/* Pulsing ring animation */}
            <div className="w-16 h-16 rounded-full border-2 border-indigo-500/30 animate-ping absolute inset-0" />
            <div className="w-16 h-16 rounded-full bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center relative">
              <Bot size={28} className="text-indigo-400 animate-pulse" />
            </div>
          </div>
          <h3 className="text-lg font-medium text-gray-300 mb-2">Initializing AI Agent...</h3>
          <p className="text-sm text-gray-500 max-w-sm">
            Setting up the workspace context and connecting to Claude CLI. This may take up to a minute for large projects.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <MessageList searchQuery={searchQuery} />
        </div>
      )}

      {/* Input - pinned to bottom */}
      <div className="flex-shrink-0 px-6 pb-4 pt-2">
        <AttachmentDropzone attachments={attachments} onAttachmentsChange={setAttachments}>
          <MessageInput attachments={attachments} onClearAttachments={() => setAttachments([])} />
        </AttachmentDropzone>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Bot, FolderOpen, MessageSquarePlus } from 'lucide-react'
import { useChatStore, useWorkspaceStore } from '@renderer/store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  ModeToggle
} from '@renderer/components/chat'

export default function ChatPanel(): React.JSX.Element {
  const { activeWorkspace, workspaces, openWorkspace, createWorkspace, orchestratorStatus } =
    useWorkspaceStore()
  const { activeConversation, messages, createConversation, updateMode, isStreaming } =
    useChatStore()
  const [attachments, setAttachments] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus()
    }
  }, [showSearch])

  const handleAddWorkspace = useCallback(async (): Promise<void> => {
    try {
      const dirPath = await window.api.selectDirectory()
      if (dirPath) {
        const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || 'Untitled'
        await createWorkspace(name, dirPath)
      }
    } catch (error) {
      console.error('Failed to add workspace:', error)
    }
  }, [createWorkspace])

  // No workspace selected — workspace selector
  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-surface-base via-surface-overlay/30 to-surface-base text-center px-8">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary-muted border border-primary/30 flex items-center justify-center">
            <Bot size={28} className="text-primary-text" />
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-bold text-text-primary">Agent Studio</h1>
            <p className="text-sm text-text-secondary">AI-Powered Development Team</p>
          </div>
        </div>

        {/* Workspace selector card */}
        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-6 max-w-md w-full mb-6 shadow-lg">
          <h3 className="text-sm font-semibold text-text-primary mb-4 uppercase tracking-wider">
            Select a Workspace
          </h3>

          {workspaces.length > 0 ? (
            <div className="space-y-2 mb-4">
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => openWorkspace(ws.id)}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-surface-float transition-colors text-left focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary-muted text-primary-text text-sm font-semibold">
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{ws.name}</div>
                    <div className="text-xs text-text-secondary truncate">{ws.repoPath}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-secondary mb-4">
              No workspaces yet. Add a project folder to get started.
            </p>
          )}
        </div>

        <button
          onClick={handleAddWorkspace}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          <FolderOpen size={16} />
          Add Workspace
        </button>
      </div>
    )
  }

  // Workspace selected but no active conversation — ready placeholder
  if (!activeConversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-surface-raised text-center px-8">
        <div className="w-16 h-16 rounded-2xl bg-primary-muted border border-primary/20 flex items-center justify-center mb-4">
          <Bot size={32} className="text-primary-text/60" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">Ready to work</h2>
        <p className="text-sm text-text-secondary mb-6">
          Start a conversation with your AI development partner
        </p>
        <button
          onClick={() => createConversation(activeWorkspace.id, 'plan')}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <MessageSquarePlus size={16} />
          Start a conversation
        </button>
      </div>
    )
  }

  // Filter messages for search
  const filteredMessages = searchQuery
    ? messages.filter((m) => m.contentMd.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Simplified Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <span className="text-sm font-medium text-text-primary">
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
            className={`p-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${showSearch ? 'bg-surface-overlay text-primary-text' : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'}`}
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
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border-subtle bg-surface-overlay/60">
          <Search size={14} className="text-text-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-sm text-text-body placeholder-text-muted outline-none"
            aria-label="Search messages"
          />
          {searchQuery && (
            <span className="text-xs text-text-secondary">
              {filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={() => {
              setShowSearch(false)
              setSearchQuery('')
            }}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
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
            <div className="w-16 h-16 rounded-full border-2 border-primary/30 animate-ping absolute inset-0" />
            <div className="w-16 h-16 rounded-full bg-primary-muted border border-primary/40 flex items-center justify-center relative">
              <Bot size={28} className="text-primary-text animate-pulse" />
            </div>
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-2">Initializing AI Agent...</h3>
          <p className="text-sm text-text-secondary max-w-sm">
            Setting up the workspace context and connecting to Claude CLI. This may take up to a
            minute for large projects.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.3s]" />
            <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.15s]" />
            <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce" />
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
  )
}

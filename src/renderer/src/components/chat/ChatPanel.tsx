import { useState, useEffect, useRef } from 'react'
import { Search, X, Bot, MessageSquarePlus } from 'lucide-react'
import { useChatStore, useWorkspaceStore } from '@renderer/store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  ModeToggle,
  RepoWarningBanner,
  NewConversationModal
} from '@renderer/components/chat'
import type { ConversationMode } from '../../../../shared/types'

interface ChatPanelProps {
  onCreateIdea?: (data: { title: string; description?: string }) => void
}

export default function ChatPanel({ onCreateIdea }: ChatPanelProps): React.JSX.Element {
  const { activeWorkspace, orchestratorStatus } = useWorkspaceStore()
  const { activeConversation, messages, createConversation, updateMode, isStreaming, sendMessage } =
    useChatStore()
  const [attachments, setAttachments] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus()
    }
  }, [showSearch])

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
          onClick={() => setShowNewChatModal(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 press-scale"
        >
          <MessageSquarePlus size={16} />
          Start a conversation
        </button>
        <NewConversationModal
          isOpen={showNewChatModal}
          onClose={() => setShowNewChatModal(false)}
          onSubmit={handleCreateChat}
          onCreateIdea={onCreateIdea}
        />
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

      {/* Repo/GitHub warning banner */}
      <RepoWarningBanner />

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

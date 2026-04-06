import { useState, useEffect, useRef, useMemo } from 'react'
import { Search, X, Bot, MessageSquarePlus, Braces, SearchCode } from 'lucide-react'
import { useChatStore, useChatActions, useWorkspaceStore, useProfileStore, useConversationSpecialists, useSpecialistStore, useCodeChangesStore, useAgentStore } from '@renderer/store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone,
  ModeToggle,
  RepoWarningBanner,
  NewConversationModal
} from '@renderer/components/chat'
import ChatTabButton from './ChatTabButton'
import SpecialistsTable from './SpecialistsTable'
import CodeChangesPanel from './CodeChangesPanel'
import type { ConversationMode } from '../../../../shared/types'

type ChatTab = 'chat' | 'specialists' | 'code-changes'

interface ChatPanelProps {
  onCreateIdea?: (data: { title: string; description?: string }) => void
  onStartGrillMe?: () => Promise<void>
}

export default function ChatPanel({ onCreateIdea, onStartGrillMe }: ChatPanelProps): React.JSX.Element {
  const { activeWorkspace, agentStatus } = useWorkspaceStore()
  const { createConversation, updateMode, sendMessage } = useChatActions()
  const activeConversation = useChatStore((s) => s.activeConversation)
  const userName = useProfileStore((s) => s.profile?.displayName?.split(' ')[0] ?? null)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [attachments, setAttachments] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [activeTab, setActiveTab] = useState<ChatTab>('chat')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Specialist count for tab badge
  const conversationSpecialists = useConversationSpecialists(activeConversation?.id ?? '')
  const workspaceSpecialists = useSpecialistStore((state) => state.specialists)
  const activeSpecialistCount = useMemo(() => {
    const coreIds = new Set(workspaceSpecialists.filter((s) => s.isCore).map((s) => s.id))
    return conversationSpecialists.filter(
      (s) => s.isActive && !coreIds.has(s.specialistId)
    ).length
  }, [conversationSpecialists, workspaceSpecialists])

  // Code changes count for tab badge
  const pendingChangesCount = useCodeChangesStore((s) => s.files.length)

  // Active MCP tools from generalist status
  const activeMcpTools = useAgentStore((s) => {
    const generalist = s.statuses.find((st) => st.agentType === 'generalist')
    return generalist?.activeMcpTools
  })

  // Load code changes when conversation changes
  const loadFiles = useCodeChangesStore((s) => s.loadFiles)
  useEffect(() => {
    if (activeConversation?.id) {
      void loadFiles(activeConversation.id)
    }
  }, [activeConversation?.id, loadFiles])

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus()
    }
  }, [showSearch])

  // Reset tab when conversation changes
  useEffect(() => {
    setActiveTab('chat')
  }, [activeConversation?.id])

  const handleCreateChat = async (data: {
    title: string
    description?: string
    mode: ConversationMode
    attachments?: string[]
    useIsolatedBranch?: boolean
  }): Promise<void> => {
    if (!activeWorkspace) return
    await createConversation(activeWorkspace.id, data.mode, data.title)
    setShowNewChatModal(false)
    if (data.useIsolatedBranch) {
      console.info(
        '[NewConversationModal] Isolated branch requested — worktree integration pending'
      )
    }
    if (data.description) {
      sendMessage(data.description, data.attachments)
    }
  }

  // Workspace selected but no active conversation — ready placeholder
  if (!activeConversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-surface-raised text-center px-8">
        <div className="w-16 h-16 rounded-2xl bg-primary-muted border border-primary/20 flex items-center justify-center mb-4">
          <Bot size={32} className="text-primary-text/60" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">
          {userName ? `Hey ${userName}, ready to build?` : 'Ready to work'}
        </h2>
        <p className="text-sm text-text-secondary mb-6">
          {userName
            ? 'Kick off a new conversation — brainstorm, plan, or jump straight into code.'
            : 'Start a conversation with your AI development partner'}
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
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0 min-h-0">
      {/* Header with Tab Bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-1" role="tablist" aria-label="Chat panel tabs">
          <ChatTabButton active={activeTab === 'chat'} onClick={() => setActiveTab('chat')}>
            Chat
          </ChatTabButton>
          <ChatTabButton
            active={activeTab === 'specialists'}
            onClick={() => setActiveTab('specialists')}
            badge={activeSpecialistCount}
          >
            Specialists
          </ChatTabButton>
          <ChatTabButton
            active={activeTab === 'code-changes'}
            onClick={() => setActiveTab('code-changes')}
            badge={pendingChangesCount}
          >
            Code Changes
          </ChatTabButton>
        </div>
        {activeTab === 'chat' && activeMcpTools && activeMcpTools.length > 0 && (
          <div className="flex items-center gap-1.5">
            {activeMcpTools.includes('code-graph') && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full">
                <Braces size={10} /> Code Graph
              </span>
            )}
            {activeMcpTools.includes('semantic-search') && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded-full">
                <SearchCode size={10} /> Semantic
              </span>
            )}
          </div>
        )}
        {activeTab === 'chat' && (
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
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'chat' && (
        <>
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
          {agentStatus === 'starting' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-full border-2 border-primary/30 animate-ping absolute inset-0" />
                <div className="w-16 h-16 rounded-full bg-primary-muted border border-primary/40 flex items-center justify-center relative">
                  <Bot size={28} className="text-primary-text animate-pulse" />
                </div>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">Initializing AI Agent...</h3>
              <p className="text-sm text-text-secondary max-w-sm">
                Setting up the workspace context and initializing the AI agent. This may take a few
                seconds.
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
            <AttachmentDropzone attachments={attachments} onAttachmentsChange={setAttachments} conversationId={activeConversation.id}>
              <MessageInput attachments={attachments} onClearAttachments={() => setAttachments([])} onStartGrillMe={onStartGrillMe} />
            </AttachmentDropzone>
          </div>
        </>
      )}

      {activeTab === 'specialists' && (
        <SpecialistsTable conversationId={activeConversation.id} />
      )}

      {activeTab === 'code-changes' && (
        <CodeChangesPanel conversationId={activeConversation.id} />
      )}
    </div>
  )
}

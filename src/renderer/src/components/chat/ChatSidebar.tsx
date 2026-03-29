import { useState, useEffect } from 'react'
import { Plus, MessageSquare, FolderOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { useChatStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import {
  ChatItem,
  UnsavedChangesDialog,
  CompleteDialog,
  NewConversationModal
} from '@renderer/components/chat'
import { ConfirmDialog } from '@renderer/components/common'
import type { ConversationMode } from '../../../../shared/types'

interface ChatSidebarProps {
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  onCreateIdea?: (data: { title: string; description?: string }) => void
}

export default function ChatSidebar({
  isCollapsed: externalCollapsed,
  onToggleCollapse,
  onCreateIdea
}: ChatSidebarProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    loadConversations,
    createConversation,
    selectConversation,
    closeConversation,
    renameConversation,
    sendMessage
  } = useChatActions()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversation = useChatStore((s) => s.activeConversation)

  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [unsavedTarget, setUnsavedTarget] = useState<{
    id: string
    files: string[]
    fileCount: number
  } | null>(null)
  const [completeFromUnsaved, setCompleteFromUnsaved] = useState<string | null>(null)
  const [showNewChatModal, setShowNewChatModal] = useState(false)

  const isCollapsed = externalCollapsed ?? internalCollapsed
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed((c) => !c))

  // Load conversations when workspace changes
  useEffect(() => {
    if (activeWorkspace) {
      loadConversations(activeWorkspace.id)
    }
  }, [activeWorkspace, loadConversations])


  const handleNewChat = (): void => {
    setShowNewChatModal(true)
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

  const sortedConversations = [...conversations]
    .filter((c) => !c.title.startsWith('\u{1F4A1} Grill:'))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 h-full bg-surface-raised border-r border-border-subtle">
        {/* Header area — matches expanded header height for continuous border line */}
        <div className="flex items-center justify-center w-full py-3 border-b border-border-subtle">
          <button
            onClick={toggleCollapse}
            className="p-2 rounded-lg hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
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
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-overlay text-text-secondary hover:bg-primary hover:text-white transition-colors"
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
              className={`flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold transition-colors press-scale ${
                activeConversation?.id === conv.id
                  ? 'bg-primary text-white'
                  : 'bg-surface-overlay text-text-secondary hover:bg-surface-float'
              }`}
              title={conv.title}
              aria-label={`Open conversation: ${conv.title}`}
            >
              {conv.title.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    )
  }

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
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-primary-text transition-colors"
              aria-label="New chat"
              title="New Chat (Cmd+N)"
            >
              <Plus size={16} />
            </button>
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

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
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
                onSelect={selectConversation}
                onDelete={(id) => {
                  // Skip confirmation for new/empty conversations (no interaction yet)
                  const target = conversations.find((c) => c.id === id)
                  if (target && target.title === 'New Conversation') {
                    closeConversation(id)
                  } else {
                    // Check for unsaved changes before showing delete dialog
                    window.api
                      .hasUnsavedChanges({ conversationId: id })
                      .then((result) => {
                        if (result.hasChanges) {
                          setUnsavedTarget({
                            id,
                            files: result.files,
                            fileCount: result.fileCount
                          })
                        } else {
                          setDeleteTarget(id)
                        }
                      })
                      .catch(() => {
                        // Fallback to regular delete
                        setDeleteTarget(id)
                      })
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
            await closeConversation(deleteTarget)
            setDeleteTarget(null)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Unsaved changes dialog */}
      <UnsavedChangesDialog
        isOpen={unsavedTarget !== null}
        files={unsavedTarget?.files ?? []}
        fileCount={unsavedTarget?.fileCount ?? 0}
        onCancel={() => setUnsavedTarget(null)}
        onDiscard={async () => {
          if (unsavedTarget) {
            await closeConversation(unsavedTarget.id)
            setUnsavedTarget(null)
          }
        }}
        onCommit={() => {
          if (unsavedTarget) {
            setCompleteFromUnsaved(unsavedTarget.id)
            setUnsavedTarget(null)
          }
        }}
      />

      {/* Complete dialog triggered from unsaved changes */}
      <CompleteDialog
        isOpen={completeFromUnsaved !== null}
        conversationTitle={
          conversations.find((c) => c.id === completeFromUnsaved)?.title ?? 'Untitled'
        }
        conversationId={completeFromUnsaved ?? ''}
        onConfirm={async (branchName, commitMessage, description) => {
          await window.api.completeConversation({
            conversationId: completeFromUnsaved!,
            branchName,
            commitMessage,
            description
          })
          // Remove from local state
          useChatStore.getState().loadConversations(activeWorkspace!.id)
          setCompleteFromUnsaved(null)
        }}
        onCancel={() => setCompleteFromUnsaved(null)}
      />

      {/* New conversation modal */}
      <NewConversationModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSubmit={handleCreateChat}
        onCreateIdea={onCreateIdea}
      />
    </>
  )
}

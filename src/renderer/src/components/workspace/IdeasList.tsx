import { useEffect, useState } from 'react'
import { Lightbulb, Flame, Play, Trash2, CheckCircle, ExternalLink, Pencil, Check, X } from 'lucide-react'
import { useIdeaStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import type { Idea } from '../../../../shared/types'

interface IdeasListProps {
  onNavigateToChat: () => void
  onOpenGrillSession?: (ideaId: string, conversationId: string, ideaTitle: string, isNewSession?: boolean, ideaDescription?: string) => void
}

function StatusBadge({ status }: { status: Idea['status'] }): React.JSX.Element {
  const config = {
    draft: {
      icon: Lightbulb,
      label: 'Draft',
      className: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
    },
    grilling: {
      icon: Flame,
      label: 'Grilling',
      className: 'text-orange-400 bg-orange-500/10 border-orange-500/20'
    },
    completed: {
      icon: CheckCircle,
      label: 'Completed',
      className: 'text-green-400 bg-green-500/10 border-green-500/20'
    }
  }

  const { icon: Icon, label, className } = config[status]

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${className}`}
    >
      <Icon size={10} />
      {label}
    </span>
  )
}

export default function IdeasList({ onNavigateToChat, onOpenGrillSession }: IdeasListProps): React.JSX.Element {
  const { ideas, loadIdeas, deleteIdea, updateIdea, startGrill, convertDirect, isLoading } = useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage, loadConversations } = useChatActions()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const startEditing = (idea: Idea): void => {
    setEditingId(idea.id)
    setEditTitle(idea.title)
    setEditDescription(idea.description || '')
  }

  const cancelEditing = (): void => {
    setEditingId(null)
    setEditTitle('')
    setEditDescription('')
  }

  const saveEditing = async (): Promise<void> => {
    if (!editingId || !editTitle.trim()) return
    try {
      await updateIdea(editingId, { title: editTitle.trim(), description: editDescription.trim() })
    } catch (error) {
      console.error('Failed to update idea:', error)
    } finally {
      cancelEditing()
    }
  }

  useEffect(() => {
    if (activeWorkspace) {
      loadIdeas(activeWorkspace.id)
    }
  }, [activeWorkspace, loadIdeas])

  const handleConvertDirect = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      const { idea: updatedIdea, conversation } = await convertDirect(idea.id, activeWorkspace.id)
      // Refresh conversations so the newly-created conversation is in the chat store
      await loadConversations(activeWorkspace.id)
      await selectConversation(conversation.id)
      const initialMessage = `## Idea: ${updatedIdea.title}\n\n${updatedIdea.description || 'No description provided.'}\n\nPlease help me work on this idea.`
      await sendMessage(initialMessage)
      onNavigateToChat()
    } catch (error) {
      console.error('Failed to convert idea:', error)
    }
  }

  const handleStartGrill = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      const { idea: updatedIdea, conversation } = await startGrill(idea.id, activeWorkspace.id)

      // Determine if this is a brand-new grill session (needs initial prompt)
      const isNewSession = !idea.grillConversationId || idea.grillConversationId !== conversation.id

      // Open the dedicated grill session view — prompt will be sent AFTER conversation loads
      if (onOpenGrillSession) {
        onOpenGrillSession(updatedIdea.id, conversation.id, updatedIdea.title, isNewSession, updatedIdea.description)
      } else {
        // Fallback: navigate to chat
        await loadConversations(activeWorkspace.id)
        await selectConversation(conversation.id)
        if (isNewSession) {
          const grillPrompt = `[GRILL MODE]\n\n## Evaluate This Requirement\n**${updatedIdea.title}**\n\n${updatedIdea.description || 'No description provided.'}\n\nAnalyze this requirement and respond with a single grill-evaluation JSON block containing a completeness score (1-100), brief feedback, and exactly 5 questions targeting the weakest areas.`
          await sendMessage(grillPrompt)
        }
        onNavigateToChat()
      }
    } catch (error) {
      console.error('Failed to start grill:', error)
    }
  }

  const handleContinueGrill = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      // Always go through startGrill — it handles resume (conv exists) or
      // fresh-start (conv was lost/deleted) transparently on the backend.
      const { idea: updatedIdea, conversation } = await startGrill(idea.id, activeWorkspace.id)

      const isNewConversation = idea.grillConversationId !== conversation.id

      // Open the dedicated grill session view — prompt will be sent AFTER conversation loads
      if (onOpenGrillSession) {
        onOpenGrillSession(updatedIdea.id, conversation.id, updatedIdea.title, isNewConversation, updatedIdea.description)
      } else {
        // Fallback: navigate to chat if no grill view handler provided
        await loadConversations(activeWorkspace.id)
        await selectConversation(conversation.id)
        if (isNewConversation) {
          const grillPrompt = `[GRILL MODE]\n\n## Evaluate This Requirement\n**${updatedIdea.title}**\n\n${updatedIdea.description || 'No description provided.'}\n\nAnalyze this requirement and respond with a single grill-evaluation JSON block containing a completeness score (1-100), brief feedback, and exactly 5 questions targeting the weakest areas.`
          await sendMessage(grillPrompt)
        }
        onNavigateToChat()
      }
    } catch (error) {
      console.error('Failed to continue grill:', error)
    }
  }

  const handleGoToConversation = async (conversationId: string): Promise<void> => {
    if (!activeWorkspace) return
    try {
      await loadConversations(activeWorkspace.id)
      await selectConversation(conversationId)
      onNavigateToChat()
    } catch (error) {
      console.error('Failed to navigate to conversation:', error)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await deleteIdea(deleteTarget)
    } catch (error) {
      console.error('Failed to delete idea:', error)
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3 py-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-surface-overlay border border-border-subtle rounded-xl p-4 flex items-start gap-3"
          >
            <Skeleton className="h-8 w-8 rounded-lg flex-shrink-0" />
            <div className="flex-1">
              <Skeleton className="h-4 w-40 mb-2" />
              <Skeleton className="h-3 w-64 mb-1.5" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (ideas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Lightbulb size={32} className="text-yellow-400/30 mb-3" />
        <p className="text-sm text-text-secondary mb-1">No ideas yet</p>
        <p className="text-xs text-text-muted">
          Use the <Lightbulb size={10} className="inline text-yellow-400" /> button in the chat
          input to capture ideas.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-2">
        {ideas.map((idea) => (
          <div
            key={idea.id}
            className="group bg-surface-overlay border border-border-subtle rounded-lg p-4 hover:border-border-default transition-colors shadow-sm"
          >
            {editingId === idea.id ? (
              /* Inline editing mode */
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {idea.status === 'grilling' ? (
                    <Flame size={14} className="text-orange-400 flex-shrink-0" />
                  ) : (
                    <Lightbulb size={14} className="text-yellow-400 flex-shrink-0" />
                  )}
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEditing()
                      if (e.key === 'Escape') cancelEditing()
                    }}
                    className="flex-1 bg-surface-base border border-border-default rounded-md px-2 py-1 text-sm font-medium text-text-primary outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                    autoFocus
                  />
                </div>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') cancelEditing()
                  }}
                  placeholder="Add a description..."
                  rows={5}
                  className="w-full bg-surface-base border border-border-default rounded-md px-2 py-1.5 text-xs text-text-secondary outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-none ml-[22px]"
                  style={{ width: 'calc(100% - 22px)' }}
                />
                <div className="flex items-center gap-1.5 ml-[22px]">
                  <button
                    onClick={saveEditing}
                    disabled={!editTitle.trim()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-green-300 bg-green-500/10 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Check size={12} />
                    Save
                  </button>
                  <button
                    onClick={cancelEditing}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-lg transition-colors"
                  >
                    <X size={12} />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Title row */}
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {idea.status === 'grilling' ? (
                      <Flame size={14} className="text-orange-400 flex-shrink-0" />
                    ) : idea.status === 'completed' ? (
                      <CheckCircle size={14} className="text-green-400 flex-shrink-0" />
                    ) : (
                      <Lightbulb size={14} className="text-yellow-400 flex-shrink-0" />
                    )}
                    <span className="text-sm font-medium text-text-primary truncate">{idea.title}</span>
                    {idea.status !== 'completed' && (
                      <button
                        onClick={() => startEditing(idea)}
                        className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors opacity-0 group-hover:opacity-100"
                        aria-label="Edit idea"
                        title="Edit idea"
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                  </div>
                  <StatusBadge status={idea.status} />
                </div>

                {/* Description */}
                {idea.description && (
                  <p className="text-xs text-text-secondary mb-3 ml-[22px] line-clamp-2">
                    {idea.description}
                  </p>
                )}
              </>
            )}

            {/* Actions — hidden while editing */}
            {editingId !== idea.id && (
            <div className="flex items-center gap-2 ml-[22px]">
              {idea.status === 'draft' && (
                <>
                  <button
                    onClick={() => handleStartGrill(idea)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 transition-colors"
                  >
                    <Flame size={12} />
                    Grill Me
                  </button>
                  <button
                    onClick={() => handleConvertDirect(idea)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
                  >
                    <Play size={12} />
                    Convert Directly
                  </button>
                </>
              )}

              {idea.status === 'grilling' && (
                <>
                  <button
                    onClick={() => handleContinueGrill(idea)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 transition-colors"
                  >
                    <Flame size={12} />
                    Continue Grill
                  </button>
                  <button
                    disabled
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-muted bg-surface-overlay border border-border-subtle rounded-lg cursor-not-allowed opacity-50"
                    title="Complete the Grill Me session first"
                  >
                    <Play size={12} />
                    Convert Directly
                  </button>
                </>
              )}

              {idea.status === 'completed' && idea.convertedConversationId && (
                <button
                  onClick={() => handleGoToConversation(idea.convertedConversationId!)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-green-300 bg-green-500/10 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors"
                >
                  <ExternalLink size={12} />
                  Go to Conversation
                </button>
              )}

              {idea.status === 'completed' &&
                idea.grillConversationId &&
                !idea.convertedConversationId && (
                  <button
                    onClick={() => handleGoToConversation(idea.grillConversationId!)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-green-300 bg-green-500/10 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors"
                  >
                    <ExternalLink size={12} />
                    Go to Grill Conversation
                  </button>
                )}

              {/* Delete button — always available */}
              <button
                onClick={() => setDeleteTarget(idea.id)}
                className="inline-flex items-center p-1 text-text-muted hover:text-red-400 hover:bg-danger-muted rounded-md transition-colors ml-auto"
                aria-label="Delete idea"
                title="Delete idea"
              >
                <Trash2 size={12} />
              </button>
            </div>
            )}

            {/* Grill summary */}
            {idea.grillSummary && idea.status === 'completed' && (
              <div className="mt-2 ml-[22px] p-2 bg-surface-base rounded-md border border-border-subtle">
                <span className="text-xs text-text-muted font-medium">Grill Summary:</span>
                <p className="text-xs text-text-secondary mt-0.5 line-clamp-3">
                  {idea.grillSummary}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Idea"
        message="Are you sure you want to delete this idea? This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}

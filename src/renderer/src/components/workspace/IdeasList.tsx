import { useEffect, useMemo, useState } from 'react'
import {
  Lightbulb,
  Flame,
  Play,
  Trash2,
  CheckCircle,
  ExternalLink,
  Pencil,
  Check,
  X,
  Search,
  Plus
} from 'lucide-react'
import { useIdeaStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import type { Idea } from '../../../../shared/types'

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' }
] as const

type IdeaFilter = (typeof FILTER_TABS)[number]['value']

interface IdeasListProps {
  onNavigateToChat: () => void
  onOpenGrillSession?: (
    ideaId: string,
    conversationId: string,
    ideaTitle: string,
    isNewSession?: boolean,
    ideaDescription?: string
  ) => void
}

function StatusBadge({ status }: { status: Idea['status'] }): React.JSX.Element {
  const config = {
    draft: {
      icon: Lightbulb,
      label: 'Draft',
      className: 'text-warning bg-warning-muted border-warning/20'
    },
    grilling: {
      icon: Flame,
      label: 'Grilling',
      className: 'text-accent bg-accent-muted border-accent/20'
    },
    completed: {
      icon: CheckCircle,
      label: 'Completed',
      className: 'text-success bg-success-muted border-success/20'
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

function GrillSummaryPreview({ summary }: { summary: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mt-2 ml-[22px] p-2 bg-surface-raised rounded-md border border-border-default">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary font-medium">Grill Summary:</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary-text hover:text-primary-hover transition-colors"
        >
          {expanded ? 'Collapse' : 'Show all'}
        </button>
      </div>
      <div
        className={`text-xs text-text-body mt-0.5 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}
      >
        {summary}
      </div>
    </div>
  )
}

export default function IdeasList({
  onNavigateToChat,
  onOpenGrillSession
}: IdeasListProps): React.JSX.Element {
  const { ideas, loadIdeas, deleteIdea, updateIdea, startGrill, convertDirect, createIdea, isLoading } =
    useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage, loadConversations } = useChatActions()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [filter, setFilter] = useState<IdeaFilter>('active')
  const [searchQuery, setSearchQuery] = useState('')

  // New Idea modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleCreateIdea = async (): Promise<void> => {
    if (!newTitle.trim() || !activeWorkspace || isCreating) return
    setIsCreating(true)
    try {
      await createIdea(activeWorkspace.id, newTitle.trim(), newDescription.trim())
      setShowCreateModal(false)
      setNewTitle('')
      setNewDescription('')
    } catch (error) {
      console.error('Failed to create idea:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const filteredIdeas = useMemo(() => {
    let result = ideas

    // Apply status filter
    if (filter === 'active') {
      result = result.filter((i) => i.status === 'draft' || i.status === 'grilling')
    } else if (filter === 'completed') {
      result = result.filter((i) => i.status === 'completed')
    }

    // Apply text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          (i.description && i.description.toLowerCase().includes(q))
      )
    }

    return result
  }, [ideas, filter, searchQuery])

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
        onOpenGrillSession(
          updatedIdea.id,
          conversation.id,
          updatedIdea.title,
          isNewSession,
          updatedIdea.description
        )
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
        onOpenGrillSession(
          updatedIdea.id,
          conversation.id,
          updatedIdea.title,
          isNewConversation,
          updatedIdea.description
        )
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

  const handleCreatePlanFromCompleted = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      // Use grillSummary (enriched description) or fall back to original description
      const ideaDescription = idea.grillSummary || idea.description || ''
      const { conversation } = await convertDirect(idea.id, activeWorkspace.id)
      await loadConversations(activeWorkspace.id)
      await selectConversation(conversation.id)
      const planPrompt = `## ${idea.title}\n\n${ideaDescription}\n\nGenerate a comprehensive implementation plan for this requirement. Use the structured \`\`\`plan block format with sections (one per phase), steps, affected files, complexity estimates, and risks. Do NOT write the plan to a file — emit it inline.`
      await sendMessage(planPrompt)
      onNavigateToChat()
    } catch (error) {
      console.error('Failed to create plan from completed idea:', error)
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
            className="bg-surface-overlay border border-border-subtle rounded p-4 flex items-start gap-3"
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

  const renderCreateModal = (): React.JSX.Element => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-float rounded-xl border border-warning/30 shadow-xl w-96 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-warning-muted border-b border-warning/20">
          <div className="flex items-center gap-2">
            <Lightbulb size={16} className="text-warning" />
            <span className="text-sm font-medium text-warning">New Idea</span>
          </div>
          <button
            onClick={() => setShowCreateModal(false)}
            className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        {/* Body */}
        <div className="p-4 space-y-3">
          <input
            type="text"
            placeholder="Idea title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateIdea()
              if (e.key === 'Escape') setShowCreateModal(false)
            }}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors"
            autoFocus
          />
          <textarea
            placeholder="Description (optional)..."
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateIdea()
              if (e.key === 'Escape') setShowCreateModal(false)
            }}
            rows={4}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors resize-none"
          />
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-xs text-text-muted">⌘+Enter to save</span>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreateModal(false)}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateIdea}
              disabled={!newTitle.trim() || isCreating}
              className="px-3 py-1.5 text-xs font-medium text-surface-base bg-warning rounded-lg hover:brightness-110 disabled:opacity-30 transition-colors"
            >
              {isCreating ? 'Saving...' : 'Save Idea'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  if (ideas.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Lightbulb size={32} className="text-warning/30 mb-3" />
          <p className="text-sm text-text-secondary mb-3">No ideas yet</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-warning/20 hover:bg-warning/30 text-warning rounded-lg transition-colors"
          >
            <Plus size={14} />
            New Idea
          </button>
        </div>
        {showCreateModal && renderCreateModal()}
      </>
    )
  }

  return (
    <>
      {/* Filter bar + Search */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filter === tab.value
                  ? 'bg-primary/20 text-primary-text'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ideas..."
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
          />
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-warning/20 hover:bg-warning/30 text-warning rounded-lg transition-colors ml-auto"
        >
          <Plus size={14} />
          New Idea
        </button>
      </div>

      {/* Filtered empty state */}
      {filteredIdeas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Lightbulb size={32} className="text-warning/30 mb-3" />
          <p className="text-sm text-text-secondary">
            {searchQuery
              ? 'No ideas match your search'
              : filter === 'completed'
                ? 'No completed ideas yet'
                : filter === 'active'
                  ? 'No active ideas'
                  : 'No ideas yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredIdeas.map((idea) => (
            <div
              key={idea.id}
              className="group bg-surface-overlay border border-border-subtle rounded-lg p-4 hover:border-border-default transition-colors shadow-sm"
            >
              {editingId === idea.id ? (
                /* Inline editing mode */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    {idea.status === 'grilling' ? (
                      <Flame size={14} className="text-accent flex-shrink-0" />
                    ) : (
                      <Lightbulb size={14} className="text-warning flex-shrink-0" />
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
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                        <Flame size={14} className="text-accent flex-shrink-0" />
                      ) : idea.status === 'completed' ? (
                        <CheckCircle size={14} className="text-success flex-shrink-0" />
                      ) : (
                        <Lightbulb size={14} className="text-warning flex-shrink-0" />
                      )}
                      <span
                        className="text-base font-normal text-text-primary truncate"
                        style={{ fontFamily: 'var(--ca-font-display)', letterSpacing: '0.01em' }}
                      >
                        {idea.title}
                      </span>
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
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent-muted border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
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
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent-muted border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
                      >
                        <Flame size={12} />
                        Continue Grill
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

                  {idea.status === 'completed' && idea.convertedConversationId && (
                    <button
                      onClick={() => handleGoToConversation(idea.convertedConversationId!)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors"
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
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors"
                      >
                        <ExternalLink size={12} />
                        Go to Grill Conversation
                      </button>
                    )}

                  {idea.status === 'completed' && (
                    <button
                      onClick={() => handleCreatePlanFromCompleted(idea)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
                    >
                      <Play size={12} />
                      Create New Plan
                    </button>
                  )}

                  {/* Delete button — always available */}
                  <button
                    onClick={() => setDeleteTarget(idea.id)}
                    className="inline-flex items-center p-1 text-text-muted hover:text-danger hover:bg-danger-muted rounded-md transition-colors ml-auto"
                    aria-label="Delete idea"
                    title="Delete idea"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}

              {/* Grill summary — expandable */}
              {idea.grillSummary && idea.status === 'completed' && (
                <GrillSummaryPreview summary={idea.grillSummary} />
              )}
            </div>
          ))}
        </div>
      )}

      {showCreateModal && renderCreateModal()}

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

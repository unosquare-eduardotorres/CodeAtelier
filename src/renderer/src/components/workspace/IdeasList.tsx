import { useEffect, useMemo, useState } from 'react'
import { Lightbulb, Plus } from 'lucide-react'
import { useIdeaStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import type { Idea } from '../../../../shared/types'
import {
  IdeaCard,
  IdeaFilterBar,
  CreateIdeaModal,
  type GrillStatus,
  type IdeaFilter
} from './ideas'

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

export default function IdeasList({
  onNavigateToChat,
  onOpenGrillSession
}: IdeasListProps): React.JSX.Element {
  const {
    ideas,
    loadIdeas,
    deleteIdea,
    updateIdea,
    startGrill,
    convertDirect,
    createIdea,
    isLoading
  } = useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage, loadConversations } = useChatActions()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [filter, setFilter] = useState<IdeaFilter>('active')
  const [searchQuery, setSearchQuery] = useState('')

  // Live grill status
  const [grillStatus, setGrillStatus] = useState<GrillStatus | null>(null)

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
    if (filter === 'active') {
      result = result.filter((i) => i.status === 'draft' || i.status === 'grilling')
    } else if (filter === 'completed') {
      result = result.filter((i) => i.status === 'completed')
    }
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

  useEffect(() => {
    if (activeWorkspace) loadIdeas(activeWorkspace.id)
  }, [activeWorkspace, loadIdeas])

  useEffect(() => {
    if (!activeWorkspace) return
    window.api.grillGetStatus({ workspaceId: activeWorkspace.id }).then(setGrillStatus)
    const unsub = window.api.onGrillStatusChanged(setGrillStatus)
    return unsub
  }, [activeWorkspace?.id])

  // ── Idea action handlers ──

  const handleConvertDirect = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      const { idea: updatedIdea, conversation } = await convertDirect(idea.id, activeWorkspace.id)
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
      const isNewSession = !idea.grillConversationId || idea.grillConversationId !== conversation.id

      if (onOpenGrillSession) {
        onOpenGrillSession(
          updatedIdea.id,
          conversation.id,
          updatedIdea.title,
          isNewSession,
          updatedIdea.description
        )
      } else {
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
      const { idea: updatedIdea, conversation } = await startGrill(idea.id, activeWorkspace.id)
      const isNewConversation = idea.grillConversationId !== conversation.id

      if (onOpenGrillSession) {
        onOpenGrillSession(
          updatedIdea.id,
          conversation.id,
          updatedIdea.title,
          isNewConversation,
          updatedIdea.description
        )
      } else {
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

  const handleEdit = async (idea: Idea, title: string, description: string): Promise<void> => {
    try {
      await updateIdea(idea.id, { title, description })
    } catch (error) {
      console.error('Failed to update idea:', error)
    }
  }

  // ── Render ──

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
        {showCreateModal && (
          <CreateIdeaModal
            title={newTitle}
            description={newDescription}
            isCreating={isCreating}
            onTitleChange={setNewTitle}
            onDescriptionChange={setNewDescription}
            onCreate={handleCreateIdea}
            onClose={() => setShowCreateModal(false)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <IdeaFilterBar
        filter={filter}
        searchQuery={searchQuery}
        onFilterChange={setFilter}
        onSearchChange={setSearchQuery}
        onNewIdea={() => setShowCreateModal(true)}
      />

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
            <IdeaCard
              key={idea.id}
              idea={idea}
              grillStatus={grillStatus}
              onStartGrill={handleStartGrill}
              onContinueGrill={handleContinueGrill}
              onConvertDirect={handleConvertDirect}
              onGoToConversation={handleGoToConversation}
              onCreatePlan={handleCreatePlanFromCompleted}
              onDelete={setDeleteTarget}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateIdeaModal
          title={newTitle}
          description={newDescription}
          isCreating={isCreating}
          onTitleChange={setNewTitle}
          onDescriptionChange={setNewDescription}
          onCreate={handleCreateIdea}
          onClose={() => setShowCreateModal(false)}
        />
      )}

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

import { useEffect, useMemo, useState } from 'react'
import { Lightbulb, Plus, MessageSquare, Flame, Play } from 'lucide-react'
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

// ── Empty-state onboarding panel ──

function IdeasEmptyState({ onCreateIdea }: { onCreateIdea: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4">
      <div className="max-w-2xl w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-warning/15 mb-2">
            <Lightbulb size={28} className="text-warning" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Your Idea Board</h2>
          <p className="text-sm text-text-secondary max-w-md mx-auto">
            Capture rough ideas now, refine them later. Unlike chat, ideas
            <span className="text-text-primary font-medium"> persist across sessions</span> and can
            be thoroughly vetted before you start building.
          </p>
        </div>

        {/* 3-column workflow cards */}
        <div className="grid grid-cols-3 gap-3">
          {/* Step 1: Capture */}
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-warning/15 flex items-center justify-center">
                <Lightbulb size={14} className="text-warning" />
              </div>
              <span className="text-sm font-semibold text-text-primary">Capture</span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              Jot down a rough idea — a title and optional description. Come back to it anytime.
            </p>
          </div>

          {/* Step 2: Grill Me */}
          <div className="rounded-xl border border-accent/20 bg-accent/5 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center">
                <Flame size={14} className="text-accent" />
              </div>
              <span className="text-sm font-semibold text-text-primary">Grill Me</span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              An AI analyst interviews you across 8 specialist tracks — requirements, architecture,
              security & more — scoring your spec and asking tough questions until it&apos;s solid.
            </p>
          </div>

          {/* Step 3: Build */}
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
                <Play size={14} className="text-primary-text" />
              </div>
              <span className="text-sm font-semibold text-text-primary">Build</span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              When ready, convert your refined idea into a chat session and start building with full
              context carried over.
            </p>
          </div>
        </div>

        {/* Chat vs Ideas comparison */}
        <div className="rounded-lg border border-border-subtle bg-surface-overlay p-4">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            💬 Chat vs 💡 Ideas
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary">
            <div className="flex items-start gap-2">
              <MessageSquare size={12} className="text-text-muted mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-text-primary">Chat</strong> — freeform conversation for
                immediate tasks, ephemeral thinking
              </span>
            </div>
            <div className="flex items-start gap-2">
              <Lightbulb size={12} className="text-warning mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-text-primary">Ideas</strong> — persistent parking lot with
                structured refinement before you build anything
              </span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={onCreateIdea}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-warning/20 hover:bg-warning/30 text-warning rounded-xl transition-colors"
          >
            <Plus size={16} />
            Capture Your First Idea
          </button>
          <p className="text-xs text-text-muted">
            💡 Tip: type{' '}
            <code className="px-1.5 py-0.5 rounded bg-surface-overlay text-accent text-xs">
              /grillme
            </code>{' '}
            in any chat to jump here
          </p>
        </div>
      </div>
    </div>
  )
}

interface IdeasListProps {
  onNavigateToChat: () => void
  onOpenGrillSession?: (
    ideaId: string,
    conversationId: string,
    ideaTitle: string,
    isNewSession?: boolean,
    ideaDescription?: string,
    reviewMode?: boolean
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

  // Idea IDs that have a persisted grill plan (eligible for read-only review)
  const [plannedIdeaIds, setPlannedIdeaIds] = useState<Set<string>>(new Set())

  // New Idea modal state
  const [showCreateModal, setShowCreateModal] = useState(false)

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

  // Load the set of ideas that have a persisted plan (re-runs when ideas change
  // so a freshly handed-off plan surfaces a Review Plan button on return).
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .grillListPlannedIdeas({ workspaceId: activeWorkspace.id })
      .then((ids) => setPlannedIdeaIds(new Set(ids)))
      .catch(() => setPlannedIdeaIds(new Set()))
  }, [activeWorkspace?.id, ideas])

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

  // Read-only re-open of a completed grill to review the generated plan.
  // Bypasses startGrill so it never flips idea.status back to 'grilling'.
  const handleReviewPlan = (idea: Idea): void => {
    if (!onOpenGrillSession) return
    onOpenGrillSession(
      idea.id,
      idea.grillConversationId ?? '',
      idea.title,
      false,
      idea.description,
      true
    )
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
        <IdeasEmptyState onCreateIdea={() => setShowCreateModal(true)} />
        {showCreateModal && (
          <CreateIdeaModal
            onCreateIdea={async (title, description) => {
              if (!activeWorkspace) return
              await createIdea(activeWorkspace.id, title, description)
            }}
            onClose={() => setShowCreateModal(false)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div data-testid="ideas-list">
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
              hasPlan={plannedIdeaIds.has(idea.id)}
              onStartGrill={handleStartGrill}
              onContinueGrill={handleContinueGrill}
              onConvertDirect={handleConvertDirect}
              onGoToConversation={handleGoToConversation}
              onCreatePlan={handleCreatePlanFromCompleted}
              onReviewPlan={handleReviewPlan}
              onDelete={setDeleteTarget}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateIdeaModal
          onCreateIdea={async (title, description) => {
            if (!activeWorkspace) return
            await createIdea(activeWorkspace.id, title, description)
          }}
          onClose={() => setShowCreateModal(false)}
        />
      )}

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

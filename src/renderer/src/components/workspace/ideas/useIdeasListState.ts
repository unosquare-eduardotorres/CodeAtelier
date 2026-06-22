/**
 * Custom hook encapsulating IdeasList state, effects, and callbacks.
 * Extracted from IdeasList to reduce component cyclomatic complexity.
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useIdeaStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import type { Idea, Workspace } from '../../../../../shared/types'
import type { GrillStatus, IdeaFilter } from './index'

// ── useFilterIdeas hook ──────────────────────────────────────────────

function useFilterIdeas(ideas: Idea[], filter: IdeaFilter, searchQuery: string): Idea[] {
  return useMemo(() => {
    let result = ideas
    if (filter === 'active') {
      result = result.filter((i) => i.status === 'draft' || i.status === 'grilling')
    } else if (filter === 'completed') {
      result = result.filter((i) => i.status === 'completed')
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (i) => i.title.toLowerCase().includes(q) || (i.description?.toLowerCase().includes(q))
      )
    }
    return result
  }, [ideas, filter, searchQuery])
}

// ── Workspace guard wrapper ─────────────────────────────────────────

function useWorkspaceGuarded<TArgs extends unknown[]>(
  getWorkspace: () => Workspace | null,
  fn: (workspace: Workspace, ...args: TArgs) => Promise<void>,
  deps: React.DependencyList
): (...args: TArgs) => Promise<void> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(async (...args: TArgs) => {
    const ws = getWorkspace()
    if (!ws) return
    await fn(ws, ...args)
  }, deps)
}

interface IdeasListCallbacks {
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

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useIdeasListState(callbacks: IdeasListCallbacks) {
  const {
    ideas, loadIdeas, deleteIdea, updateIdea, startGrill,
    convertDirect, createIdea, isLoading
  } = useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage, loadConversations } = useChatActions()

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [filter, setFilter] = useState<IdeaFilter>('active')
  const [searchQuery, setSearchQuery] = useState('')
  const [grillStatus, setGrillStatus] = useState<GrillStatus | null>(null)
  const [plannedIdeaIds, setPlannedIdeaIds] = useState<Set<string>>(new Set())
  const [showCreateModal, setShowCreateModal] = useState(false)

  // ── Filtered ideas ──
  const filteredIdeas = useFilterIdeas(ideas, filter, searchQuery)
  const getWorkspace = useCallback(() => activeWorkspace, [activeWorkspace])

  // ── Effects ──
  useEffect(() => {
    if (activeWorkspace) loadIdeas(activeWorkspace.id)
  }, [activeWorkspace, loadIdeas])

  useEffect(() => {
    if (!activeWorkspace) return
    window.api.grillGetStatus({ workspaceId: activeWorkspace.id }).then(setGrillStatus)
    return window.api.onGrillStatusChanged(setGrillStatus)
  }, [activeWorkspace?.id])

  useEffect(() => {
    if (!activeWorkspace) return
    window.api.grillListPlannedIdeas({ workspaceId: activeWorkspace.id })
      .then((ids) => setPlannedIdeaIds(new Set(ids)))
      .catch(() => setPlannedIdeaIds(new Set()))
  }, [activeWorkspace?.id, ideas])

  // ── Grill helpers ──
  const openGrillOrFallback = useCallback(
    async (idea: Idea, conversation: { id: string }, isNewSession: boolean) => {
      if (callbacks.onOpenGrillSession) {
        callbacks.onOpenGrillSession(idea.id, conversation.id, idea.title, isNewSession, idea.description)
      } else {
        await loadConversations(activeWorkspace!.id)
        await selectConversation(conversation.id)
        if (isNewSession) {
          const grillPrompt = `[GRILL MODE]\n\n## Evaluate This Requirement\n**${idea.title}**\n\n${idea.description || 'No description provided.'}\n\nAnalyze this requirement and respond with a single grill-evaluation JSON block containing a completeness score (1-100), brief feedback, and exactly 5 questions targeting the weakest areas.`
          await sendMessage(grillPrompt)
        }
        callbacks.onNavigateToChat()
      }
    },
    [callbacks, activeWorkspace, loadConversations, selectConversation, sendMessage]
  )

  // ── Action callbacks (workspace-guarded) ──
  const handleConvertDirect = useWorkspaceGuarded(
    getWorkspace,
    async (ws, idea: Idea) => {
      try {
        const { idea: updated, conversation } = await convertDirect(idea.id, ws.id)
        await loadConversations(ws.id)
        await selectConversation(conversation.id)
        await sendMessage(`## Idea: ${updated.title}\n\n${updated.description || 'No description provided.'}\n\nPlease help me work on this idea.`)
        callbacks.onNavigateToChat()
      } catch (error) { console.error('Failed to convert idea:', error) }
    },
    [getWorkspace, convertDirect, loadConversations, selectConversation, sendMessage, callbacks]
  )

  const handleStartGrill = useWorkspaceGuarded(
    getWorkspace,
    async (ws, idea: Idea) => {
      try {
        const { idea: updated, conversation } = await startGrill(idea.id, ws.id)
        const isNew = !idea.grillConversationId || idea.grillConversationId !== conversation.id
        await openGrillOrFallback(updated, conversation, isNew)
      } catch (error) { console.error('Failed to start grill:', error) }
    },
    [getWorkspace, startGrill, openGrillOrFallback]
  )

  const handleContinueGrill = useWorkspaceGuarded(
    getWorkspace,
    async (ws, idea: Idea) => {
      try {
        const { idea: updated, conversation } = await startGrill(idea.id, ws.id)
        const isNew = idea.grillConversationId !== conversation.id
        await openGrillOrFallback(updated, conversation, isNew)
      } catch (error) { console.error('Failed to continue grill:', error) }
    },
    [getWorkspace, startGrill, openGrillOrFallback]
  )

  const handleReviewPlan = useCallback((idea: Idea) => {
    callbacks.onOpenGrillSession?.(idea.id, idea.grillConversationId ?? '', idea.title, false, idea.description, true)
  }, [callbacks])

  const handleGoToConversation = useWorkspaceGuarded(
    getWorkspace,
    async (ws, conversationId: string) => {
      try {
        await loadConversations(ws.id)
        await selectConversation(conversationId)
        callbacks.onNavigateToChat()
      } catch (error) { console.error('Failed to navigate to conversation:', error) }
    },
    [getWorkspace, loadConversations, selectConversation, callbacks]
  )

  const handleCreatePlanFromCompleted = useWorkspaceGuarded(
    getWorkspace,
    async (ws, idea: Idea) => {
      try {
        const desc = idea.grillSummary || idea.description || ''
        const { conversation } = await convertDirect(idea.id, ws.id)
        await loadConversations(ws.id)
        await selectConversation(conversation.id)
        await sendMessage(`## ${idea.title}\n\n${desc}\n\nGenerate a comprehensive implementation plan for this requirement. Use the structured \`\`\`plan block format with sections (one per phase), steps, affected files, complexity estimates, and risks. Do NOT write the plan to a file — emit it inline.`)
        callbacks.onNavigateToChat()
      } catch (error) { console.error('Failed to create plan from completed idea:', error) }
    },
    [getWorkspace, convertDirect, loadConversations, selectConversation, sendMessage, callbacks]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try { await deleteIdea(deleteTarget) }
    catch (error) { console.error('Failed to delete idea:', error) }
    finally { setDeleteTarget(null) }
  }, [deleteTarget, deleteIdea])

  const handleEdit = useCallback(async (idea: Idea, title: string, description: string) => {
    try { await updateIdea(idea.id, { title, description }) }
    catch (error) { console.error('Failed to update idea:', error) }
  }, [updateIdea])

  return {
    // Store values
    ideas, isLoading, activeWorkspace, createIdea,
    // Local state
    deleteTarget, setDeleteTarget, filter, setFilter,
    searchQuery, setSearchQuery, grillStatus, plannedIdeaIds,
    showCreateModal, setShowCreateModal,
    // Computed
    filteredIdeas,
    // Callbacks
    handleConvertDirect, handleStartGrill, handleContinueGrill,
    handleReviewPlan, handleGoToConversation, handleCreatePlanFromCompleted,
    handleDelete, handleEdit
  }
}

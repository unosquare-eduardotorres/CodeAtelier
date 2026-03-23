import { useEffect, useState } from 'react'
import { Lightbulb, Flame, Play, Trash2, CheckCircle, ExternalLink } from 'lucide-react'
import { useIdeaStore, useChatStore, useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog } from '@renderer/components/common'
import type { Idea } from '../../../../shared/types'

interface IdeasListProps {
  onNavigateToChat: () => void
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

export default function IdeasList({ onNavigateToChat }: IdeasListProps): React.JSX.Element {
  const { ideas, loadIdeas, deleteIdea, startGrill, convertDirect, isLoading } = useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage } = useChatStore()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  useEffect(() => {
    if (activeWorkspace) {
      loadIdeas(activeWorkspace.id)
    }
  }, [activeWorkspace, loadIdeas])

  const handleConvertDirect = async (idea: Idea): Promise<void> => {
    if (!activeWorkspace) return
    try {
      const { idea: updatedIdea, conversation } = await convertDirect(idea.id, activeWorkspace.id)
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
      await selectConversation(conversation.id)

      // Only auto-send the grill prompt if this is a new grill session
      if (!idea.grillConversationId) {
        const grillPrompt = `[GRILL MODE ACTIVATED]\n\n## Idea to Refine\n**${updatedIdea.title}**\n\n${updatedIdea.description || 'No description provided.'}\n\nInterview me relentlessly about every aspect of this idea until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. If a question can be answered by exploring the codebase, explore the codebase instead.`
        await sendMessage(grillPrompt)
      }
      onNavigateToChat()
    } catch (error) {
      console.error('Failed to start grill:', error)
    }
  }

  const handleContinueGrill = async (grillConversationId: string): Promise<void> => {
    try {
      await selectConversation(grillConversationId)
      onNavigateToChat()
    } catch (error) {
      console.error('Failed to continue grill:', error)
    }
  }

  const handleGoToConversation = async (conversationId: string): Promise<void> => {
    try {
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
      <div className="flex items-center justify-center py-8">
        <div className="text-sm text-gray-500">Loading ideas...</div>
      </div>
    )
  }

  if (ideas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Lightbulb size={32} className="text-yellow-400/30 mb-3" />
        <p className="text-sm text-gray-500 mb-1">No ideas yet</p>
        <p className="text-xs text-gray-600">
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
            className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3 hover:border-gray-600/50 transition-colors"
          >
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
                <span className="text-sm font-medium text-gray-200 truncate">{idea.title}</span>
              </div>
              <StatusBadge status={idea.status} />
            </div>

            {/* Description */}
            {idea.description && (
              <p className="text-xs text-gray-400 mb-3 ml-[22px] line-clamp-2">
                {idea.description}
              </p>
            )}

            {/* Actions */}
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors"
                  >
                    <Play size={12} />
                    Convert Directly
                  </button>
                </>
              )}

              {idea.status === 'grilling' && (
                <>
                  <button
                    onClick={() => idea.grillConversationId && handleContinueGrill(idea.grillConversationId)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 transition-colors"
                  >
                    <Flame size={12} />
                    Continue Grill
                  </button>
                  <button
                    disabled
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-700/30 border border-gray-700/50 rounded-lg cursor-not-allowed opacity-50"
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

              {idea.status === 'completed' && idea.grillConversationId && !idea.convertedConversationId && (
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
                className="inline-flex items-center p-1 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors ml-auto"
                aria-label="Delete idea"
                title="Delete idea"
              >
                <Trash2 size={12} />
              </button>
            </div>

            {/* Grill summary */}
            {idea.grillSummary && idea.status === 'completed' && (
              <div className="mt-2 ml-[22px] p-2 bg-gray-900/40 rounded-md border border-gray-700/30">
                <span className="text-xs text-gray-500 font-medium">Grill Summary:</span>
                <p className="text-xs text-gray-400 mt-0.5 line-clamp-3">{idea.grillSummary}</p>
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

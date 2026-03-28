import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Pause, Flame } from 'lucide-react'
import { useChatStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { useIdeaStore } from '@renderer/store/idea.store'
import {
  MessageList,
  MessageInput,
  AttachmentDropzone
} from '@renderer/components/chat'

interface GrillSessionViewProps {
  ideaId: string
  conversationId: string
  ideaTitle: string
  ideaDescription?: string
  isNewSession?: boolean
  onBack: () => void
  onComplete: () => void
}

export default function GrillSessionView({
  ideaId: _ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete
}: GrillSessionViewProps): React.JSX.Element {
  // _ideaId reserved for future use (e.g., updating idea status from this view)
  void _ideaId
  const { selectConversation, loadConversations, clearGrillSession, sendMessage } = useChatActions()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const grillCompleted = useChatStore(
    (s) => s.grillSession !== null && !s.grillSession.active && !!s.grillSession.summary
  )
  const grillSummary = useChatStore((s) => s.grillSession?.summary ?? null)
  const { completeFromGrill } = useIdeaStore()
  const [attachments, setAttachments] = useState<string[]>([])
  const mountedRef = useRef(false)

  // Load the grill conversation into the chat store on mount
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const load = async (): Promise<void> => {
      if (activeWorkspace) {
        await loadConversations(activeWorkspace.id)
      }
      await selectConversation(conversationId)

      // If this is a new grill session, send the initial prompt AFTER conversation is loaded
      // This avoids the race condition where sendMessage's optimistic message gets wiped
      // by selectConversation fetching an empty message list from the DB.
      if (isNewSession) {
        const grillPrompt = `[GRILL MODE ACTIVATED]\n\n## Idea to Refine\n**${ideaTitle}**\n\n${ideaDescription || 'No description provided.'}\n\nInterview me relentlessly about every aspect of this idea until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. If a question can be answered by exploring the codebase, explore the codebase instead.`
        await sendMessage(grillPrompt)
      }
    }
    load()
  }, [conversationId, activeWorkspace, loadConversations, selectConversation, isNewSession, ideaTitle, ideaDescription, sendMessage])

  const handlePause = (): void => {
    onBack()
  }

  const handleCompleteGrill = async (): Promise<void> => {
    // Mark the idea as completed with the grill summary
    await completeFromGrill(conversationId, grillSummary ?? undefined)
    clearGrillSession()
    onComplete()
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors text-sm"
          >
            <ArrowLeft size={14} />
            Back to Ideas
          </button>
          <div className="w-px h-5 bg-border-subtle" />
          <div className="flex items-center gap-2 min-w-0">
            <Flame size={14} className="text-orange-400 flex-shrink-0" />
            <span className="text-sm font-medium text-orange-300 truncate">
              Grill: {ideaTitle}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {grillCompleted && (
            <button
              onClick={handleCompleteGrill}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors press-scale"
            >
              Complete &amp; Convert
            </button>
          )}
          <button
            onClick={handlePause}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
          >
            <Pause size={14} />
            Pause
          </button>
        </div>
      </div>

      {/* Messages area — reuses the same MessageList component */}
      {activeConversation?.id === conversationId ? (
        <div className="flex-1 flex flex-col min-h-0">
          <MessageList />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-muted">Loading grill session...</span>
          </div>
        </div>
      )}

      {/* Input — pinned to bottom */}
      <div className="flex-shrink-0 px-6 pb-4 pt-2">
        <AttachmentDropzone attachments={attachments} onAttachmentsChange={setAttachments}>
          <MessageInput attachments={attachments} onClearAttachments={() => setAttachments([])} />
        </AttachmentDropzone>
      </div>
    </div>
  )
}

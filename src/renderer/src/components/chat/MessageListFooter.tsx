import { useChatStore, useChatActions } from '@renderer/store'
import { GrillQuestionCard } from '@renderer/components/chat'
import IdeaPopover from './IdeaPopover'
import { CompactContextModal } from '@renderer/components/common'
import { ThinkingIndicator } from '@renderer/components/streaming'
import AutoModeSwitchPill from './AutoModeSwitchPill'
import DiagnosticsPanel from './DiagnosticsPanel'
import type { ToolActivity } from '../../../../shared/types'

interface MessageListFooterProps {
  promptSuggestion: string | null
  onDismissPromptSuggestion: () => void
  showIdeaPopover: boolean
  ideaPopoverData: { title: string; description: string } | null
  onCloseIdeaPopover: () => void
  thinkingIdentity: { name: string; avatarKey: string; accentColor: string }
  allStreamingTools: ToolActivity[]
}

export default function MessageListFooter({
  promptSuggestion,
  onDismissPromptSuggestion,
  showIdeaPopover,
  ideaPopoverData,
  onCloseIdeaPopover,
  thinkingIdentity,
  allStreamingTools
}: MessageListFooterProps): React.JSX.Element {
  const isStreaming = useChatStore((s) => s.isStreaming)
  const compactSuggestion = useChatStore((s) => s.compactSuggestion)
  const contextUsages = useChatStore((s) => s.contextUsages)
  const pendingQuestions = useChatStore((s) => s.pendingQuestions)
  const hasPendingQuestions = (pendingQuestions?.length ?? 0) > 0
  const activeConversationId = useChatStore((s) => s.activeConversation?.id ?? null)
  const activeConversationWorkspaceId = useChatStore(
    (s) => s.activeConversation?.workspaceId ?? null
  )

  const {
    setCompactSuggestion,
    sendMessage,
    submitQuestionAnswers,
    skipAllQuestions,
    appendLocalMessage,
    createConversation
  } = useChatActions()

  return (
    <>
      {/* Auto mode switch pill */}
      <AutoModeSwitchPill />

      {/* Prompt suggestion */}
      {promptSuggestion && !isStreaming && (
        <div className="flex gap-3 flex-row px-0 pb-2">
          <div className="flex-shrink-0 w-10" />
          <button
            onClick={() => {
              sendMessage(promptSuggestion)
              onDismissPromptSuggestion()
            }}
            className="text-xs text-primary-text bg-primary/10 px-3 py-1.5 rounded-full hover:bg-primary/20 transition-colors inline-flex items-center gap-1.5"
            title={promptSuggestion}
          >
            💡{' '}
            {promptSuggestion.length > 80
              ? promptSuggestion.slice(0, 77) + '...'
              : promptSuggestion}
          </button>
        </div>
      )}

      {showIdeaPopover && ideaPopoverData && (
        <div className="relative px-4 mt-2">
          <IdeaPopover
            onClose={onCloseIdeaPopover}
            initialTitle={ideaPopoverData.title}
            initialDescription={ideaPopoverData.description}
          />
        </div>
      )}

      {/* Compact context modal */}
      <CompactContextModal
        isOpen={!!compactSuggestion}
        inputTokens={compactSuggestion?.inputTokens ?? 0}
        contextWindowSize={
          activeConversationId ? contextUsages[activeConversationId]?.contextWindowSize : undefined
        }
        level={compactSuggestion?.level ?? 'suggest'}
        categories={
          activeConversationId ? contextUsages[activeConversationId]?.categories : undefined
        }
        breakdown={
          compactSuggestion?.breakdown ??
          (activeConversationId ? contextUsages[activeConversationId]?.breakdown : undefined)
        }
        isLocalProvider={compactSuggestion?.isLocalProvider}
        onExtractNuance={async () => {
          setCompactSuggestion(null)
          try {
            await window.api.compactConversation({ extractNuance: true })
          } catch (err) {
            appendLocalMessage(
              `**Compact failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }}
        onQuickCompact={async () => {
          setCompactSuggestion(null)
          try {
            await window.api.compactConversation({ extractNuance: false })
          } catch (err) {
            appendLocalMessage(
              `**Compact failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }}
        onCancel={() => setCompactSuggestion(null)}
        onNewConversation={async () => {
          setCompactSuggestion(null)
          if (!activeConversationWorkspaceId) return
          try {
            await createConversation(activeConversationWorkspaceId)
          } catch (err) {
            appendLocalMessage(
              `**Failed to create conversation:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }}
      />

      {/* LSP diagnostics panel (N3 — populated via App.tsx subscription) */}
      {activeConversationId && <DiagnosticsPanel conversationId={activeConversationId} />}

      {/* Pending questions card */}
      {hasPendingQuestions && pendingQuestions && (
        <div className="flex justify-start px-4">
          <div className="max-w-[85%]">
            <GrillQuestionCard
              questions={pendingQuestions}
              onSubmit={submitQuestionAnswers}
              onSkipAll={skipAllQuestions}
            />
          </div>
        </div>
      )}

      {/* Thinking indicator (shared primitive — chat keeps no live-text bubble) */}
      {isStreaming && !hasPendingQuestions && (
        <ThinkingIndicator
          identity={{
            name: thinkingIdentity.name,
            avatarKey: thinkingIdentity.avatarKey,
            accentColor: thinkingIdentity.accentColor
          }}
          toolActivities={allStreamingTools}
          showHookIndicator
        />
      )}
    </>
  )
}

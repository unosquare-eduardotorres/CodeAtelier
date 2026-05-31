import { useChatStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { GrillQuestionCard, ToolActivityBlock } from '@renderer/components/chat'
import IdeaPopover from './IdeaPopover'
import { Avatar, CompactContextModal } from '@renderer/components/common'
import AutoModeSwitchPill from './AutoModeSwitchPill'

interface MessageListFooterProps {
  promptSuggestion: string | null
  onDismissPromptSuggestion: () => void
  showIdeaPopover: boolean
  ideaPopoverData: { title: string; description: string } | null
  onCloseIdeaPopover: () => void
  thinkingIdentity: { name: string; avatarKey: string; accentColor: string }
  allStreamingTools: Array<{ id: string; name: string; status: string; serverName?: string }>
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
          activeConversationId
            ? contextUsages[activeConversationId]?.contextWindowSize
            : undefined
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

      {/* Thinking indicator */}
      {isStreaming && (
        <div className="flex gap-3 flex-row">
          <div className="flex-shrink-0 mt-0.5">
            <Avatar
              avatarKey={thinkingIdentity.avatarKey}
              size="xl"
              accentColor={thinkingIdentity.accentColor}
            />
          </div>
          <div className="flex flex-col max-w-[92%] items-start">
            <div className="flex flex-col mb-1 px-1 items-start">
              <span className="text-sm font-semibold text-text-primary leading-tight">
                {thinkingIdentity.name}
              </span>
            </div>
            <div className="flex flex-col gap-2 px-5 py-4 rounded-xl bg-surface-overlay border border-border-subtle shadow-sm">
              <div className="flex items-center gap-1.5 py-0.5 px-1">
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '150ms' }} />
                <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              </div>
              <p className="text-sm text-text-muted italic">Let me take a look…</p>
              {allStreamingTools.length > 0 && (
                <div className="mt-2">
                  <ToolActivityBlock activities={allStreamingTools} defaultExpanded />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

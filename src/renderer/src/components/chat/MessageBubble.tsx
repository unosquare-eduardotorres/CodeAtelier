import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import { Flame, Lightbulb, FileText, BookmarkPlus } from 'lucide-react'
import {
  remarkEmojiSpan,
  remarkHighlightQuestions,
  remarkHighlightNextSteps,
  remarkStyledArrows,
  remarkStripStrayBackticks
} from './remark-plugins'
import { CodeBlock } from './CodeBlock'
import type {
  Message,
  ToolActivity,
  ConversationMode,
  StructuredPlan
} from '../../../../shared/types'
import ToolActivityBlock from './ToolActivityBlock'
import MessageCardRenderer from './MessageCardRenderer'
import AttachmentList from './AttachmentList'
import { useMessageContent } from './useMessageContent'
import { useMessageIdentity } from './useMessageIdentity'
import type { MessageIdentity } from './useMessageIdentity'
import { useChatBubbleSize, useChatAvatarSize, useWorkspaceStore } from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import type { ChatBubbleSize } from '../../../../shared/types'
import { Avatar } from '@renderer/components/common'

/** Chat actions needed by MessageBubble — passed as props to avoid N×useShallow subscriptions */
export interface MessageBubbleActions {
  updateMode: (mode: ConversationMode) => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendLocalMessage: (content: string, opts?: { role?: Message['role']; agentId?: string }) => void
  saveAsIdea?: (title: string, description: string) => void
  /** Direct plan-to-build: skip agent round-trip when structured plan is available */
  buildFromPlan?: (plan: StructuredPlan, planContent: string) => Promise<void>
}

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  searchHighlight?: string
  toolActivities?: ToolActivity[]
  /** Chat actions passed from parent to avoid per-bubble store subscriptions */
  actions?: MessageBubbleActions
  /** Override the auto-resolved identity (name, avatar, color). Used by Grill. */
  identityOverride?: MessageIdentity
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Shorten absolute file paths for display:
 * - /Users/x/.claude/plans/foo.md → /plans/foo.md
 * - /Users/x/Projects/AgentStudio/src/main/index.ts → /…/src/main/index.ts
 * - Keeps the full path in the title tooltip for reference
 */
function shortenFilePath(filePath: string): string {
  const claudeMatch = filePath.match(/^(?:\/Users\/[^/]+|\/home\/[^/]+|~)\/.claude\/(.+)$/)
  if (claudeMatch) {
    return `/${claudeMatch[1]}`
  }
  const segments = filePath.split('/')
  if (segments.length > 4) {
    return '/…/' + segments.slice(-3).join('/')
  }
  return filePath
}

/** Clickable file-path link — resolves relative paths against workspace root */
function FilePathLink({ filePath }: { filePath: string }): React.JSX.Element {
  const repoPath = useWorkspaceStore((s) => s.activeWorkspace?.repoPath)
  const shortenedPath = shortenFilePath(filePath)
  const isAbsolute = /^[/~]/.test(filePath) || /^[A-Z]:\\/.test(filePath)
  const resolvedPath =
    isAbsolute || !repoPath ? filePath : `${repoPath.replace(/\/$/, '')}/${filePath}`

  return (
    <span
      role="button"
      aria-label={`Reveal ${filePath} in file manager`}
      className="inline-flex items-center gap-1 text-sm font-medium text-info hover:text-info/80 underline decoration-info/40 cursor-pointer transition-colors"
      title={`Reveal in file manager: ${resolvedPath}`}
      onClick={() => window.api.showItemInFolder(resolvedPath)}
    >
      <FileText size={13} className="shrink-0" />
      {shortenedPath}
    </span>
  )
}

/** Bubble size classes — controlled by user preference */
const BUBBLE_SIZE_CLASSES: Record<
  ChatBubbleSize,
  { text: string; userMax: string; aiMax: string }
> = {
  small: { text: 'text-xs leading-relaxed', userMax: 'max-w-[70%]', aiMax: 'max-w-[88%]' },
  medium: { text: 'text-sm leading-relaxed', userMax: 'max-w-[75%]', aiMax: 'max-w-[90%]' },
  large: { text: 'text-sm leading-relaxed', userMax: 'max-w-[80%]', aiMax: 'max-w-[92%]' },
  xl: { text: 'text-base leading-relaxed', userMax: 'max-w-[75%]', aiMax: 'max-w-[92%]' }
}


// Module-level constants — stable references, never recreated on render
const REMARK_PLUGINS_BASE = [
  remarkGfm,
  remarkBreaks,
  remarkEmojiSpan,
  remarkStyledArrows,
  remarkStripStrayBackticks
]
const REMARK_PLUGINS = [...REMARK_PLUGINS_BASE, remarkHighlightQuestions, remarkHighlightNextSteps]
const REHYPE_PLUGINS = [rehypeRaw]

// Module-level markdown components — stable reference, avoids ReactMarkdown full re-render
const markdownComponents = {
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    // Block code with language class — pass through for CodeBlock
    if (className?.includes('language-')) {
      return <code className={className}>{children}</code>
    }

    const text = String(children).replace(/`/g, '').trim()

    // Multi-line content is block code (inside a <pre>) — return a plain <code>
    // so CodeBlock can find it. Don't apply inline URL/filePath detection.
    if (text.includes('\n')) {
      return <code>{children}</code>
    }

    // ── Single-line inline code: URL / file-path / default ──

    const isUrl = /^https?:\/\/\S+$/.test(text)
    if (isUrl) {
      return (
        <a
          href={text}
          className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm text-primary-text hover:text-primary-hover underline cursor-pointer"
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault()
            if (text) window.open(text, '_blank')
          }}
        >
          {text}
        </a>
      )
    }

    const isFilePath =
      /^[/~][\w.\-/@ ]+\.\w{1,10}$/.test(text) ||
      /^[A-Z]:\\/.test(text) ||
      /^[\w@][\w.\-/@ ]*\/[\w.\-/@ ]*\.\w{1,10}$/.test(text) ||
      /^[\w][\w.-]*\.\w{2,10}$/.test(text)
    if (isFilePath) {
      return <FilePathLink filePath={text} />
    }

    return <code className="text-sm font-semibold">{text}</code>
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto rounded-lg border border-border-default my-3 shadow-sm">
      <table className="min-w-full">{children}</table>
    </div>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      className="text-accent hover:text-accent/80 underline"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault()
        if (href) window.open(href, '_blank')
      }}
    >
      {children}
    </a>
  )
}

// ── Module-level council helper ──

function startCouncilReview(
  workspaceId: string,
  planContent: string,
  structuredPlan: StructuredPlan | null,
  originalUserRequest: string
): void {
  const councilStore = useCouncilStore.getState()
  councilStore.startCouncil()
  window.api
    .councilStart({
      workspaceId,
      inputType: 'plan',
      planContent,
      structuredPlan: structuredPlan ?? undefined,
      originalUserRequest,
      conversationId: undefined
    })
    .then(({ sessionId }) => {
      councilStore.setSessionIdentity(sessionId, workspaceId)
    })
    .catch(console.error)
}

// ── Extracted sub-components ──

interface BubbleContentBodyProps {
  content: ReturnType<typeof useMessageContent>
  message: Message
  isUser: boolean
  aiBubbleClass: string
  sizeClasses: { text: string; userMax: string; aiMax: string }
  hasStructuredContent: boolean
  onBuildNow: () => void
  onRefine: () => void
  onSaveAsIdea?: () => void
  onCouncilReview?: () => void
  planActionTaken?: string
}

function BubbleContentBody({
  content,
  message,
  isUser,
  aiBubbleClass,
  sizeClasses,
  hasStructuredContent,
  onBuildNow,
  onRefine,
  onSaveAsIdea,
  onCouncilReview,
  planActionTaken
}: BubbleContentBodyProps): React.JSX.Element | null {
  const {
    imageAttachments,
    fileAttachments,
    isGrillActivation,
    ideaToRefineMatch,
    displayContent,
    planContent
  } = content

  if (hasStructuredContent) {
    return (
      <MessageCardRenderer
        content={content}
        aiBubbleClass={aiBubbleClass}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        markdownComponents={markdownComponents}
        onBuildNow={onBuildNow}
        onRefine={onRefine}
        onSaveAsIdea={onSaveAsIdea}
        onCouncilReview={planContent ? onCouncilReview : undefined}
        planActionTaken={planActionTaken}
      />
    )
  }

  const hasVisibleContent =
    isUser ||
    !!(isUser ? displayContent : message.contentMd?.trim()) ||
    imageAttachments.length > 0 ||
    fileAttachments.length > 0 ||
    isGrillActivation ||
    ideaToRefineMatch

  if (!hasVisibleContent) return null

  return (
    <div
      data-testid="message-bubble-content"
      className={`rounded shadow-sm ${
        isUser
          ? `px-5 py-4 bg-user-bubble text-text-body border-l-2 overflow-hidden min-w-0 ${isGrillActivation ? 'border-grill' : 'border-primary'}`
          : aiBubbleClass
      }`}
    >
      {isGrillActivation && (
        <div className="flex items-center gap-2 mb-3 pb-3 border-b border-grill/30">
          <Flame size={16} className="text-accent shrink-0" />
          <span className="text-sm font-semibold text-accent">Grill Mode Activated</span>
          <Flame size={16} className="text-accent shrink-0" />
        </div>
      )}

      {ideaToRefineMatch && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-warning-muted rounded-lg border border-warning/20">
          <Lightbulb size={14} className="text-warning shrink-0" />
          <span className="text-sm font-medium text-warning">
            Idea to Refine: <span className="text-text-body">{ideaToRefineMatch[1]}</span>
          </span>
        </div>
      )}

      <AttachmentList imageAttachments={imageAttachments} fileAttachments={fileAttachments} />

      {(isUser ? displayContent : message.contentMd) ? (
        <div className={`prose max-w-none overflow-hidden ${sizeClasses.text}`}>
          <ReactMarkdown
            remarkPlugins={isUser ? REMARK_PLUGINS_BASE : REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {isUser ? displayContent : message.contentMd}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  )
}

/** "Save to memory" hover action — extracts facts from a message via the extraction pipeline. */
function SaveToMemoryButton({ message }: { message: Message }): React.JSX.Element {
  const [saving, setSaving] = React.useState(false)
  const [feedbackLabel, setFeedbackLabel] = React.useState<string | null>(null)

  const handleSave = async (): Promise<void> => {
    const workspace = useWorkspaceStore.getState().activeWorkspace
    if (!workspace?.id || !message.contentMd) return
    setSaving(true)
    try {
      const { created } = await window.api.memorySaveMessage({
        workspaceId: workspace.id,
        messageContent: message.contentMd,
        workspacePath: workspace.repoPath ?? undefined
      })
      // N2-FIX: Always schedule the reset; show distinct feedback when no facts found.
      setFeedbackLabel(created > 0 ? 'Saved' : 'No facts found')
      setTimeout(() => setFeedbackLabel(null), 3000)
    } catch (err) {
      console.error('Failed to save to memory:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      onClick={handleSave}
      disabled={saving || feedbackLabel !== null}
      className="inline-flex items-center gap-0.5 text-[10px] text-text-muted hover:text-primary-text transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
      title={feedbackLabel ?? 'Save to memory'}
    >
      <BookmarkPlus className="w-3 h-3" />
      {saving ? 'Saving…' : feedbackLabel ?? 'Save to memory'}
    </button>
  )
}

interface BubbleFooterActionsProps {
  message: Message
  isUser: boolean
  isStreaming?: boolean
  toolActivities?: ToolActivity[]
}

function BubbleFooterActions({
  message,
  isUser,
  isStreaming,
  toolActivities
}: BubbleFooterActionsProps): React.JSX.Element {
  return (
    <>
      {toolActivities && toolActivities.length > 0 && (
        <ToolActivityBlock activities={toolActivities} defaultExpanded={!!isStreaming} />
      )}

      <div className="flex items-center gap-2 mt-1 px-1 group">
        <span className="text-xs text-text-secondary inline-flex items-center gap-1">
          {formatTime(message.createdAt)}
          {isStreaming && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 ml-0.5">
                <span
                  className="typing-dot !w-[4px] !h-[4px]"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="typing-dot !w-[4px] !h-[4px]"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="typing-dot !w-[4px] !h-[4px]"
                  style={{ animationDelay: '300ms' }}
                />
              </span>
            </>
          )}
        </span>
        {!isUser && !isStreaming && (
          <>
            <button
              onClick={async () => {
                if (message.conversationId && message.id) {
                  try {
                    await window.api.chatResumeAt({
                      conversationId: message.conversationId,
                      messageId: message.id
                    })
                  } catch (err) {
                    console.error('Failed to resume at checkpoint:', err)
                  }
                }
              }}
              className="text-[10px] text-text-muted hover:text-primary-text transition-colors opacity-0 group-hover:opacity-100"
              title="Undo to this message"
            >
              Undo to here
            </button>
            <SaveToMemoryButton message={message} />
          </>
        )}
      </div>
    </>
  )
}

function MessageBubbleInner({
  message,
  isStreaming,
  toolActivities,
  actions,
  identityOverride
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const bubbleSize = useChatBubbleSize()
  const avatarSize = useChatAvatarSize()
  const sizeClasses = BUBBLE_SIZE_CLASSES[bubbleSize]
  const { updateMode, sendMessage, appendLocalMessage, buildFromPlan } =
    actions ?? ({} as MessageBubbleActions)
  const autoIdentity = useMessageIdentity(message)
  const identity = identityOverride ?? autoIdentity

  // Extracted hook: parses message content to detect structured blocks
  const content = useMessageContent(message.contentMd, message.attachmentsJson, isUser)
  const {
    imageAttachments: _imageAttachments,
    fileAttachments: _fileAttachments,
    isGrillActivation: _isGrillActivation,
    ideaToRefineMatch: _ideaToRefineMatch,
    displayContent: _displayContent,
    planContent,
    structuredPlan,
    buildSummaryData
  } = content

  /** True when the message contains a structured block that MessageCardRenderer handles */
  const hasStructuredContent = buildSummaryData != null || planContent != null

  const persistPlanAction = (action: string): void => {
    if (message.planAction) return // already persisted
    window.api.chatSetPlanAction({ messageId: message.id, action }).catch(console.error)
  }

  const handleBuildNow = (): void => {
    persistPlanAction('build')
    if (structuredPlan && planContent && buildFromPlan) {
      buildFromPlan(structuredPlan, planContent)
      return
    }
    updateMode('build')
    sendMessage(
      'Implement the plan we just discussed. If the plan has multiple phases (3+ sections or 8+ steps), start with only the first phase and let me know you will continue with the remaining phases afterward. If the plan is small enough, implement it all at once.'
    )
  }

  const handleRefine = (): void => {
    persistPlanAction('refine')
    appendLocalMessage("Refine this plan — tell me what to change and I'll update it.")
  }

  const handleSaveAsIdea = (): void => {
    persistPlanAction('save_as_idea')
    if (!actions?.saveAsIdea) return
    const title = 'Implementation Plan'
    const description = planContent ?? ''
    actions.saveAsIdea(title, description)
  }

  const handleCouncilReview = (): void => {
    persistPlanAction('council')
    const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
    if (!workspaceId || !planContent) return
    startCouncilReview(workspaceId, planContent, structuredPlan, message.contentMd ?? '')
  }

  /** Shared AI bubble styles */
  const aiBubbleClass =
    'rounded-md px-4 py-3 bg-surface-overlay text-text-body border-l-2 border-primary/50 shadow-sm overflow-hidden min-w-0'

  return (
    <div
      data-testid="message-bubble"
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar
          avatarKey={identity.avatarKey}
          size={avatarSize}
          accentColor={identity.accentColor}
        />
      </div>

      {/* Content */}
      <div
        className={`flex flex-col min-w-0 ${
          isUser
            ? `${planContent ? 'max-w-[95%]' : sizeClasses.userMax} items-end`
            : `${planContent ? 'max-w-[95%]' : sizeClasses.aiMax} items-start`
        }`}
      >
        <div className={`flex flex-col mb-1 px-1 ${isUser ? 'items-end' : 'items-start'}`}>
          <span data-testid="message-bubble-identity" className="text-sm font-semibold text-text-primary leading-tight">
            {identity.displayName}
          </span>
          {identity.subtitle && (
            <span className="text-xs text-text-secondary leading-tight">{identity.subtitle}</span>
          )}
        </div>

        <BubbleContentBody
          content={content}
          message={message}
          isUser={isUser}
          aiBubbleClass={aiBubbleClass}
          sizeClasses={sizeClasses}
          hasStructuredContent={hasStructuredContent}
          onBuildNow={handleBuildNow}
          onRefine={handleRefine}
          onSaveAsIdea={actions?.saveAsIdea ? handleSaveAsIdea : undefined}
          onCouncilReview={planContent ? handleCouncilReview : undefined}
          planActionTaken={message.planAction}
        />

        <BubbleFooterActions
          message={message}
          isUser={isUser}
          isStreaming={isStreaming}
          toolActivities={toolActivities}
        />
      </div>
    </div>
  )
}

const MessageBubble = React.memo(MessageBubbleInner)
export default MessageBubble

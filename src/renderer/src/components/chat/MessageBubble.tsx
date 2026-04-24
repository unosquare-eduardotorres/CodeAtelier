import React, { useState, useMemo, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import { Paperclip, Flame, Lightbulb, FileText } from 'lucide-react'
import { remarkEmojiSpan, remarkHighlightQuestions, remarkHighlightNextSteps } from './remark-plugins'
import { CodeBlock } from './CodeBlock'
import type {
  Message,
  ToolActivity,
  GrillAnswerPayload,
  ConversationMode,
  StructuredPlan
} from '../../../../shared/types'
import ToolActivityBlock from './ToolActivityBlock'
import MessageCardRenderer from './MessageCardRenderer'
import { useMessageContent } from './useMessageContent'
import { useSpecialistStore, useChatStore } from '@renderer/store'
import {
  Avatar,
  ImageLightbox,
  Skeleton
} from '@renderer/components/common'
import { CORE_AGENT_DEFAULTS, getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'



/** Chat actions needed by MessageBubble — passed as props to avoid N×useShallow subscriptions */
export interface MessageBubbleActions {
  updateMode: (mode: ConversationMode) => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendLocalMessage: (content: string) => void
  clearGrillSession: () => void
  createItemsFromGrill: (
    tasks: { title: string; context: string; description: string }[]
  ) => Promise<void>
  submitGrillAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllGrillQuestions: () => void
  saveAsIdea?: (title: string, description: string) => void
  /** Direct plan-to-build: skip generalist round-trip when structured plan is available */
  buildFromPlan?: (plan: StructuredPlan, planContent: string) => Promise<void>
}

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  isExecutingPlan?: boolean
  searchHighlight?: string
  toolActivities?: ToolActivity[]
  /** When true, skip rendering inline GrillQuestionCard (store-driven card in MessageList takes precedence) */
  suppressInlineGrillCard?: boolean
  /** Chat actions passed from parent to avoid per-bubble store subscriptions */
  actions?: MessageBubbleActions
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Shorten absolute file paths for display:
 * - /Users/x/.claude/plans/foo.md → /plans/foo.md
 * - /Users/x/.claude/agents/bar.yaml → /agents/bar.yaml
 * - /Users/x/Projects/AgentStudio/src/main/index.ts → /…/src/main/index.ts
 * - Keeps the full path in the title tooltip for reference
 */
function shortenFilePath(filePath: string): string {
  // Strip home directory prefix for .claude paths
  const claudeMatch = filePath.match(/^(?:\/Users\/[^/]+|\/home\/[^/]+|~)\/.claude\/(.+)$/)
  if (claudeMatch) {
    return `/${claudeMatch[1]}`
  }

  // For other long paths, show last 3 segments
  const segments = filePath.split('/')
  if (segments.length > 4) {
    return '/…/' + segments.slice(-3).join('/')
  }

  return filePath
}

// Module-level constants — stable references, never recreated on render
const REMARK_PLUGINS_BASE = [remarkGfm, remarkBreaks, remarkEmojiSpan]
const REMARK_PLUGINS = [
  ...REMARK_PLUGINS_BASE,
  remarkHighlightQuestions,
  remarkHighlightNextSteps
]
const REHYPE_PLUGINS = [rehypeRaw]



/** Strip stray backtick text nodes from React children (left over after markdown inline-code parsing) */
function stripStrayBackticks(children: React.ReactNode): React.ReactNode[] | null | undefined {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      const stripped = child.replace(/`/g, '')
      return stripped || null
    }
    if (React.isValidElement(child) && (child.props as Record<string, unknown>)?.children) {
      const childProps = child.props as Record<string, unknown>
      return React.cloneElement(child, {
        ...childProps,
        children: stripStrayBackticks(childProps.children as React.ReactNode)
      } as Record<string, unknown>)
    }
    return child
  })
}

// Module-level markdown components — stable reference, avoids ReactMarkdown full re-render
const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p>{stripStrayBackticks(children)}</p>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{stripStrayBackticks(children)}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong>{stripStrayBackticks(children)}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{stripStrayBackticks(children)}</em>,
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      return <code className={`${className} text-sm`}>{children}</code>
    }

    const text = String(children).replace(/`/g, '').trim()
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
      /^[\w@][\w.\-/@ ]*\/[\w.\-/@ ]*\.\w{1,10}$/.test(text)
    if (isFilePath) {
      const shortenedPath = shortenFilePath(text)
      return (
        <span
          role="button"
          aria-label={`Reveal ${text} in file manager`}
          className="inline-flex items-center gap-1 text-sm font-medium text-info hover:text-info/80 underline decoration-info/40 cursor-pointer transition-colors"
          title={`Reveal in file manager: ${text}`}
          onClick={() => window.api.showItemInFolder(text)}
        >
          <FileText size={13} className="shrink-0" />
          {shortenedPath}
        </span>
      )
    }

    return (
      <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm text-text-body font-semibold">
        {text}
      </code>
    )
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

/**
 * Resolves the display identity (name, subtitle, avatar, color) for a message.
 * Single source of truth: specialist store for ALL roles (user, generalist, coordinator, specialists).
 */
function useMessageIdentity(message: Message): {
  displayName: string
  subtitle: string | null
  avatarKey: string
  accentColor: string
} {
  const specialists = useSpecialistStore((s) => s.specialists)
  const activeConversation = useChatStore((s) => s.activeConversation)

  return useMemo(() => {
    // For user messages — find the 'user' specialist
    if (message.role === 'user') {
      const userSpec = specialists.find((s) => s.agentId === 'user')
      return {
        displayName: userSpec?.alias ?? userSpec?.displayName ?? 'You',
        subtitle: null,
        avatarKey: userSpec?.avatarUrl ?? 'business-man',
        accentColor: 'var(--color-primary, #6366F1)'
      }
    }

    // For core agents (generalist/coordinator) — find their specialist record
    // Coordinator role is deprecated — map to generalist identity (Da Vinci)
    const coreRole =
      message.role === 'generalist'
        ? 'generalist'
        : message.role === 'coordinator'
          ? 'generalist'
          : null

    if (coreRole) {
      // Persona override — when conversation has a persona, generalist messages
      // show that persona's identity (full visual swap)
      const personaId = activeConversation?.personaSpecialistId
      if (personaId) {
        const persona = specialists.find((s) => s.id === personaId)
        if (persona && persona.agentId !== 'user') {
          return {
            displayName: persona.alias ?? persona.displayName,
            subtitle: persona.alias ? persona.displayName : null,
            avatarKey: persona.avatarUrl ?? getDefaultAvatarForRole(persona.agentId),
            accentColor: persona.color ?? '#F59E0B'
          }
        }
      }

      // Default Da Vinci identity
      const coreSpec = specialists.find((s) => s.agentId === coreRole)
      const defaults = CORE_AGENT_DEFAULTS[coreRole]
      return {
        displayName: coreSpec?.alias ?? coreSpec?.displayName ?? defaults?.displayName ?? coreRole,
        subtitle: coreSpec?.alias ? (coreSpec?.displayName ?? defaults?.displayName ?? null) : null,
        avatarKey: coreSpec?.avatarUrl ?? defaults?.avatarKey ?? 'renaissance-alchemist',
        accentColor: coreSpec?.color ?? defaults?.color ?? '#6366F1'
      }
    }

    // For specialist messages — find by agentId
    const specialist = specialists.find((s) => s.agentId === message.agentId)
    if (specialist) {
      return {
        displayName: specialist.alias ?? specialist.displayName,
        subtitle: specialist.alias ? specialist.displayName : null,
        avatarKey: specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId),
        accentColor: specialist.color ?? '#F59E0B'
      }
    }

    // Fallback for unknown agent
    return {
      displayName: message.agentId ?? message.role,
      subtitle: null,
      avatarKey: getDefaultAvatarForRole(message.agentId ?? message.role),
      accentColor: '#6366F1'
    }
  }, [message.role, message.agentId, specialists, activeConversation?.personaSpecialistId])
}

/** Renders a single image attachment inside a message bubble using data URIs */
function BubbleImage({ filePath }: { filePath: string }): React.JSX.Element {
  const [dataUri, setDataUri] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .readImageBase64({ filePath })
      .then((uri) => {
        if (!cancelled) setDataUri(uri)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [filePath])

  return (
    <>
      {dataUri ? (
        <img
          src={dataUri}
          alt={filePath.split('/').pop() || 'attachment'}
          className="max-w-[240px] max-h-[180px] rounded-lg border border-border-subtle object-contain cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => setLightboxOpen(true)}
        />
      ) : (
        <Skeleton className="w-[240px] h-[180px] rounded-lg" />
      )}
      {lightboxOpen && dataUri && (
        <ImageLightbox src={dataUri} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

function MessageBubbleInner({
  message,
  isStreaming,
  isExecutingPlan,
  toolActivities,
  suppressInlineGrillCard,
  actions
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user'
  // Use actions from props (passed by MessageList) to avoid N×useShallow subscriptions
  const {
    updateMode,
    sendMessage,
    appendLocalMessage,
    clearGrillSession,
    createItemsFromGrill,
    submitGrillAnswers,
    skipAllGrillQuestions,
    buildFromPlan
  } = actions!
  const identity = useMessageIdentity(message)

  // Extracted hook: parses message content to detect structured blocks
  const content = useMessageContent(
    message.contentMd,
    message.attachmentsJson,
    isUser,
    suppressInlineGrillCard
  )
  const {
    imageAttachments,
    fileAttachments,
    isGrillActivation,
    ideaToRefineMatch,
    displayContent,
    planContent,
    structuredPlan,
    grillQuestions,
    grillQuestionMatch,
    grillSummary,
    grillEvalData,
    buildSummaryData
  } = content

  /** True when the message contains a structured block that MessageCardRenderer handles */
  const hasStructuredContent =
    grillQuestions.length > 0 ||
    (grillQuestionMatch != null && suppressInlineGrillCard) ||
    grillSummary != null ||
    grillEvalData != null ||
    buildSummaryData != null ||
    planContent != null

  const handleBuildNow = (): void => {
    // Direct path: skip generalist round-trip when structured plan is available
    if (structuredPlan && planContent && buildFromPlan) {
      buildFromPlan(structuredPlan, planContent)
      return
    }
    // Fallback: raw markdown plan — go through generalist
    updateMode('build')
    sendMessage(
      'Implement the plan we just discussed. If the plan has multiple phases (3+ sections or 8+ steps), start with only the first phase and let me know you will continue with the remaining phases afterward. If the plan is small enough, implement it all at once.'
    )
  }

  const handleRefine = (): void => {
    appendLocalMessage("Refine this plan — tell me what to change and I'll update it.")
  }

  const handleOrchestratedBuild = (): void => {
    // Direct path: skip generalist round-trip when structured plan is available
    if (structuredPlan && planContent && buildFromPlan) {
      buildFromPlan(structuredPlan, planContent)
      return
    }
    // Fallback: raw markdown plan — go through generalist
    updateMode('build')
    sendMessage(
      'Implement the plan we just discussed using multiple specialists in parallel where possible.'
    )
  }

  const handleSaveAsIdea = (): void => {
    if (!actions?.saveAsIdea) return
    const title = 'Implementation Plan'
    const description = planContent ?? ''
    actions.saveAsIdea(title, description)
  }

  const handleGrillKeepIterating = (): void => {
    clearGrillSession()
    sendMessage("Let's keep iterating. What other aspects should we discuss or refine?")
  }

  const handleGrillCreatePlan = (): void => {
    clearGrillSession()
    sendMessage(
      "Based on our grilling session and all the decisions we've resolved, create a formal implementation plan. Structure it with clear sections, tasks, and dependencies."
    )
  }

  const handleGrillCreateItems = (): void => {
    if (grillProposedTasks.length > 0) {
      const tasks = grillProposedTasks.map((t) => ({
        title: t.title,
        context: grillSummary || 'Context from grill session',
        description: t.description
      }))
      createItemsFromGrill(tasks)
    }
  }

  /** Shared AI bubble styles */
  const aiBubbleClass =
    'rounded-md px-5 py-4 bg-surface-overlay text-text-body border-l-[3px] border-primary/60 shadow-sm overflow-hidden min-w-0'

  return (
    <div
      data-testid="message-bubble"
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar
          avatarKey={identity.avatarKey}
          size="xl"
          accentColor={identity.accentColor}
          fallbackInitials={identity.displayName}
        />
      </div>

      {/* Content */}
      <div
        className={`flex flex-col min-w-0 ${isUser ? 'max-w-[75%] items-end' : 'max-w-[85%] items-start'}`}
      >
        <div className={`flex flex-col mb-1 px-1 ${isUser ? 'items-end' : 'items-start'}`}>
          <span className="text-sm font-semibold text-text-primary leading-tight">
            {identity.displayName}
          </span>
          {identity.subtitle && (
            <span className="text-xs text-text-secondary leading-tight">{identity.subtitle}</span>
          )}
        </div>

        {/* Structured card rendering (grill, plan, build summary, handoff) — extracted to reduce complexity */}
        {hasStructuredContent ? (
          <MessageCardRenderer
            content={content}
            isExecutingPlan={isExecutingPlan}
            aiBubbleClass={aiBubbleClass}
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            markdownComponents={markdownComponents}
            suppressInlineGrillCard={suppressInlineGrillCard}
            onBuildNow={handleBuildNow}
            onRefine={handleRefine}
            onOrchestratedBuild={handleOrchestratedBuild}
            onSaveAsIdea={actions?.saveAsIdea ? handleSaveAsIdea : undefined}
            onGrillKeepIterating={handleGrillKeepIterating}
            onGrillCreatePlan={handleGrillCreatePlan}
            onGrillCreateItems={handleGrillCreateItems}
            submitGrillAnswers={submitGrillAnswers}
            skipAllGrillQuestions={skipAllGrillQuestions}
          />
        ) : (
          /* Default: plain message bubble (no structured block detected) */
          <div
            className={`rounded shadow-sm ${
              isUser
                ? `px-5 py-4 bg-user-bubble text-text-body border-l-2 overflow-hidden min-w-0 ${isGrillActivation ? 'border-grill' : 'border-primary'}`
                : aiBubbleClass
            }`}
          >
            {/* 🔥 Grill Mode activation banner */}
            {isGrillActivation && (
              <div className="flex items-center gap-2 mb-3 pb-3 border-b border-grill/30">
                <Flame size={16} className="text-accent shrink-0" />
                <span className="text-sm font-semibold text-accent">Grill Mode Activated</span>
                <Flame size={16} className="text-accent shrink-0" />
              </div>
            )}

            {/* 💡 Idea to Refine subtitle */}
            {ideaToRefineMatch && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-warning-muted rounded-lg border border-warning/20">
                <Lightbulb size={14} className="text-warning shrink-0" />
                <span className="text-sm font-medium text-warning">
                  Idea to Refine: <span className="text-text-body">{ideaToRefineMatch[1]}</span>
                </span>
              </div>
            )}

            {/* Image attachments */}
            {imageAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {imageAttachments.map((path, idx) => (
                  <BubbleImage key={idx} filePath={path} />
                ))}
              </div>
            )}

            {/* File attachments */}
            {fileAttachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {fileAttachments.map((path, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-overlay text-xs text-text-secondary"
                  >
                    <Paperclip size={10} />
                    {path.split('/').pop() || path}
                  </span>
                ))}
              </div>
            )}

            {(isUser ? displayContent : message.contentMd) ? (
              <div className="prose max-w-none overflow-hidden">
                <ReactMarkdown
                  remarkPlugins={isUser ? REMARK_PLUGINS_BASE : REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={markdownComponents}
                >
                  {isUser ? displayContent : message.contentMd}
                </ReactMarkdown>
              </div>
            ) : isStreaming ? (
              <div className="flex items-center gap-1.5 py-1">
                <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-2 h-2 bg-primary-text rounded-full animate-bounce" />
              </div>
            ) : null}
          </div>
        )}

        {/* Inline tool activity block */}
        {toolActivities && toolActivities.length > 0 && (
          <ToolActivityBlock activities={toolActivities} />
        )}

        <div className="flex items-center gap-2 mt-1 px-1 group">
          <span className="text-xs text-text-secondary">
            {formatTime(message.createdAt)}
            {isStreaming && ' · Streaming...'}
          </span>
          {!isUser && !isStreaming && (
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
          )}
        </div>
      </div>
    </div>
  )
}

const MessageBubble = React.memo(MessageBubbleInner)
export default MessageBubble

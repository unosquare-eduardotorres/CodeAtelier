import React, { useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent } from 'mdast'
import { visit } from 'unist-util-visit'
import { Copy, Check, Paperclip } from 'lucide-react'
import type { Message, ToolActivity, GrillProposedTask } from '../../../../shared/types'
import PlanCard from './PlanCard'
import GrillResultCard from './GrillResultCard'
import ToolActivityBlock from './ToolActivityBlock'
import { useChatStore, useProfileStore, useSpecialistStore } from '@renderer/store'
import { MermaidDiagram, Avatar } from '@renderer/components/common'
import { CORE_AGENT_DEFAULTS, getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'

/**
 * Remark plugin: wraps emoji characters inside headings with a styled <span class="emoji">
 * so CSS can normalize their size and alignment.
 */
const remarkEmojiSpan: Plugin<[], Root> = () => {
  // Matches common emoji: symbols, dingbats, emoticons, flags, skin-tone modifiers, ZWJ sequences
  const emojiRegex =
    /(\p{Emoji_Presentation}|\p{Extended_Pictographic})(\u200D(\p{Emoji_Presentation}|\p{Extended_Pictographic}))*/gu

  return (tree) => {
    visit(tree, 'heading', (node) => {
      const newChildren: PhrasingContent[] = []
      for (const child of node.children) {
        if (child.type !== 'text') {
          newChildren.push(child)
          continue
        }
        const text = (child as Text).value
        let lastIndex = 0
        let match: RegExpExecArray | null

        emojiRegex.lastIndex = 0
        while ((match = emojiRegex.exec(text)) !== null) {
          // Text before the emoji
          if (match.index > lastIndex) {
            newChildren.push({ type: 'text', value: text.slice(lastIndex, match.index) })
          }
          // Wrap emoji in an html node that renders as <span class="emoji">
          newChildren.push({
            type: 'html',
            value: `<span class="emoji">${match[0]}</span>`
          })
          lastIndex = match.index + match[0].length
        }
        // Remainder after last emoji
        if (lastIndex < text.length) {
          newChildren.push({ type: 'text', value: text.slice(lastIndex) })
        }
        // If no emoji was found, keep original
        if (lastIndex === 0) {
          newChildren.push(child)
        }
      }
      node.children = newChildren
    })
  }
}

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  searchHighlight?: string
  toolActivities?: ToolActivity[]
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // Extract language and code text from children
  const codeChild = React.Children.toArray(children).find(
    (child): child is React.ReactElement =>
      React.isValidElement(child) && (child as React.ReactElement).type === 'code'
  )

  const className = (codeChild?.props as { className?: string })?.className || ''
  const language = className.replace('language-', '')
  const codeText = String(
    (codeChild?.props as { children?: React.ReactNode })?.children || ''
  ).replace(/\n$/, '')

  // ── Mermaid: render as interactive diagram ──
  if (language === 'mermaid') {
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border-subtle">
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-base border-b border-border-subtle">
          <span className="text-xs text-primary-text font-mono">mermaid diagram</span>
        </div>
        <MermaidDiagram definition={codeText} />
      </div>
    )
  }

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for non-secure contexts
      console.error('Failed to copy to clipboard')
    }
  }, [codeText])

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-border-subtle">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-base border-b border-border-subtle">
        <span className="text-xs text-text-secondary font-mono">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors px-1.5 py-0.5 rounded hover:bg-surface-overlay"
          aria-label={copied ? 'Copied!' : 'Copy code'}
          title={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check size={12} className="text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="bg-surface-base p-3 overflow-x-auto text-sm whitespace-pre-wrap break-words">
        {children}
      </pre>
    </div>
  )
}

/**
 * Resolves the display identity (name, subtitle, avatar, color) for a message.
 * Uses profile store for user messages, specialist store + core agent aliases for agent messages.
 */
function useMessageIdentity(message: Message): {
  displayName: string
  subtitle: string | null
  avatarKey: string
  accentColor: string
} {
  const { profile, getCoreAgentAlias } = useProfileStore()
  const { specialists } = useSpecialistStore()

  return useMemo(() => {
    if (message.role === 'user') {
      return {
        displayName: profile?.displayName ?? 'You',
        subtitle: null,
        avatarKey: profile?.avatarKey ?? 'business-man',
        accentColor: 'var(--color-primary, #6366F1)'
      }
    }

    // Check if this is a core agent (generalist or coordinator/orchestrator)
    const coreRole =
      message.role === 'generalist'
        ? 'generalist'
        : message.role === 'coordinator'
          ? 'coordinator'
          : null
    if (coreRole) {
      const coreAlias = getCoreAgentAlias(coreRole)
      const defaults = CORE_AGENT_DEFAULTS[coreRole]
      const alias = coreAlias?.alias ?? null
      const roleName = defaults?.displayName ?? coreRole
      return {
        displayName: alias ?? roleName,
        subtitle: alias ? roleName : null,
        avatarKey: coreAlias?.avatarKey ?? defaults?.avatarKey ?? 'robot',
        accentColor: defaults?.color ?? '#6366F1'
      }
    }

    // For specialist messages, find the specialist by agentId
    const specialist = specialists.find((s) => s.agentId === message.agentId)
    if (specialist) {
      const alias = specialist.alias
      const roleName = specialist.displayName
      return {
        displayName: alias ?? roleName,
        subtitle: alias ? roleName : null,
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
  }, [message.role, message.agentId, profile, specialists, getCoreAgentAlias])
}

function MessageBubbleInner({
  message,
  isStreaming,
  toolActivities
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const { updateMode, sendMessage, clearGrillSession, createItemsFromGrill } = useChatStore()
  const identity = useMessageIdentity(message)

  // Parse attachments from JSON
  const attachments: string[] = (() => {
    try {
      const parsed = JSON.parse(message.attachmentsJson || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()

  const imageAttachments = attachments.filter((p) => /\.(png|jpg|jpeg|gif|webp)$/i.test(p))
  const fileAttachments = attachments.filter((p) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(p))

  // Detect plan blocks in coordinator/generalist messages
  const planRegex = /```plan\n([\s\S]*?)```/
  const planMatch = !isUser ? message.contentMd.match(planRegex) : null

  // Detect grill-summary blocks
  const grillRegex = /```grill-summary\n([\s\S]*?)```/
  const grillMatch = !isUser ? message.contentMd.match(grillRegex) : null
  let grillSummary: string | null = null
  let grillProposedTasks: GrillProposedTask[] = []

  if (grillMatch) {
    try {
      const parsed = JSON.parse(grillMatch[1].trim())
      grillSummary = parsed.summary || null
      grillProposedTasks = Array.isArray(parsed.proposedTasks) ? parsed.proposedTasks : []
    } catch {
      // Failed to parse grill summary — will render as normal markdown
    }
  }

  const handleBuild = (): void => {
    updateMode('build')
    sendMessage('Implement the plan we just discussed. Follow the steps exactly.')
  }

  const handleRefine = (feedback: string): void => {
    sendMessage(`Please refine the plan: ${feedback}`)
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

  // Split content around plan block if found
  const beforePlan = planMatch ? message.contentMd.substring(0, planMatch.index!) : null
  const afterPlan = planMatch
    ? message.contentMd.substring(planMatch.index! + planMatch[0].length)
    : null
  const planContent = planMatch ? planMatch[1] : null

  // Split content around grill-summary block if found
  const beforeGrill = grillMatch ? message.contentMd.substring(0, grillMatch.index!) : null
  const afterGrill = grillMatch
    ? message.contentMd.substring(grillMatch.index! + grillMatch[0].length)
    : null

  const markdownComponents = {
    pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      const isBlock = className?.includes('language-')
      if (isBlock) {
        return <code className={`${className} text-sm`}>{children}</code>
      }

      // Check if the code content is a URL — render as clickable link
      const text = String(children).trim()
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
            {children}
          </a>
        )
      }

      return (
        <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm text-primary-text">
          {children}
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

  /** Shared AI bubble styles */
  const aiBubbleClass =
    'rounded-2xl px-5 py-4 bg-surface-overlay text-text-body border-l-2 border-primary/40 shadow-sm'

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar
          avatarKey={identity.avatarKey}
          size="md"
          accentColor={identity.accentColor}
          fallbackInitials={identity.displayName}
        />
      </div>

      {/* Content */}
      <div
        className={`flex flex-col ${isUser ? 'max-w-[75%] items-end' : 'max-w-[85%] items-start'}`}
      >
        <div className={`flex flex-col mb-1 px-1 ${isUser ? 'items-end' : 'items-start'}`}>
          <span className="text-sm font-semibold text-text-primary leading-tight">
            {identity.displayName}
          </span>
          {identity.subtitle && (
            <span className="text-xs text-text-muted leading-tight">{identity.subtitle}</span>
          )}
        </div>

        {grillSummary ? (
          /* Message with a grill-summary block — split into before/grill/after */
          <div className="space-y-3 max-w-full">
            {beforeGrill?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkEmojiSpan]}
                    components={markdownComponents}
                  >
                    {beforeGrill}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            <GrillResultCard
              summary={grillSummary}
              proposedTasks={grillProposedTasks}
              onKeepIterating={handleGrillKeepIterating}
              onCreatePlan={handleGrillCreatePlan}
              onCreateItems={handleGrillCreateItems}
            />
            {afterGrill?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkEmojiSpan]}
                    components={markdownComponents}
                  >
                    {afterGrill}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : planContent ? (
          /* Message with a plan block — split into before/plan/after */
          <div className="space-y-3 max-w-full">
            {beforePlan?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkEmojiSpan]}
                    components={markdownComponents}
                  >
                    {beforePlan}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            <PlanCard planContent={planContent} onBuild={handleBuild} onRefine={handleRefine} />
            {afterPlan?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkEmojiSpan]}
                    components={markdownComponents}
                  >
                    {afterPlan}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            className={`rounded-2xl shadow-sm ${
              isUser ? 'px-5 py-4 bg-[oklch(0.24_0.04_277)] text-text-body border-l-2 border-primary' : aiBubbleClass
            }`}
          >
            {/* Image attachments */}
            {imageAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {imageAttachments.map((path, idx) => (
                  <img
                    key={idx}
                    src={`file://${path}`}
                    alt={path.split('/').pop() || 'attachment'}
                    className="max-w-[240px] max-h-[180px] rounded-lg border border-border-subtle object-contain cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => window.open(`file://${path}`, '_blank')}
                  />
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

            {message.contentMd ? (
              <div className={`prose max-w-none ${isUser ? 'prose-invert' : 'prose-invert'}`}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks, remarkEmojiSpan]}
                  components={markdownComponents}
                >
                  {message.contentMd}
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

        <span className="text-xs text-text-muted mt-1 px-1">
          {formatTime(message.createdAt)}
          {isStreaming && ' · Streaming...'}
        </span>
      </div>
    </div>
  )
}

const MessageBubble = React.memo(MessageBubbleInner)
export default MessageBubble

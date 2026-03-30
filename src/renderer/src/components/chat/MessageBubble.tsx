import React, { useState, useCallback, useMemo, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent } from 'mdast'
import { visit } from 'unist-util-visit'
import { Copy, Check, Paperclip, Flame, Lightbulb, FileText } from 'lucide-react'
import type { Message, ToolActivity, GrillProposedTask, GrillQuestion, GrillAnswerPayload, ConversationMode } from '../../../../shared/types'
import PlanCard from './PlanCard'
import GrillEvaluationCard from './GrillEvaluationCard'
import GrillResultCard from './GrillResultCard'
import GrillQuestionCard from './GrillQuestionCard'
import ToolActivityBlock from './ToolActivityBlock'
import { useProfileStore, useSpecialistStore } from '@renderer/store'
import { MermaidDiagram, Avatar, ImageLightbox, Skeleton, PixelSpriteAvatar } from '@renderer/components/common'
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
        // If no emoji was found, keep original child unchanged
        if (lastIndex === 0) {
          newChildren.push(child)
        } else if (lastIndex < text.length) {
          // Remainder text after the last emoji
          newChildren.push({ type: 'text', value: text.slice(lastIndex) })
        }
      }
      node.children = newChildren
    })
  }
}

/** Chat actions needed by MessageBubble — passed as props to avoid N×useShallow subscriptions */
export interface MessageBubbleActions {
  updateMode: (mode: ConversationMode) => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendLocalMessage: (content: string) => void
  clearGrillSession: () => void
  createItemsFromGrill: (tasks: { title: string; context: string; description: string }[]) => Promise<void>
  submitGrillAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllGrillQuestions: () => void
}

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
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
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkEmojiSpan]
const REHYPE_PLUGINS = [rehypeRaw]

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
              <Check size={12} className="text-success" />
              <span className="text-success">Copied</span>
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

/** Strip stray backtick text nodes from React children (left over after markdown inline-code parsing) */
function stripStrayBackticks(children: React.ReactNode): React.ReactNode[] | null | undefined {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      const stripped = child.replace(/`/g, '')
      return stripped || null
    }
    return child
  })
}

// Module-level markdown components — stable reference, avoids ReactMarkdown full re-render
const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p>{stripStrayBackticks(children)}</p>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li>{stripStrayBackticks(children)}</li>
  ),
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
      /^[\/~][\w.\-\/@ ]+\.\w{1,10}$/.test(text) || /^[A-Z]:\\/.test(text)
    if (isFilePath) {
      const shortenedPath = shortenFilePath(text)
      return (
        <code
          role="button"
          aria-label={`Reveal ${text} in file manager`}
          className="flex items-center gap-1.5 w-fit bg-primary-muted px-2.5 py-1 rounded-md text-sm font-medium text-primary-text hover:bg-primary/25 cursor-pointer transition-colors my-1"
          title={`Reveal in file manager: ${text}`}
          onClick={() => window.api.showItemInFolder(text)}
        >
          <FileText size={13} className="shrink-0" />
          {shortenedPath}
        </code>
      )
    }

    return (
      <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm text-primary-text">
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
 * Uses profile store for user messages, specialist store + core agent aliases for agent messages.
 */
function useMessageIdentity(message: Message): {
  displayName: string
  subtitle: string | null
  avatarKey: string
  accentColor: string
  pixelSpriteId: string | null
} {
  // Select only the specific fields we need — avoids re-renders when unrelated store fields change
  const profileDisplayName = useProfileStore((s) => s.profile?.displayName ?? 'You')
  const profileAvatarKey = useProfileStore((s) => s.profile?.avatarKey ?? 'business-man')
  const getCoreAgentAlias = useProfileStore((s) => s.getCoreAgentAlias)
  // Select only the specialist matching this message's agentId — stable reference if specialist unchanged
  const specialist = useSpecialistStore((s) =>
    message.agentId ? s.specialists.find((sp) => sp.agentId === message.agentId) ?? null : null
  )

  // For core agents (generalist/coordinator), look up their specialist record
  // to get pixel sprite data (usePixelForChat, pixelSpriteId)
  const coreRole = message.role === 'generalist'
    ? 'generalist'
    : message.role === 'coordinator'
      ? 'coordinator'
      : null
  const coreSpecialist = useSpecialistStore((s) =>
    coreRole ? s.specialists.find((sp) => sp.agentId === coreRole) ?? null : null
  )

  return useMemo(() => {
    if (message.role === 'user') {
      return {
        displayName: profileDisplayName,
        subtitle: null,
        avatarKey: profileAvatarKey,
        accentColor: 'var(--color-primary, #6366F1)',
        pixelSpriteId: null
      }
    }

    // Check if this is a core agent (generalist or coordinator)
    if (coreRole) {
      const coreAlias = getCoreAgentAlias(coreRole)
      const defaults = CORE_AGENT_DEFAULTS[coreRole]
      const alias = coreAlias?.alias ?? null
      const roleName = defaults?.displayName ?? coreRole
      // Check specialist record for pixel sprite
      const usePixel = coreSpecialist?.usePixelForChat && coreSpecialist?.pixelSpriteId
      return {
        displayName: alias ?? roleName,
        subtitle: alias ? roleName : null,
        avatarKey: coreAlias?.avatarKey ?? defaults?.avatarKey ?? 'renaissance-alchemist',
        accentColor: defaults?.color ?? '#6366F1',
        pixelSpriteId: usePixel ? coreSpecialist!.pixelSpriteId : null
      }
    }

    // For specialist messages, use pre-selected specialist
    if (specialist) {
      const alias = specialist.alias
      const roleName = specialist.displayName
      const usePixel = specialist.usePixelForChat && specialist.pixelSpriteId
      return {
        displayName: alias ?? roleName,
        subtitle: alias ? roleName : null,
        avatarKey: specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId),
        accentColor: specialist.color ?? '#F59E0B',
        pixelSpriteId: usePixel ? specialist.pixelSpriteId : null
      }
    }

    // Fallback for unknown agent
    return {
      displayName: message.agentId ?? message.role,
      subtitle: null,
      avatarKey: getDefaultAvatarForRole(message.agentId ?? message.role),
      accentColor: '#6366F1',
      pixelSpriteId: null
    }
  }, [message.role, message.agentId, profileDisplayName, profileAvatarKey, specialist, getCoreAgentAlias, coreRole, coreSpecialist])
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
  toolActivities,
  suppressInlineGrillCard,
  actions
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user'
  // Use actions from props (passed by MessageList) to avoid N×useShallow subscriptions
  const { updateMode, sendMessage, appendLocalMessage, clearGrillSession, createItemsFromGrill, submitGrillAnswers, skipAllGrillQuestions } = actions!
  const identity = useMessageIdentity(message)

  // Memoize all regex matching, JSON parsing, and content splitting to avoid redundant work on re-render
  const {
    attachments, imageAttachments, fileAttachments,
    isGrillActivation, ideaToRefineMatch, displayContent,
    planMatch, planContent, beforePlan, afterPlan,
    grillMatch, grillSummary, grillProposedTasks, beforeGrill, afterGrill,
    grillQuestionMatch, grillQuestions, beforeGrillQuestion, afterGrillQuestion,
    grillEvalMatch, grillEvalData, beforeGrillEval, afterGrillEval,
    handoffMatch, beforeHandoff, afterHandoff
  } = useMemo(() => {
    // Parse attachments
    let parsedAttachments: string[] = []
    try {
      const parsed = JSON.parse(message.attachmentsJson || '[]')
      parsedAttachments = Array.isArray(parsed) ? parsed : []
    } catch { /* noop */ }
    const imageAtts = parsedAttachments.filter((p) => /\.(png|jpg|jpeg|gif|webp)$/i.test(p))
    const fileAtts = parsedAttachments.filter((p) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(p))

    // Grill activation detection
    const grillActivation = isUser && message.contentMd.startsWith('[GRILL MODE ACTIVATED]')
    const ideaMatch = grillActivation
      ? message.contentMd.match(/## Idea to Refine\n\*\*(.+?)\*\*/)
      : null

    // Clean display content for grill messages
    let dispContent = message.contentMd
    if (grillActivation) {
      dispContent = message.contentMd.replace(/^\[GRILL MODE ACTIVATED\]\s*/, '')
      if (ideaMatch) {
        dispContent = dispContent.replace(/## Idea to Refine\n\*\*.+?\*\*\n*/, '')
      }
      dispContent = dispContent.trim()
    }

    // Detect plan blocks
    const pMatch = !isUser ? message.contentMd.match(/````plan\n([\s\S]*?)````/) : null
    const pContent = pMatch ? pMatch[1] : null
    const bPlan = pMatch ? message.contentMd.substring(0, pMatch.index!) : null
    const aPlan = pMatch ? message.contentMd.substring(pMatch.index! + pMatch[0].length) : null

    // Detect grill-summary blocks
    const gMatch = !isUser ? message.contentMd.match(/```grill-summary\n([\s\S]*?)```/) : null
    let gSummary: string | null = null
    let gProposedTasks: GrillProposedTask[] = []
    if (gMatch) {
      try {
        const parsed = JSON.parse(gMatch[1].trim())
        gSummary = parsed.summary || null
        gProposedTasks = Array.isArray(parsed.proposedTasks) ? parsed.proposedTasks : []
      } catch { /* noop */ }
    }
    const bGrill = gMatch ? message.contentMd.substring(0, gMatch.index!) : null
    const aGrill = gMatch ? message.contentMd.substring(gMatch.index! + gMatch[0].length) : null

    // Detect grill-question blocks
    const gqMatch = !isUser ? message.contentMd.match(/```grill-question\n([\s\S]*?)```/) : null
    let gQuestions: GrillQuestion[] = []
    if (gqMatch && !suppressInlineGrillCard) {
      try {
        const parsed = JSON.parse(gqMatch[1].trim())
        if (parsed.questions && Array.isArray(parsed.questions)) {
          gQuestions = parsed.questions
        }
      } catch { /* noop */ }
    }
    const bGrillQ = gqMatch ? message.contentMd.substring(0, gqMatch.index!) : null
    const aGrillQ = gqMatch ? message.contentMd.substring(gqMatch.index! + gqMatch[0].length) : null

    // Detect grill-evaluation blocks
    const geMatch = !isUser ? message.contentMd.match(/```grill-evaluation\n([\s\S]*?)```/) : null
    let geData: { score: number; scoreLabel: string; feedback: string; questions: GrillQuestion[] } | null = null
    if (geMatch) {
      try {
        const parsed = JSON.parse(geMatch[1].trim())
        if (typeof parsed.score === 'number' && Array.isArray(parsed.questions)) {
          geData = {
            score: parsed.score,
            scoreLabel: parsed.scoreLabel ?? '',
            feedback: parsed.feedback ?? '',
            questions: parsed.questions
          }
        }
      } catch { /* noop */ }
    }
    const bGrillEval = geMatch ? message.contentMd.substring(0, geMatch.index!) : null
    const aGrillEval = geMatch ? message.contentMd.substring(geMatch.index! + geMatch[0].length) : null

    // Detect handoff blocks — strip from display (HandoffIndicator renders separately in MessageList)
    const hMatch = !isUser
      ? (message.contentMd.match(/```handoff\n([\s\S]*?)```/) ??
         message.contentMd.match(/```(?:json)?\n(\{[\s\S]*?"action"\s*:\s*"handoff"[\s\S]*?\})\n```/))
      : null
    const bHandoff = hMatch ? message.contentMd.substring(0, hMatch.index!) : null
    const aHandoff = hMatch ? message.contentMd.substring(hMatch.index! + hMatch[0].length) : null

    return {
      attachments: parsedAttachments,
      imageAttachments: imageAtts,
      fileAttachments: fileAtts,
      isGrillActivation: grillActivation,
      ideaToRefineMatch: ideaMatch,
      displayContent: dispContent,
      planMatch: pMatch,
      planContent: pContent,
      beforePlan: bPlan,
      afterPlan: aPlan,
      grillMatch: gMatch,
      grillSummary: gSummary,
      grillProposedTasks: gProposedTasks,
      beforeGrill: bGrill,
      afterGrill: aGrill,
      grillQuestionMatch: gqMatch,
      grillQuestions: gQuestions,
      beforeGrillQuestion: bGrillQ,
      afterGrillQuestion: aGrillQ,
      grillEvalMatch: geMatch,
      grillEvalData: geData,
      beforeGrillEval: bGrillEval,
      afterGrillEval: aGrillEval,
      handoffMatch: hMatch,
      beforeHandoff: bHandoff,
      afterHandoff: aHandoff
    }
  }, [message.contentMd, message.attachmentsJson, isUser, suppressInlineGrillCard])

  const handleBuild = (): void => {
    updateMode('build')
    sendMessage(
      'Implement the plan we just discussed. If the plan has multiple phases (3+ sections or 8+ steps), start with only the first phase and let me know you will continue with the remaining phases afterward. If the plan is small enough, implement it all at once.'
    )
  }

  const handleRefine = (): void => {
    appendLocalMessage('📋 Plan cancelled. Please provide a new prompt to generate a fresh plan.')
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
    'rounded px-5 py-4 bg-surface-overlay text-text-body border-l-2 border-primary/40 shadow-sm overflow-hidden min-w-0'

  return (
    <div data-testid="message-bubble" className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        {identity.pixelSpriteId ? (
          <PixelSpriteAvatar spriteId={identity.pixelSpriteId} size={72} />
        ) : (
          <Avatar
            avatarKey={identity.avatarKey}
            size="xl"
            accentColor={identity.accentColor}
            fallbackInitials={identity.displayName}
          />
        )}
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

        {grillQuestions.length > 0 ? (
          /* Message with a grill-question block — split into before/questions/after */
          <div className="space-y-3 max-w-full">
            {beforeGrillQuestion?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {beforeGrillQuestion}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            <GrillQuestionCard
              questions={grillQuestions}
              onSubmit={submitGrillAnswers}
              onSkipAll={skipAllGrillQuestions}
            />
            {afterGrillQuestion?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {afterGrillQuestion}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : grillQuestionMatch && suppressInlineGrillCard ? (
          /* Grill-question block detected but suppressed (store-driven card active) — render surrounding text only, hide JSON */
          <div className={aiBubbleClass}>
            <div className="prose max-w-none">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {[beforeGrillQuestion?.trim(), afterGrillQuestion?.trim()].filter(Boolean).join('\n\n')}
              </ReactMarkdown>
            </div>
          </div>
        ) : grillSummary ? (
          /* Message with a grill-summary block — split into before/grill/after */
          <div className="space-y-3 max-w-full">
            {beforeGrill?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
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
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {afterGrill}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : grillEvalData ? (
          /* Message with a grill-evaluation block — split into before/eval/after */
          <div className="space-y-3 max-w-full">
            {beforeGrillEval?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {beforeGrillEval}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            <GrillEvaluationCard
              score={grillEvalData.score}
              scoreLabel={grillEvalData.scoreLabel}
              feedback={grillEvalData.feedback}
              questions={grillEvalData.questions}
            />
            {afterGrillEval?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {afterGrillEval}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : handoffMatch ? (
          /* Message with a handoff block — strip the JSON, show only surrounding text */
          <div className={aiBubbleClass}>
            <div className="prose max-w-none">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={markdownComponents}>
                {[beforeHandoff?.trim(), afterHandoff?.trim()].filter(Boolean).join('\n\n')}
              </ReactMarkdown>
            </div>
          </div>
        ) : planContent ? (
          /* Message with a plan block — split into before/plan/after */
          <div className="space-y-3 max-w-full">
            {beforePlan?.trim() && (
              <div className={aiBubbleClass}>
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
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
                <div className="prose max-w-none">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
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
            className={`rounded shadow-sm ${
              isUser ? `px-5 py-4 bg-user-bubble text-text-body border-l-2 overflow-hidden min-w-0 ${isGrillActivation ? 'border-grill' : 'border-primary'}` : aiBubbleClass
            }`}
          >
            {/* 🔥 Grill Mode activation banner */}
            {isGrillActivation && (
              <div className="flex items-center gap-2 mb-3 pb-3 border-b border-grill/30">
                <Flame size={16} className="text-accent shrink-0" />
                <span className="text-sm font-semibold text-accent">
                  Grill Mode Activated
                </span>
                <Flame size={16} className="text-accent shrink-0" />
              </div>
            )}

            {/* 💡 Idea to Refine subtitle */}
            {ideaToRefineMatch && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-warning-muted rounded-lg border border-warning/20">
                <Lightbulb size={14} className="text-warning shrink-0" />
                <span className="text-sm font-medium text-warning">
                  Idea to Refine:{' '}
                  <span className="text-text-body">{ideaToRefineMatch[1]}</span>
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
                  remarkPlugins={REMARK_PLUGINS}
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

        <span className="text-xs text-text-secondary mt-1 px-1">
          {formatTime(message.createdAt)}
          {isStreaming && ' · Streaming...'}
        </span>
      </div>
    </div>
  )
}

const MessageBubble = React.memo(MessageBubbleInner)
export default MessageBubble

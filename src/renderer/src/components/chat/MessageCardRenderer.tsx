import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { PluggableList } from 'unified'
import type { Components } from 'react-markdown'
import BuildSummaryCard from './BuildSummaryCard'
import TaskPlanCard from './TaskPlanCard'
import type { MessageContentData } from './useMessageContent'

/**
 * Strips trailing "recap" narration that some models still append after the
 * emit_plan tool call — e.g. "I've generated the plan above", "Here's the
 * breakdown", "Click Build Now to proceed". The card already conveys all of
 * this, so such narration is pure noise stacked under the deliverable.
 *
 * Operates at SENTENCE granularity so a multi-sentence recap is fully removed,
 * while genuinely new content (a real caveat or follow-up — which does NOT match
 * these self-referential patterns) is preserved. Only ever applied to `afterPlan`.
 */
const SELF_REFERENTIAL_PATTERNS: RegExp[] = [
  // "I've generated / created / emitted / drafted ... (the) plan"
  /\b(?:i(?:'ve| have)?|here(?:'s| is)|let me)\b[^.!?\n]*\b(?:emitted|created|generated|produced|drafted|prepared|put together|outlined|assembled|laid out)\b[^.!?\n]*\bplan\b/i,
  // "Here's what it does / the breakdown / a summary / an overview / the approach"
  /\bhere(?:'s| is)\b[^.!?\n]*\b(?:what it does|the breakdown|a summary|an overview|the plan|the approach)\b/i,
  // "The/This plan above/below ..." or "... above/below ... the/this plan"
  /\b(?:the|this)\s+plan\b[^.!?\n]*\b(?:above|below)\b/i,
  /\b(?:above|below)\b[^.!?\n]*\b(?:the|this)\s+plan\b/i,
  // "as shown/outlined/detailed above|below", "summarised above"
  /\b(?:as\s+(?:shown|outlined|detailed|described|summari[sz]ed)|outlined|detailed|summari[sz]ed)\s+(?:above|below)\b/i,
  // Call-to-action that just restates the card's Build Now / Refine buttons
  /\b(?:click|hit|press|use|tap)\b[^.!?\n]*\b(?:build now|refine)\b/i,
  /\blet me know\b[^.!?\n]*\b(?:adjust|refine|change|proceed|tweak|build|review)\b/i
]

function isSelfReferentialRecap(sentence: string): boolean {
  const trimmed = sentence.trim()
  if (!trimmed) return true
  return SELF_REFERENTIAL_PATTERNS.some((re) => re.test(trimmed))
}

function stripPlanBoilerplate(text: string): string {
  if (!text?.trim()) return ''
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return ''
      // Drop only the recap sentences within the line; keep genuine content.
      return line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !isSelfReferentialRecap(sentence))
        .join(' ')
        .trim()
    })
    .filter((line) => line.length > 0)
    .join('\n')
    .trim()
}

/** Renders a markdown section wrapped in the standard AI bubble class */
function MarkdownSection({
  text,
  className,
  remarkPlugins,
  rehypePlugins,
  components
}: {
  text: string
  className: string
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
  components: Components
}): React.JSX.Element | null {
  if (!text?.trim()) return null
  return (
    <div className={className}>
      <div className="prose max-w-none">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  )
}

/** Props for the conditional card rendering extracted from MessageBubbleInner */
export interface MessageCardRendererProps {
  content: MessageContentData
  aiBubbleClass: string
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
  markdownComponents: Components
  // Plan action handlers
  onBuildNow: () => void
  onRefine: () => void
  onSaveAsIdea?: () => void
  onCouncilReview?: () => void
  planActionTaken?: string
  /** Conversation ID for live phase status badges */
  conversationId?: string
}

/**
 * Renders the appropriate structured card based on detected message blocks.
 * Returns null when no structured block is detected (caller renders default bubble).
 *
 * Extracted from MessageBubbleInner to reduce component complexity.
 */
export default function MessageCardRenderer({
  content,
  aiBubbleClass,
  remarkPlugins,
  rehypePlugins,
  markdownComponents,
  onBuildNow,
  onRefine,
  onSaveAsIdea,
  onCouncilReview,
  planActionTaken,
  conversationId
}: MessageCardRendererProps): React.JSX.Element | null {
  const {
    planContent,
    buildSummaryData,
    beforeBuildSummary,
    afterBuildSummary,
    beforePlan,
    afterPlan
  } = content

  // ── Build summary block ──
  if (buildSummaryData) {
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={beforeBuildSummary ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
        <BuildSummaryCard summary={buildSummaryData} />
        <MarkdownSection
          text={afterBuildSummary ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
      </div>
    )
  }

  // ── Plan block ──
  if (planContent) {
    // The plan card is the deliverable and must ALWAYS render last, regardless of
    // model behavior. Any narration the model produces — whether it streamed before
    // OR after the emit_plan tool call — is rendered as context ABOVE the card so a
    // misbehaving turn can never bury the card. We also strip a boilerplate trailing
    // line (e.g. "I've emitted the plan as an actionable card") since the card itself
    // makes such narration redundant; the prompt rules should already prevent it.
    const narration = [beforePlan ?? '', stripPlanBoilerplate(afterPlan ?? '')]
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n\n')
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={narration}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
        <TaskPlanCard
          summary={(() => {
            try {
              const parsed = planContent ? JSON.parse(planContent) : null
              return parsed?.title ?? 'Implementation Plan'
            } catch {
              return 'Implementation Plan'
            }
          })()}
          mode="plan"
          planContent={planContent}
          onBuildNow={onBuildNow}
          onSaveAsIdea={onSaveAsIdea}
          onRefine={onRefine}
          onCouncilReview={onCouncilReview}
          planActionTaken={planActionTaken}
          conversationId={conversationId}
        />
      </div>
    )
  }

  // No structured block detected — caller should render default bubble
  return null
}

import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { PluggableList } from 'unified'
import type { Components } from 'react-markdown'
import BuildSummaryCard from './BuildSummaryCard'
import TaskPlanCard from './TaskPlanCard'
import type { MessageContentData } from './useMessageContent'

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
  onCouncilReview
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
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={beforePlan ?? ''}
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
        />
        <MarkdownSection
          text={afterPlan ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
      </div>
    )
  }

  // No structured block detected — caller should render default bubble
  return null
}

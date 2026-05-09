import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { PluggableList } from 'unified'
import type { Components } from 'react-markdown'
import type { GrillAnswerPayload } from '../../../../shared/types'
import GrillQuestionCard from './GrillQuestionCard'
import GrillResultCard from './GrillResultCard'
import GrillEvaluationCard from './GrillEvaluationCard'
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
  suppressInlineGrillCard?: boolean
  // Plan action handlers
  onBuildNow: () => void
  onRefine: () => void
  onSaveAsIdea?: () => void
  // Grill action handlers
  onGrillKeepIterating: () => void
  onGrillCreatePlan: () => void
  onGrillCreateItems: () => void
  submitGrillAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllGrillQuestions: () => void
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
  suppressInlineGrillCard,
  onBuildNow,
  onRefine,
  onSaveAsIdea,
  onGrillKeepIterating,
  onGrillCreatePlan,
  onGrillCreateItems,
  submitGrillAnswers,
  skipAllGrillQuestions
}: MessageCardRendererProps): React.JSX.Element | null {
  const {
    planContent,
    grillSummary,
    grillProposedTasks,
    beforeGrill,
    afterGrill,
    grillQuestionMatch,
    grillQuestions,
    beforeGrillQuestion,
    afterGrillQuestion,
    grillEvalData,
    beforeGrillEval,
    afterGrillEval,
    buildSummaryData,
    beforeBuildSummary,
    afterBuildSummary,
    beforePlan,
    afterPlan
  } = content

  // ── Grill question block ──
  if (grillQuestions.length > 0) {
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={beforeGrillQuestion ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
        <GrillQuestionCard
          questions={grillQuestions}
          onSubmit={submitGrillAnswers}
          onSkipAll={skipAllGrillQuestions}
        />
        <MarkdownSection
          text={afterGrillQuestion ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
      </div>
    )
  }

  // ── Grill question suppressed (store-driven card active) ──
  if (grillQuestionMatch && suppressInlineGrillCard) {
    return (
      <div className={aiBubbleClass}>
        <div className="prose max-w-none">
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={markdownComponents}
          >
            {[beforeGrillQuestion?.trim(), afterGrillQuestion?.trim()].filter(Boolean).join('\n\n')}
          </ReactMarkdown>
        </div>
      </div>
    )
  }

  // ── Grill summary block ──
  if (grillSummary) {
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={beforeGrill ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
        <GrillResultCard
          summary={grillSummary}
          proposedTasks={grillProposedTasks}
          onKeepIterating={onGrillKeepIterating}
          onCreatePlan={onGrillCreatePlan}
          onCreateItems={onGrillCreateItems}
        />
        <MarkdownSection
          text={afterGrill ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
      </div>
    )
  }

  // ── Grill evaluation block ──
  if (grillEvalData) {
    return (
      <div className="space-y-3 max-w-full">
        <MarkdownSection
          text={beforeGrillEval ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
        <GrillEvaluationCard
          score={grillEvalData.score}
          scoreLabel={grillEvalData.scoreLabel}
          feedback={grillEvalData.feedback}
          questions={grillEvalData.questions}
        />
        <MarkdownSection
          text={afterGrillEval ?? ''}
          className={aiBubbleClass}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
        />
      </div>
    )
  }

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

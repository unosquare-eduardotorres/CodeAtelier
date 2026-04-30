/**
 * GrillChatView — scrollable chat-like container for grill sessions.
 *
 * Renders message history (past agent analyses, evaluations, user answers)
 * plus live streaming from the chat store during the evaluating phase.
 * Questions render inline as interactive cards — no freeform text input.
 */

import { useEffect, useRef, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import type { GrillStreamSegment } from '@renderer/store/grill-stream.store'
import { Avatar } from '@renderer/components/common'
import { QuestionItem } from '@renderer/components/chat'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillQuestion, ToolActivity } from '../../../../shared/types'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
import GrillMessageBubble from './GrillMessageBubble'
import GrillEvaluationBubble from './GrillEvaluationBubble'

// ── Message types for grill chat history ────────────────────────────────────

export type GrillChatMessage =
  | { type: 'agent'; content: string; toolActivities: ToolActivity[] }
  | {
      type: 'evaluation'
      score: number
      scoreLabel: string
      feedback: string
      trackName?: string
    }
  | { type: 'user'; content: string }
  | { type: 'system'; content: string }
  | { type: 'questions'; questions: GrillQuestion[]; questionStates: Record<string, QuestionState> }

// ── Default question state ──────────────────────────────────────────────────

const DEFAULT_QUESTION_STATE: QuestionState = {
  selectedOptions: [],
  otherText: '',
  otherSelected: false,
  skipped: false
}

// ── Props ───────────────────────────────────────────────────────────────────

export type GrillPhase = 'selecting' | 'evaluating' | 'answering' | 'paused'

interface GrillChatViewProps {
  messages: GrillChatMessage[]
  phase: GrillPhase
  description: string
  ideaTitle: string
  // Question interaction
  currentQuestions: GrillQuestion[] | null
  questionStates: Record<string, QuestionState>
  onQuestionChange: (id: string, state: QuestionState) => void
}

export default function GrillChatView({
  messages,
  phase,
  description,
  ideaTitle,
  currentQuestions,
  questionStates,
  onQuestionChange
}: GrillChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Read live streaming state from the dedicated grill stream store (segment-based)
  const segments = useGrillStreamStore((s) => s.segments)
  const currentContent = useGrillStreamStore((s) => s.currentContent)
  const currentToolActivities = useGrillStreamStore((s) => s.currentToolActivities)
  const isStreaming = useGrillStreamStore((s) => s.isStreaming)

  // Build cleaned segments for rendering — strip grill-evaluation JSON from each
  const cleanSegments = useMemo(() => {
    const result: GrillStreamSegment[] = []

    // Finalized segments
    for (const seg of segments) {
      const cleaned = stripGrillEvaluationBlocks(seg.content)
      if (cleaned || seg.toolActivities.length > 0) {
        result.push({ content: cleaned, toolActivities: seg.toolActivities })
      }
    }

    // Current (in-progress) segment
    const cleanedCurrent = currentContent ? stripGrillEvaluationBlocks(currentContent) : ''
    if (cleanedCurrent || currentToolActivities.length > 0) {
      result.push({ content: cleanedCurrent, toolActivities: currentToolActivities })
    }

    return result
  }, [segments, currentContent, currentToolActivities])

  const hasStreamingContent = cleanSegments.length > 0

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [currentContent, currentToolActivities.length, segments.length, messages.length, phase])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Requirement description — pinned at top as context */}
        <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
          <div className="px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
            <span className="text-sm font-semibold text-text-primary">{ideaTitle}</span>
          </div>
          <div className="px-4 py-3">
            <p className="text-sm text-text-body whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
              {description || 'No description provided.'}
            </p>
          </div>
        </div>

        {/* Render message history */}
        {messages.map((msg, i) => {
          switch (msg.type) {
            case 'agent':
              return (
                <GrillMessageBubble
                  key={`msg-${i}`}
                  content={msg.content}
                  toolActivities={msg.toolActivities}
                  isStreaming={false}
                />
              )
            case 'evaluation':
              return (
                <GrillEvaluationBubble
                  key={`msg-${i}`}
                  score={msg.score}
                  scoreLabel={msg.scoreLabel}
                  feedback={msg.feedback}
                  trackName={msg.trackName}
                />
              )
            case 'user':
              return (
                <div key={`msg-${i}`} className="flex gap-3 justify-end">
                  <div className="rounded-md px-4 py-3 bg-primary/10 text-text-body text-sm max-w-[75%] whitespace-pre-wrap leading-relaxed">
                    {msg.content}
                  </div>
                  <div className="flex-shrink-0 mt-0.5">
                    <Avatar avatarKey="user" size="md" />
                  </div>
                </div>
              )
            case 'questions':
              return (
                <div key={`msg-${i}`} className="ml-11 space-y-3 opacity-75 pointer-events-none">
                  <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Questions ({msg.questions.length})
                  </span>
                  {msg.questions.map((question, idx) => (
                    <QuestionItem
                      key={question.id}
                      question={question}
                      questionIndex={idx}
                      totalQuestions={msg.questions.length}
                      state={msg.questionStates[question.id] ?? DEFAULT_QUESTION_STATE}
                      onChange={() => {}} // read-only — no-op
                    />
                  ))}
                </div>
              )
            case 'system':
              return (
                <div
                  key={`msg-${i}`}
                  className="text-center text-xs text-text-muted py-2 select-none"
                >
                  {msg.content}
                </div>
              )
          }
        })}

        {/* Live streaming section — renders each segment as its own bubble */}
        {phase === 'evaluating' &&
          (hasStreamingContent ? (
            <>
              {cleanSegments.map((seg, idx) => (
                <GrillMessageBubble
                  key={`stream-seg-${idx}`}
                  content={seg.content}
                  toolActivities={seg.toolActivities}
                  isStreaming={isStreaming && idx === cleanSegments.length - 1}
                />
              ))}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-text-muted ml-11">
              <Loader2 size={14} className="animate-spin text-accent" />
              Analyzing your requirement…
            </div>
          ))}

        {/* Question cards — interactive, inline in chat flow */}
        {phase === 'answering' && currentQuestions && currentQuestions.length > 0 && (
          <div className="ml-11 space-y-3">
            <span className="text-xs font-semibold text-accent uppercase tracking-wider">
              Questions ({currentQuestions.length})
            </span>
            {currentQuestions.map((question, idx) => (
              <QuestionItem
                key={question.id}
                question={question}
                questionIndex={idx}
                totalQuestions={currentQuestions.length}
                state={questionStates[question.id] ?? DEFAULT_QUESTION_STATE}
                onChange={(state) => onQuestionChange(question.id, state)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

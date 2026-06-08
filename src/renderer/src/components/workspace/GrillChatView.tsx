/**
 * GrillChatView — scrollable chat-like container for grill sessions.
 *
 * Thin wrapper over the shared <StreamingTranscript> primitive: it supplies the
 * grill persona, the requirement header, the message-history renderer, the
 * grill-evaluation JSON transform, and the interactive question cards. All
 * streaming/render/auto-scroll behavior is shared with chat, so grill renders
 * with the same cadence and look.
 */

import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import { Avatar } from '@renderer/components/common'
import { MessageBubble, QuestionItem } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import type { QuestionState } from '@renderer/components/chat'
import { StreamingTranscript } from '@renderer/components/streaming'
import type { GrillQuestion, ToolActivity } from '../../../../shared/types'
import { grillAgentToMessage } from '@renderer/utils/grillMessageAdapter'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
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

// ── Grill agent identity (passed to MessageBubble as override) ──────────────

const GRILL_IDENTITY: MessageIdentity = {
  displayName: 'Grill Analyst',
  subtitle: null,
  avatarKey: 'grillme',
  accentColor: 'var(--color-accent, #D4A574)'
}

// ── Props ───────────────────────────────────────────────────────────────────

export type GrillPhase =
  | 'selecting'
  | 'evaluating'
  | 'answering'
  | 'paused'
  | 'completing'
  | 'completed'

interface GrillChatViewProps {
  messages: GrillChatMessage[]
  phase: GrillPhase
  description: string
  ideaTitle: string
  // Question interaction
  currentQuestions: GrillQuestion[] | null
  questionStates: Record<string, QuestionState>
  onQuestionChange: (id: string, state: QuestionState) => void
  /** Current grilling round (1-based). Surfaced above the question cards. */
  round?: number
}

// ── Message-history renderer ────────────────────────────────────────────────

function renderGrillMessage(msg: GrillChatMessage, i: number): React.ReactNode {
  switch (msg.type) {
    case 'agent':
      return (
        <MessageBubble
          key={`msg-${i}`}
          message={grillAgentToMessage(msg.content, msg.toolActivities, i)}
          identityOverride={GRILL_IDENTITY}
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
        <div key={`msg-${i}`} className="text-center text-xs text-text-muted py-2 select-none">
          {msg.content}
        </div>
      )
  }
}

export default function GrillChatView({
  messages,
  phase,
  description,
  ideaTitle,
  currentQuestions,
  questionStates,
  onQuestionChange,
  round
}: GrillChatViewProps): React.JSX.Element {
  // Read live streaming state for progressive rendering during evaluation.
  const segments = useGrillStreamStore((s) => s.segments)
  const currentContent = useGrillStreamStore((s) => s.currentContent)
  const currentToolActivities = useGrillStreamStore((s) => s.currentToolActivities)

  const header = (
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
  )

  const footer =
    phase === 'answering' && currentQuestions && currentQuestions.length > 0 ? (
      <div className="ml-11 space-y-3">
        <span className="text-xs font-semibold text-accent uppercase tracking-wider">
          {round ? `Round ${round} · ` : ''}Questions ({currentQuestions.length})
        </span>
        <p className="text-xs text-text-muted">
          Pick the options that fit, then “Accept &amp; Re-evaluate” to lock these decisions in and
          start the next round.
        </p>
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
    ) : null

  return (
    <StreamingTranscript
      messages={messages}
      renderMessage={renderGrillMessage}
      segments={segments}
      currentContent={currentContent}
      currentToolActivities={currentToolActivities}
      isStreaming={phase === 'evaluating'}
      identity={GRILL_IDENTITY}
      thinkingLabel="Analyzing your requirement…"
      transformContent={stripGrillEvaluationBlocks}
      header={header}
      footer={footer}
      scrollDeps={[phase]}
    />
  )
}

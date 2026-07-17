/**
 * BlueprintChatView — unified scrollable chat transcript for ALL blueprint phases.
 *
 * Renders the full pipeline audit trail: agent bubbles, user answers, system markers,
 * findings tables, Q&A records, plan/tasks cards — all in one continuous transcript.
 *
 * Footer slot holds the interactive UI: question form, gate card, fallback textarea,
 * or wave progress — depending on phase state.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, SkipForward, MessageSquare, CheckCircle2 } from 'lucide-react'
import { useBlueprintStreamStore } from '@renderer/store/blueprint-stream.store'
import { Avatar } from '@renderer/components/common'
import { useChatAvatarSize } from '@renderer/hooks/useChatAvatarSize'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import { QuestionItem } from '@renderer/components/chat/GrillQuestionCard'
import type { QuestionState } from '@renderer/components/chat/GrillQuestionCard'
import { StreamingTranscript } from '@renderer/components/streaming'
import { blueprintAgentToMessage } from '@renderer/utils/blueprintMessageAdapter'
import {
  stripBlueprintBlocks,
  clarifyQuestionToGrillQuestion,
  formatClarifyAnswerMessage
} from '../../../../../shared/blueprint-clarify-parsers'
import type {
  ClarifyQuestion,
  QuestionAnswerState
} from '../../../../../shared/blueprint-clarify-parsers'
import type { BlueprintChatMessage } from '@renderer/store/blueprint.store'
import { BlueprintFindingsCard } from './BlueprintFindingsCard'
import { BlueprintPlanCard, BlueprintTasksCard } from './BlueprintPlanCard'

// ── Blueprint agent identity (passed to MessageBubble as override) ──────────

const BLUEPRINT_IDENTITY: MessageIdentity = {
  displayName: 'Blueprint Architect',
  subtitle: null,
  avatarKey: 'da-vinci',
  accentColor: 'var(--color-accent)'
}

// ── Props ───────────────────────────────────────────────────────────────────

interface BlueprintChatViewProps {
  messages: BlueprintChatMessage[]
  isStreaming: boolean
  /** Optional slot rendered below the live region (interactive footer). */
  footer?: React.ReactNode
}

// ── Q&A Read-Only Record ────────────────────────────────────────────────────

function BlueprintQARecord({
  questions,
  answers
}: {
  questions: ClarifyQuestion[]
  answers: Record<string, QuestionAnswerState>
}): React.JSX.Element {
  return (
    <div data-testid="blueprint-qa-record" className="bg-surface-raised rounded-xl border border-border/50 overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <CheckCircle2 size={12} className="text-success" />
        <h3 className="text-xs font-semibold text-text-primary">Answers submitted</h3>
      </div>
      <div className="px-4 py-3 space-y-2">
        {questions.map((q) => {
          const state = answers[q.id]
          const isSkipped = !state || state.skipped
          const parts: string[] = state ? [...state.selectedOptions] : []
          if (state?.otherSelected && state.otherText.trim()) {
            parts.push(state.otherText.trim())
          }
          return (
            <div key={q.id} className="space-y-0.5">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">
                {q.header}
              </span>
              <p className="text-xs text-text-primary">
                {isSkipped ? (
                  <span className="italic text-text-muted">Skipped</span>
                ) : parts.length > 0 ? (
                  parts.join(', ')
                ) : (
                  <span className="italic text-text-muted">No selection</span>
                )}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Blueprint Question Footer (replaces chip UI with QuestionItem) ──────────

interface BlueprintQuestionFooterProps {
  questions: ClarifyQuestion[]
  onSubmit: (formattedAnswer: string, answers?: Record<string, QuestionAnswerState>) => void | Promise<void>
  onSkip: () => void
}

function BlueprintQuestionFooter({
  questions,
  onSubmit,
  onSkip
}: BlueprintQuestionFooterProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [freeTextMode, setFreeTextMode] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Convert ClarifyQuestions to GrillQuestions for QuestionItem rendering
  const grillQuestions = questions.map(clarifyQuestionToGrillQuestion)

  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>(() => {
    const initial: Record<string, QuestionState> = {}
    for (const q of questions) {
      const recommended = q.options.filter((o) => o.recommended).map((o) => o.label)
      initial[q.id] = {
        selectedOptions: recommended,
        otherText: '',
        otherSelected: false,
        skipped: false
      }
    }
    return initial
  })

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleSubmit = useCallback(() => {
    if (submitting) return
    setSubmitting(true)

    let result: void | Promise<void>
    if (freeTextMode) {
      result = onSubmit(freeText.trim())
    } else {
      // Convert QuestionState to QuestionAnswerState and format
      const answerStates: Record<string, QuestionAnswerState> = {}
      for (const q of questions) {
        const qs = questionStates[q.id]
        if (qs) {
          answerStates[q.id] = {
            selectedOptions: qs.selectedOptions,
            otherText: qs.otherText,
            otherSelected: qs.otherSelected,
            skipped: qs.skipped
          }
        }
      }
      result = onSubmit(formatClarifyAnswerMessage(questions, answerStates), answerStates)
    }
    // Un-stick: reset submitting whether onSubmit succeeds or fails
    Promise.resolve(result).finally(() => setSubmitting(false))
  }, [submitting, freeTextMode, freeText, questions, questionStates, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  if (freeTextMode) {
    return (
      <div ref={cardRef} data-testid="blueprint-question-footer" className="bg-surface-raised rounded-xl border border-info/30 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare size={12} className="text-info" />
            <span className="text-xs font-medium text-info">Free-text answer</span>
          </div>
          <button
            onClick={() => setFreeTextMode(false)}
            className="text-[10px] text-text-muted hover:text-text-secondary"
          >
            Back to options
          </button>
        </div>
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your answers to the questions above..."
          rows={4}
          autoFocus
          className="w-full bg-surface-inset border border-border/50 rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:ring-1 focus:ring-info/50"
        />
        <div className="flex items-center justify-between">
          <button
            onClick={onSkip}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-secondary"
          >
            <SkipForward size={10} />
            Skip clarification
          </button>
          <button
            onClick={handleSubmit}
            disabled={!freeText.trim() || submitting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-info/20 text-info hover:bg-info/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={10} />
            Send
          </button>
        </div>
        <p className="text-[9px] text-text-muted">⌘+Enter to send</p>
      </div>
    )
  }

  return (
    <div ref={cardRef} data-testid="blueprint-question-footer" className="bg-surface-raised rounded-xl border border-info/30 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-info animate-pulse" />
          <span className="text-xs font-medium text-info">
            Questions — {questions.length} decision{questions.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={() => setFreeTextMode(true)}
          className="text-[10px] text-text-muted hover:text-text-secondary"
        >
          Answer in free text instead
        </button>
      </div>

      {/* Question Items (Grill pattern with radio/checkbox/recommended/other/skip) */}
      <div className="space-y-3">
        {grillQuestions.map((gq, idx) => (
          <QuestionItem
            key={gq.id}
            question={gq}
            questionIndex={idx}
            totalQuestions={grillQuestions.length}
            state={
              questionStates[gq.id] ?? {
                selectedOptions: [],
                otherText: '',
                otherSelected: false,
                skipped: false
              }
            }
            onChange={(state) =>
              setQuestionStates((prev) => ({ ...prev, [gq.id]: state }))
            }
          />
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onSkip}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-secondary"
        >
          <SkipForward size={10} />
          Skip clarification
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-info/20 text-info hover:bg-info/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send size={12} />
          Submit Answers
        </button>
      </div>
      <p className="text-[9px] text-text-muted">⌘+Enter to submit</p>
    </div>
  )
}

// ── Message-history renderer ────────────────────────────────────────────────

function renderBlueprintMessage(msg: BlueprintChatMessage, i: number, avatarSize: 'md' | 'lg' | 'xl'): React.ReactNode {
  switch (msg.type) {
    case 'agent':
      return (
        <MessageBubble
          key={`msg-${i}`}
          message={blueprintAgentToMessage(msg.content, msg.toolActivities, i, msg.timestamp)}
          toolActivities={msg.toolActivities}
          identityOverride={BLUEPRINT_IDENTITY}
        />
      )
    case 'user':
      return (
        <div key={`msg-${i}`} className="flex gap-3 justify-end">
          <div className="rounded-md px-4 py-3 bg-primary/10 text-text-body text-sm max-w-[75%] whitespace-pre-wrap leading-relaxed">
            {msg.content}
          </div>
          <div className="flex-shrink-0 mt-0.5">
            <Avatar avatarKey="user" size={avatarSize} />
          </div>
        </div>
      )
    case 'system':
      return (
        <div key={`msg-${i}`} className="text-center text-xs text-text-muted py-2 select-none">
          {msg.content}
        </div>
      )
    case 'findings':
      return (
        <div key={`msg-${i}`} className="max-w-full">
          <BlueprintFindingsCard findings={msg.findings} />
        </div>
      )
    case 'qa':
      return (
        <div key={`msg-${i}`} className="max-w-full">
          <BlueprintQARecord questions={msg.questions} answers={msg.answers} />
        </div>
      )
    case 'plan':
      return (
        <div key={`msg-${i}`} className="max-w-full">
          <BlueprintPlanCard plan={msg.plan} />
        </div>
      )
    case 'tasks':
      return (
        <div key={`msg-${i}`} className="max-w-full">
          <BlueprintTasksCard tasks={msg.tasks} />
        </div>
      )
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function BlueprintChatView({
  messages,
  isStreaming,
  footer
}: BlueprintChatViewProps): React.JSX.Element {
  const avatarSize = useChatAvatarSize()

  // Read live streaming state for progressive rendering.
  const segments = useBlueprintStreamStore((s) => s.segments)
  const currentContent = useBlueprintStreamStore((s) => s.currentContent)
  const currentToolActivities = useBlueprintStreamStore((s) => s.currentToolActivities)

  return (
    <div data-testid="blueprint-chat-view" className="flex flex-col h-full min-h-0">
      <StreamingTranscript
        messages={messages}
        renderMessage={(msg, i) => renderBlueprintMessage(msg, i, avatarSize)}
        segments={segments}
        currentContent={currentContent}
        currentToolActivities={currentToolActivities}
        isStreaming={isStreaming}
        suppressLiveBubble
        identity={BLUEPRINT_IDENTITY}
        thinkingLabel="Analyzing…"
        transformContent={stripBlueprintBlocks}
        footer={footer}
        scrollDeps={[isStreaming, messages.length]}
        innerClassName="max-w-7xl w-full mx-auto space-y-4"
      />
    </div>
  )
}

// ── Re-exports for BlueprintPage ──
export { BlueprintQuestionFooter }
export type { BlueprintChatViewProps }

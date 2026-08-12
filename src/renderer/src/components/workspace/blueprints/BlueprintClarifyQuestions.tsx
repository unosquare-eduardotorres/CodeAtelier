/**
 * BlueprintClarifyQuestions — renders question cards with recommended options pre-selected.
 * User selects options and submits batch answers.
 */

import { useState, useCallback, type JSX } from 'react'
import { Send, MessageSquare } from 'lucide-react'
import type {
  ClarifyQuestion,
  ClarifyQuestionsBlock
} from '../../../../../shared/blueprint-clarify-parsers'

interface BlueprintClarifyQuestionsProps {
  questions: ClarifyQuestionsBlock
  onSubmit: (formattedAnswer: string) => void | Promise<void>
  onSkip: () => void
}

export function BlueprintClarifyQuestions({
  questions,
  onSubmit,
  onSkip
}: BlueprintClarifyQuestionsProps): JSX.Element {
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    // Pre-select recommended options
    const initial: Record<string, string[]> = {}
    for (const q of questions.questions) {
      const recommended = q.options.filter((o) => o.recommended).map((o) => o.label)
      initial[q.id] = recommended
    }
    return initial
  })
  const [freeTextMode, setFreeTextMode] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleToggleOption = useCallback(
    (questionId: string, label: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const current = prev[questionId] ?? []
        if (multiSelect) {
          // Toggle in multi-select mode
          return {
            ...prev,
            [questionId]: current.includes(label)
              ? current.filter((l) => l !== label)
              : [...current, label]
          }
        } else {
          // Single select — replace
          return { ...prev, [questionId]: [label] }
        }
      })
    },
    []
  )

  const handleSubmit = useCallback(() => {
    if (submitting) return
    setSubmitting(true)

    let result: void | Promise<void>
    if (freeTextMode) {
      result = onSubmit(freeText.trim())
    } else {
      // Format structured answer from selections
      const lines: string[] = []
      for (const q of questions.questions) {
        const selected = selections[q.id] ?? []
        if (selected.length > 0) {
          lines.push(`**${q.header}**: ${selected.join(', ')}`)
        } else {
          lines.push(`**${q.header}**: (skipped)`)
        }
      }
      result = onSubmit(lines.join('\n'))
    }
    // Un-stick: reset submitting whether onSubmit succeeds or fails
    Promise.resolve(result).finally(() => setSubmitting(false))
  }, [submitting, freeTextMode, freeText, questions.questions, selections, onSubmit])

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
      <div className="bg-surface-raised rounded-xl border border-info/30 p-4 space-y-3">
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
            className="text-[10px] text-text-muted hover:text-text-secondary"
          >
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
    <div className="bg-surface-raised rounded-xl border border-info/30 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-info animate-pulse" />
          <span className="text-xs font-medium text-info">Questions</span>
        </div>
        <button
          onClick={() => setFreeTextMode(true)}
          className="text-[10px] text-text-muted hover:text-text-secondary"
        >
          Answer in free text instead
        </button>
      </div>

      {/* Question Cards */}
      <div className="space-y-3">
        {questions.questions.map((q) => (
          <QuestionCard
            key={q.id}
            question={q}
            selectedOptions={selections[q.id] ?? []}
            onToggle={(label) => handleToggleOption(q.id, label, q.multiSelect)}
          />
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onSkip} className="text-[10px] text-text-muted hover:text-text-secondary">
          Skip clarification
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-info/20 text-info hover:bg-info/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send size={10} />
          Submit Answers
        </button>
      </div>
      <p className="text-[9px] text-text-muted">⌘+Enter to submit</p>
    </div>
  )
}

// ── Question Card ──

function QuestionCard({
  question,
  selectedOptions,
  onToggle
}: {
  question: ClarifyQuestion
  selectedOptions: string[]
  onToggle: (label: string) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div>
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">
          {question.header}
        </span>
        <p className="text-xs text-text-primary mt-0.5">{question.question}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((opt) => {
          const isSelected = selectedOptions.includes(opt.label)
          return (
            <button
              key={opt.label}
              onClick={() => onToggle(opt.label)}
              className={`group relative px-2.5 py-1 text-[11px] rounded-lg border transition-all ${
                isSelected
                  ? 'bg-info/20 border-info/40 text-info'
                  : 'bg-surface-inset border-border/50 text-text-secondary hover:border-info/30 hover:text-text-primary'
              }`}
            >
              {opt.label}
              {opt.recommended && <span className="ml-1 text-[9px] text-green-400">★</span>}
              {opt.recommended && opt.recommendedReason && (
                <span className="absolute bottom-full left-0 mb-1 hidden group-hover:block bg-surface-overlay border border-border/50 rounded px-2 py-1 text-[9px] text-text-muted whitespace-nowrap z-10">
                  {opt.recommendedReason}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

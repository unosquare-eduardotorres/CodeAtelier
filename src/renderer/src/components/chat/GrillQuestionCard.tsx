import { useState, useCallback, useRef, useEffect } from 'react'
import { HelpCircle, SkipForward, Send, Star } from 'lucide-react'
import type { GrillQuestion, GrillAnswerPayload } from '../../../../shared/types'

interface GrillQuestionCardProps {
  questions: GrillQuestion[]
  onSubmit: (answers: GrillAnswerPayload[]) => void
  onSkipAll: () => void
}

export interface QuestionState {
  selectedOptions: string[]
  otherText: string
  otherSelected: boolean
  skipped: boolean
}

// ── Style helpers ──

function getOptionBg(isSelected: boolean, isRecommended: boolean): string {
  if (isSelected) return 'bg-primary/10'
  if (isRecommended) return 'bg-warning-muted/30 hover:bg-surface-hover'
  return 'hover:bg-surface-hover'
}

// ── Icons ──
export function RadioIcon({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <div
      className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
        selected ? 'border-primary bg-primary' : 'border-text-muted'
      }`}
    >
      {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
    </div>
  )
}

export function CheckboxIcon({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <div
      className={`mt-0.5 w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors ${
        selected ? 'border-primary bg-primary' : 'border-text-muted'
      }`}
    >
      {selected && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 5L4 7L8 3"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}

// ── Option row sub-component ──

function OptionRow({
  option,
  optionIndex,
  isSelected,
  multiSelect,
  onToggle,
  onKeyDown
}: {
  option: GrillQuestion['options'][number]
  optionIndex: number
  isSelected: boolean
  multiSelect: boolean
  onToggle: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}): React.JSX.Element {
  const isRecommended = !!option.recommended

  return (
    <button
      key={option.label}
      data-option-index={optionIndex}
      role={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={isSelected}
      tabIndex={optionIndex === 0 ? 0 : -1}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors duration-150 min-h-[44px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset ${getOptionBg(isSelected, isRecommended)}`}
    >
      {multiSelect ? (
        <CheckboxIcon selected={isSelected} />
      ) : (
        <RadioIcon selected={isSelected} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-text-primary font-medium">{option.label}</span>
          {isRecommended && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-muted text-warning border border-warning/20">
              <Star size={10} className="fill-warning" />
              Recommended
            </span>
          )}
        </div>
        {option.recommendedReason && (
          <p className="text-xs text-warning/80 mt-0.5 italic">
            {option.recommendedReason}
          </p>
        )}
        {option.description && (
          <p className="text-xs text-text-muted mt-0.5">{option.description}</p>
        )}
      </div>
    </button>
  )
}

// ── Other option row sub-component ──

function OtherOptionRow({
  state,
  question,
  optionIndex,
  onSelect,
  onChange,
  onKeyDown,
  otherInputRef
}: {
  state: QuestionState
  question: GrillQuestion
  optionIndex: number
  onSelect: () => void
  onChange: (state: QuestionState) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  otherInputRef: React.RefObject<HTMLTextAreaElement>
}): React.JSX.Element {
  return (
    <div
      data-option-index={optionIndex}
      className={`flex items-start gap-3 px-4 py-3 transition-colors duration-150 ${
        state.otherSelected ? 'bg-primary/10' : 'hover:bg-surface-hover'
      }`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="mt-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-full"
        onClick={onSelect}
        aria-label="Other option"
      >
        {question.multiSelect ? (
          <CheckboxIcon selected={state.otherSelected} />
        ) : (
          <RadioIcon selected={state.otherSelected} />
        )}
      </button>
      <div className="flex-1 cursor-pointer" onClick={onSelect}>
        <span className="text-sm text-text-muted">Other:</span>
        <textarea
          ref={otherInputRef}
          value={state.otherText}
          rows={1}
          onChange={(e) => {
            const newState = { ...state, otherText: e.target.value, otherSelected: true }
            if (!question.multiSelect) {
              newState.selectedOptions = []
            }
            onChange(newState)
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Type your answer..."
          className="mt-1 w-full resize-none overflow-y-auto max-h-60 bg-surface-overlay text-sm text-text-body placeholder-text-muted rounded-lg px-3 py-1.5 outline-none border border-border-subtle focus:border-primary transition-colors leading-relaxed"
        />
      </div>
    </div>
  )
}

// ── Individual question item ──
export function QuestionItem({
  question,
  questionIndex,
  totalQuestions,
  state,
  onChange
}: {
  question: GrillQuestion
  questionIndex: number
  totalQuestions: number
  state: QuestionState
  onChange: (state: QuestionState) => void
}): React.JSX.Element {
  const otherInputRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = useCallback(() => {
    const el = otherInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    autoResize()
  }, [state.otherText, autoResize])

  const handleOptionToggle = (label: string): void => {
    if (state.skipped) return

    if (question.multiSelect) {
      const newSelected = state.selectedOptions.includes(label)
        ? state.selectedOptions.filter((o) => o !== label)
        : [...state.selectedOptions, label]
      onChange({ ...state, selectedOptions: newSelected })
    } else {
      onChange({ ...state, selectedOptions: [label], otherText: '', otherSelected: false })
    }
  }

  const handleOtherSelect = (): void => {
    if (state.skipped) return
    if (question.multiSelect) {
      onChange({ ...state, otherSelected: !state.otherSelected })
    } else {
      onChange({ ...state, selectedOptions: [], otherSelected: true })
    }
    otherInputRef.current?.focus()
  }

  const handleSkip = (): void => {
    onChange({ selectedOptions: [], otherText: '', otherSelected: false, skipped: !state.skipped })
  }

  const handleKeyDown = (e: React.KeyboardEvent, optionIndex: number): void => {
    const optionCount = (question.options ?? []).length + (question.allowOther !== false ? 1 : 0)

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const nextIndex = (optionIndex + 1) % optionCount
      const container = (e.currentTarget as HTMLElement).closest('[role]')
      const buttons = container?.querySelectorAll<HTMLElement>('[data-option-index]')
      buttons?.[nextIndex]?.focus()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const prevIndex = (optionIndex - 1 + optionCount) % optionCount
      const container = (e.currentTarget as HTMLElement).closest('[role]')
      const buttons = container?.querySelectorAll<HTMLElement>('[data-option-index]')
      buttons?.[prevIndex]?.focus()
    }
  }

  return (
    <div
      className={`rounded-lg border overflow-hidden transition-all duration-200 ${
        state.skipped
          ? 'border-border-subtle bg-surface-base/50 opacity-60'
          : 'border-border-subtle bg-surface-base/30'
      }`}
    >
      {/* Question header with progress + skip button */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            {question.header && (
              <span
                className="text-xs font-semibold text-text-secondary uppercase tracking-wider"
                id={`question-header-${question.id}`}
              >
                {question.header}
              </span>
            )}
            <span className="text-xs text-text-muted">
              Question {questionIndex + 1} of {totalQuestions}
            </span>
          </div>
          <button
            onClick={handleSkip}
            className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
              state.skipped
                ? 'border-primary/30 text-primary bg-primary/10'
                : 'border-border-subtle text-text-muted hover:text-text-secondary hover:border-border-default'
            }`}
          >
            {state.skipped ? 'Unskip' : 'Skip'}
          </button>
        </div>
        <p className="text-sm text-text-primary font-medium">{question.question}</p>
      </div>

      {/* Options — table-style rows */}
      {!state.skipped && (
        <div
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-labelledby={question.header ? `question-header-${question.id}` : undefined}
          className="divide-y divide-border-subtle"
        >
          {(question.options ?? []).map((option, optIdx) => (
            <OptionRow
              key={option.label}
              option={option}
              optionIndex={optIdx}
              isSelected={state.selectedOptions.includes(option.label)}
              multiSelect={!!question.multiSelect}
              onToggle={() => handleOptionToggle(option.label)}
              onKeyDown={(e) => handleKeyDown(e, optIdx)}
            />
          ))}

          {/* Other option row */}
          {question.allowOther !== false && (
            <OtherOptionRow
              state={state}
              question={question}
              optionIndex={(question.options ?? []).length}
              onSelect={handleOtherSelect}
              onChange={onChange}
              onKeyDown={(e) => handleKeyDown(e, (question.options ?? []).length)}
              otherInputRef={otherInputRef}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Main card ──
export default function GrillQuestionCard({
  questions,
  onSubmit,
  onSkipAll
}: GrillQuestionCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)

  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>(() => {
    const initial: Record<string, QuestionState> = {}
    for (const q of questions) {
      // Pre-select recommended options
      const recommended = (q.options ?? []).filter((o) => o.recommended).map((o) => o.label)
      initial[q.id] = {
        selectedOptions: recommended,
        otherText: '',
        otherSelected: false,
        skipped: false
      }
    }
    return initial
  })

  // Auto-scroll into view when card appears
  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const updateQuestion = useCallback((questionId: string, state: QuestionState) => {
    setQuestionStates((prev) => ({ ...prev, [questionId]: state }))
  }, [])

  const canSubmit = questions.every((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    if (state.skipped) return true
    return (
      state.selectedOptions.length > 0 || state.otherSelected || state.otherText.trim().length > 0
    )
  })

  const answeredCount = questions.filter((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    return (
      state.skipped ||
      state.selectedOptions.length > 0 ||
      state.otherSelected ||
      state.otherText.trim().length > 0
    )
  }).length

  const handleSubmit = (): void => {
    const answers: GrillAnswerPayload[] = questions.map((q) => {
      const state = questionStates[q.id] ?? {
        selectedOptions: [],
        otherText: '',
        otherSelected: false,
        skipped: true
      }
      return {
        questionId: q.id,
        selectedOptions: state.selectedOptions,
        otherText: state.otherText.trim() || undefined,
        skipped: state.skipped
      }
    })
    onSubmit(answers)
  }

  return (
    <div
      ref={cardRef}
      data-testid="grill-question-card"
      className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden shadow-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <HelpCircle size={16} className="text-text-secondary" />
          <span className="text-sm font-semibold text-text-primary">
            Questions — {questions.length} decision{questions.length !== 1 ? 's' : ''} to make
          </span>
        </div>
        <span className="text-xs text-text-muted">
          {answeredCount}/{questions.length} answered
        </span>
      </div>

      {/* Questions */}
      <div className="px-4 py-4 space-y-3">
        {questions.map((question, idx) => (
          <QuestionItem
            key={question.id}
            question={question}
            questionIndex={idx}
            totalQuestions={questions.length}
            state={
              questionStates[question.id] ?? {
                selectedOptions: [],
                otherText: '',
                otherSelected: false,
                skipped: false
              }
            }
            onChange={(state) => updateQuestion(question.id, state)}
          />
        ))}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-border-subtle bg-surface-base/50">
        <button
          onClick={onSkipAll}
          className="flex items-center gap-1.5 px-4 py-2 text-text-muted hover:text-text-secondary rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-border-subtle focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <SkipForward size={14} />
          Skip All
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 px-5 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 press-scale"
        >
          <Send size={14} />
          Submit Answers
        </button>
      </div>
    </div>
  )
}

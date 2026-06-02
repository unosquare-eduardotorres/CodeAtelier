import { useState, useEffect, useCallback, type JSX } from 'react'
import { Target, Zap, AlertCircle } from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { GOAL_TYPE_LABELS, PHASE_CONFIG } from './constants'
import type { MpaClassifyResult, MpaGoalType, MpaPhaseType } from '../../../../../shared/mpa-types'

const EXAMPLES = [
  'Add REST API for blog posts with CRUD, pagination, and search',
  'Refactor payment module to repository pattern',
  'Fix upload failing for files > 5MB',
  'Add unit tests for all services in src/services'
]

interface GoalInputProps {
  onStart: (params: {
    goal: string
    title: string
    goalType: MpaGoalType
    phases: MpaPhaseType[]
  }) => void
  disabled?: boolean
}

export default function GoalInput({ onStart, disabled }: GoalInputProps): JSX.Element {
  const [goalText, setGoalText] = useState('')
  const [classification, setClassification] = useState<MpaClassifyResult | null>(null)
  const [classifying, setClassifying] = useState(false)
  const { preloadedGoal, setPreloadedGoal, classifyGoal } = useMpaStore()

  // Pre-fill from Grill
  useEffect(() => {
    if (preloadedGoal) {
      setGoalText(preloadedGoal.text)
      setPreloadedGoal(null)
    }
  }, [preloadedGoal, setPreloadedGoal])

  const handleClassify = useCallback(async () => {
    if (goalText.trim().length < 15) return
    setClassifying(true)
    try {
      const result = await classifyGoal(goalText.trim())
      setClassification(result)
    } catch {
      // ignore
    } finally {
      setClassifying(false)
    }
  }, [goalText, classifyGoal])

  // Auto-classify on blur or enter
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (classification?.isValid) {
        handleStart()
      } else {
        handleClassify()
      }
    }
  }

  const handleStart = (): void => {
    if (!classification?.isValid) return
    onStart({
      goal: goalText.trim(),
      title: goalText.trim().slice(0, 60),
      goalType: classification.goalType,
      phases: classification.phases as MpaPhaseType[]
    })
  }

  return (
    <div className="space-y-4">
      {/* Input */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          What do you want to achieve?
        </label>
        <textarea
          value={goalText}
          onChange={(e) => {
            setGoalText(e.target.value)
            setClassification(null)
          }}
          onBlur={handleClassify}
          onKeyDown={handleKeyDown}
          placeholder="Describe your goal with enough detail for an agent to plan and execute it..."
          rows={3}
          disabled={disabled}
          className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {/* Pre-flight result */}
      {classification && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            classification.isValid
              ? 'border-success/30 bg-success/5'
              : 'border-danger/30 bg-danger/5'
          }`}
        >
          {classification.isValid ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span>
                  {GOAL_TYPE_LABELS[classification.goalType].emoji}{' '}
                  {GOAL_TYPE_LABELS[classification.goalType].label}
                </span>
                <span className="text-text-muted">·</span>
                <span className="text-text-secondary">
                  {classification.phases
                    .map((p) => {
                      const pc = PHASE_CONFIG[p as MpaPhaseType]
                      return `${pc.emoji} ${pc.label}`
                    })
                    .join(' → ')}
                </span>
              </div>
              {classification.phases.includes('plan') && (
                <div className="text-xs text-text-muted">
                  Includes 👤 User Review gate between Plan and Execute phases
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="text-danger mt-0.5 shrink-0" />
              <div>
                <p className="text-danger">{classification.rejectionReason}</p>
                {classification.suggestedGoal && (
                  <button
                    type="button"
                    onClick={() => {
                      setGoalText(classification.suggestedGoal!)
                      setClassification(null)
                    }}
                    className="text-xs text-accent hover:underline mt-1"
                  >
                    Try: &quot;{classification.suggestedGoal}&quot;
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {classifying && (
            <span className="text-xs text-text-muted animate-pulse">Classifying...</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!classification && goalText.trim().length >= 15 && (
            <button
              type="button"
              onClick={handleClassify}
              disabled={disabled || classifying}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-lg transition-colors"
            >
              <Target size={14} />
              Classify
            </button>
          )}
          {classification?.isValid && (
            <button
              type="button"
              onClick={handleStart}
              disabled={disabled}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
            >
              <Zap size={14} />
              Start Goal
            </button>
          )}
        </div>
      </div>

      {/* Examples */}
      {!goalText && (
        <div className="space-y-1.5">
          <p className="text-xs text-text-muted">Examples:</p>
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              onClick={() => {
                setGoalText(ex)
                setClassification(null)
              }}
              className="block w-full text-left text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded px-2 py-1 transition-colors"
            >
              • &quot;{ex}&quot;
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

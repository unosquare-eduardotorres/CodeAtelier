/**
 * StartGoalModal — self-contained modal for creating a new goal.
 *
 * Incorporates the classify → start flow directly (not wrapping GoalInput)
 * so the modal controls layout, footer, and keyboard shortcuts properly.
 *
 * Layout:
 *   Header:  icon + "New Goal"
 *   Body:    textarea + example chips + pre-flight result
 *   Footer:  ⌘+Enter hint + Cancel + Classify/Start
 */

import { useState, useEffect, useCallback } from 'react'
import { Target, X, Zap, AlertCircle, Loader2 } from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { GOAL_TYPE_LABELS, PHASE_CONFIG } from './constants'
import type { MpaClassifyResult, MpaGoalType, MpaPhaseType } from '../../../../../shared/mpa-types'

const EXAMPLES = [
  'Add REST API for blog posts with CRUD, pagination, and search',
  'Refactor payment module to repository pattern',
  'Fix upload failing for files > 5MB',
  'Add unit tests for all services in src/services'
]

interface StartGoalModalProps {
  onStart: (params: {
    goal: string
    title: string
    goalType: MpaGoalType
    phases: MpaPhaseType[]
  }) => void
  disabled?: boolean
  onClose: () => void
}

export default function StartGoalModal({
  onStart,
  disabled,
  onClose
}: StartGoalModalProps): React.JSX.Element {
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

  const handleStart = useCallback(() => {
    if (!classification?.isValid) return
    onStart({
      goal: goalText.trim(),
      title: goalText.trim().slice(0, 60),
      goalType: classification.goalType,
      phases: classification.phases as MpaPhaseType[]
    })
    onClose()
  }, [classification, goalText, onStart, onClose])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (classification?.isValid) {
        handleStart()
      } else if (goalText.trim().length >= 15) {
        handleClassify()
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (classification?.isValid) {
        handleStart()
      } else if (goalText.trim().length >= 15) {
        handleClassify()
      }
    }
  }

  const canClassify = goalText.trim().length >= 15 && !classification
  const canStart = classification?.isValid === true

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-float rounded-xl border border-cyan-400/30 shadow-xl w-[520px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-cyan-500/10 border-b border-cyan-400/20">
          <div className="flex items-center gap-2">
            <Target size={16} className="text-cyan-400" />
            <span className="text-sm font-medium text-cyan-400">New Goal</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Textarea */}
          <textarea
            value={goalText}
            onChange={(e) => {
              setGoalText(e.target.value)
              setClassification(null)
            }}
            onBlur={handleClassify}
            onKeyDown={handleKeyDown}
            placeholder="Describe your goal with enough detail for an agent to plan and execute it..."
            rows={4}
            disabled={disabled}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/20 transition-colors resize-none"
            autoFocus
          />

          {/* Example chips — compact, clickable */}
          {!goalText && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  type="button"
                  key={ex}
                  onClick={() => {
                    setGoalText(ex)
                    setClassification(null)
                  }}
                  className="px-2.5 py-1 text-[11px] text-text-muted hover:text-text-secondary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-md transition-colors truncate max-w-[240px]"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {/* Pre-flight classification result */}
          {classification && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                classification.isValid
                  ? 'border-success/30 bg-success/5'
                  : 'border-danger/30 bg-danger/5'
              }`}
            >
              {classification.isValid ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium">
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
                    <p className="text-[10px] text-text-muted">
                      Includes 👤 User Review gate between Plan and Execute
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertCircle size={14} className="text-danger mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-danger">{classification.rejectionReason}</p>
                    {classification.suggestedGoal && (
                      <button
                        type="button"
                        onClick={() => {
                          setGoalText(classification.suggestedGoal!)
                          setClassification(null)
                        }}
                        className="text-[11px] text-accent hover:underline mt-1"
                      >
                        Try: &quot;{classification.suggestedGoal}&quot;
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-[11px] text-text-muted">
            {canStart ? '⌘+Enter to start' : canClassify ? 'Enter to classify' : ' '}
          </span>
          <div className="flex items-center gap-2">
            {classifying && (
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                Classifying…
              </span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            {canStart ? (
              <button
                onClick={handleStart}
                disabled={disabled}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg disabled:opacity-30 transition-colors"
              >
                <Zap size={12} />
                Start Goal
              </button>
            ) : (
              <button
                onClick={handleClassify}
                disabled={disabled || classifying || goalText.trim().length < 15}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg disabled:opacity-30 transition-colors"
              >
                <Target size={12} />
                Classify
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

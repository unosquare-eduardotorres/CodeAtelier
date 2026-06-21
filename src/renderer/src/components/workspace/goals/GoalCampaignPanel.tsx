/**
 * GoalCampaignPanel — in-page 3-step flow for turning a plan / typed description
 * into a set of editable measurable goals, then launching them as a campaign.
 *
 * Steps:
 *   1. Describe     — textarea (+ read-only original plan when handed off from grill)
 *   2. Review Goals — fully editable MeasurableGoal cards
 *   3. Run          — ordered summary → Start Campaign
 *
 * Replaces StartGoalModal. Hosted by GoalPage, taking over the content column
 * while active.
 */

import { useState, useEffect, useCallback, useRef, type JSX } from 'react'
import {
  Target,
  X,
  Loader2,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  Rocket,
  AlertCircle,
  Circle,
  CheckCircle2
} from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { GOAL_TYPE_LABELS } from './constants'
import type { MeasurableGoal, MpaGoalType, MpaPhaseType } from '../../../../../shared/mpa-types'

// Mirror of the backend PHASE_TEMPLATES (mpa-preflight.service.ts) so that
// changing a goal's type in the UI keeps its derived phases in sync.
const PHASE_TEMPLATES: Record<MpaGoalType, MpaPhaseType[]> = {
  feature: ['plan', 'execute', 'verify'],
  refactor: ['plan', 'execute', 'verify'],
  bugfix: ['plan', 'execute', 'verify'],
  tests: ['plan', 'execute']
}

const GOAL_TYPES: MpaGoalType[] = ['feature', 'refactor', 'bugfix', 'tests']

// Local id generator for newly-added goals. Avoids crypto.randomUUID(), which is
// undefined in non-secure renderer contexts (and these ids are purely client-side
// React keys, never persisted as the run id).
let goalIdCounter = 0
const nextGoalId = (): string => `g-${Date.now()}-${goalIdCounter++}`

type Step = 'describe' | 'review' | 'run'

const STEP_ORDER: Step[] = ['describe', 'review', 'run']
const STEP_LABELS: Record<Step, string> = {
  describe: 'Describe',
  review: 'Review Goals',
  run: 'Run'
}

interface GoalCampaignPanelProps {
  workspaceId: string
  onClose: () => void
}

// ── Step indicator ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }): JSX.Element {
  const currentIdx = STEP_ORDER.indexOf(current)
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      {STEP_ORDER.map((step, idx) => {
        const isActive = step === current
        const isDone = idx < currentIdx
        return (
          <div key={step} className="flex items-center gap-1.5">
            {idx > 0 && (
              <div className={`w-8 h-px ${isDone ? 'bg-cyan-400' : 'bg-border-subtle'}`} />
            )}
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${
                isActive ? 'text-cyan-400 bg-cyan-500/10' : 'text-text-muted'
              }`}
            >
              {isDone ? (
                <CheckCircle2 size={14} className="text-cyan-400" />
              ) : (
                <Circle size={14} className={isActive ? 'text-cyan-400' : 'text-text-muted'} />
              )}
              {STEP_LABELS[step]}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Goal card (Step 2) ──────────────────────────────────────────────────────

function GoalCard({
  goal,
  index,
  total,
  onChange,
  onDelete,
  onMove
}: {
  goal: MeasurableGoal
  index: number
  total: number
  onChange: (next: MeasurableGoal) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}): JSX.Element {
  const update = (patch: Partial<MeasurableGoal>): void => onChange({ ...goal, ...patch })

  const setCriterion = (ci: number, value: string): void => {
    const next = [...goal.successCriteria]
    next[ci] = value
    update({ successCriteria: next })
  }
  const addCriterion = (): void => update({ successCriteria: [...goal.successCriteria, ''] })
  const removeCriterion = (ci: number): void =>
    update({ successCriteria: goal.successCriteria.filter((_, i) => i !== ci) })

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-2.5">
      {/* Header row: order + reorder + delete */}
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/15 text-cyan-400 text-[11px] font-semibold flex-shrink-0">
          {index + 1}
        </span>
        <input
          value={goal.title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder="Goal title"
          className="flex-1 bg-surface-base border border-border-subtle rounded-md px-2 py-1 text-sm text-text-primary outline-none focus:border-cyan-400/50"
        />
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="Move up"
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-base disabled:opacity-30"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title="Move down"
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-base disabled:opacity-30"
        >
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete goal"
          className="p-1 rounded-md text-text-muted hover:text-danger hover:bg-danger/10"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Outcome */}
      <textarea
        value={goal.outcome}
        onChange={(e) => update({ outcome: e.target.value })}
        placeholder="Outcome — the concrete end state this goal achieves"
        rows={2}
        className="w-full bg-surface-base border border-border-subtle rounded-md px-2 py-1.5 text-xs text-text-primary outline-none focus:border-cyan-400/50 resize-none"
      />

      {/* Goal type */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted">Type</span>
        <select
          value={goal.goalType}
          onChange={(e) => {
            const goalType = e.target.value as MpaGoalType
            update({ goalType, phases: [...PHASE_TEMPLATES[goalType]] })
          }}
          className="bg-surface-base border border-border-subtle rounded-md px-2 py-1 text-xs text-text-primary outline-none focus:border-cyan-400/50"
        >
          {GOAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {GOAL_TYPE_LABELS[t].emoji} {GOAL_TYPE_LABELS[t].label}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-text-muted">{goal.phases.map((p) => p).join(' → ')}</span>
      </div>

      {/* Success criteria */}
      <div className="space-y-1.5">
        <span className="text-[11px] text-text-muted">Success criteria</span>
        {goal.successCriteria.map((c, ci) => (
          <div key={ci} className="flex items-center gap-1.5">
            <span className="text-text-muted text-xs">•</span>
            <input
              value={c}
              onChange={(e) => setCriterion(ci, e.target.value)}
              placeholder="Checkable criterion"
              className="flex-1 bg-surface-base border border-border-subtle rounded-md px-2 py-1 text-xs text-text-primary outline-none focus:border-cyan-400/50"
            />
            <button
              type="button"
              onClick={() => removeCriterion(ci)}
              className="p-1 rounded-md text-text-muted hover:text-danger"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addCriterion}
          className="flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
        >
          <Plus size={11} /> Add criterion
        </button>
      </div>
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function GoalCampaignPanel({
  workspaceId,
  onClose
}: GoalCampaignPanelProps): JSX.Element {
  const { decomposeGoals, startCampaign, preloadedGoal, setPreloadedGoal } = useMpaStore()

  const [step, setStep] = useState<Step>('describe')
  // Pre-fill from a grill / wizard handoff: land on Step 1 with the original
  // plan shown read-only and pre-filled into the editable input (Q11). Read the
  // handoff once at mount via lazy initializers (the panel only mounts after the
  // preloaded goal is set), then clear it in an effect.
  const [input, setInput] = useState(() => preloadedGoal?.text ?? '')
  const [originalPlan] = useState<string | null>(() => preloadedGoal?.text ?? null)
  // Captured once at mount: a successful greenfield handoff asks the panel to
  // decompose immediately so the user lands on editable goals, not a text box.
  const [autoDecompose] = useState(() => preloadedGoal?.autoDecompose ?? false)
  const [goals, setGoals] = useState<MeasurableGoal[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Consume the handoff so it isn't re-applied if the panel remounts.
  useEffect(() => {
    if (preloadedGoal) setPreloadedGoal(null)
  }, [preloadedGoal, setPreloadedGoal])

  const handleGenerate = useCallback(async () => {
    if (input.trim().length < 15) return
    setBusy(true)
    setError(null)
    try {
      const result = await decomposeGoals(workspaceId, input.trim())
      setGoals(result)
      setStep('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [input, workspaceId, decomposeGoals])

  const handleRegenerateAll = useCallback(async () => {
    if (!window.confirm('Regenerate all goals from the description? Your edits will be lost.'))
      return
    await handleGenerate()
  }, [handleGenerate])

  const updateGoal = useCallback((index: number, next: MeasurableGoal) => {
    setGoals((prev) => prev.map((g, i) => (i === index ? next : g)))
  }, [])

  const deleteGoal = useCallback((index: number) => {
    setGoals((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const moveGoal = useCallback((index: number, dir: -1 | 1) => {
    setGoals((prev) => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  const addGoal = useCallback(() => {
    setGoals((prev) => [
      ...prev,
      {
        id: nextGoalId(),
        title: '',
        outcome: '',
        successCriteria: [],
        goalType: 'feature',
        phases: [...PHASE_TEMPLATES.feature]
      }
    ])
  }, [])

  const handleStart = useCallback(async () => {
    const valid = goals.filter((g) => g.title.trim() && g.outcome.trim())
    if (valid.length === 0) {
      setError('Add at least one goal with a title and outcome.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await startCampaign({
        workspaceId,
        title: valid[0].title.trim().slice(0, 80),
        originalPlanMd: originalPlan ?? input.trim(),
        goals: valid
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }, [goals, startCampaign, workspaceId, originalPlan, input, onClose])

  // Auto-decompose once on a successful handoff so the user lands on editable
  // goals. If decomposition fails, handleGenerate surfaces the error and leaves
  // the user on the describe step to refine — never a silent dead end.
  const autoRanRef = useRef(false)
  useEffect(() => {
    if (autoDecompose && !autoRanRef.current && input.trim().length >= 15) {
      autoRanRef.current = true
      void handleGenerate()
    }
  }, [autoDecompose, input, handleGenerate])

  const canGenerate = input.trim().length >= 15 && !busy

  return (
    <div data-testid="goal-campaign-panel" className="rounded-xl border border-cyan-400/30 bg-surface-raised overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-cyan-500/10 border-b border-cyan-400/20">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-cyan-400" />
          <span className="text-sm font-medium text-cyan-400">New Campaign</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <StepIndicator current={step} />

      <div className="p-4 space-y-3">
        {error && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-danger/5 border border-danger/30">
            <AlertCircle size={14} className="text-danger mt-0.5 shrink-0" />
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        {/* ── Step 1: Describe ── */}
        {step === 'describe' && (
          <div className="space-y-3">
            {originalPlan && (
              <div className="space-y-1">
                <span className="text-[11px] text-text-muted">Original plan (read-only)</span>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap bg-surface-base border border-border-subtle rounded-lg p-2.5 text-[11px] text-text-secondary">
                  {originalPlan}
                </pre>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-[11px] text-text-muted">
                {originalPlan
                  ? 'Refine before generating goals'
                  : 'Describe what you want to build'}
              </span>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Describe the work — the agent will break it into measurable goals..."
                rows={originalPlan ? 5 : 8}
                className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-cyan-400/50 resize-none"
                autoFocus
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg disabled:opacity-30 transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
                Generate Goals
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Review ── */}
        {step === 'review' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                {goals.length} goal{goals.length !== 1 ? 's' : ''} — edit, reorder, add or remove
              </span>
              <button
                type="button"
                onClick={handleRegenerateAll}
                disabled={busy}
                className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
              >
                <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Regenerate all
              </button>
            </div>

            <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
              {goals.map((g, i) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  index={i}
                  total={goals.length}
                  onChange={(next) => updateGoal(i, next)}
                  onDelete={() => deleteGoal(i)}
                  onMove={(dir) => moveGoal(i, dir)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={addGoal}
              className="flex items-center gap-1.5 w-full justify-center py-2 text-xs text-text-muted hover:text-text-primary border border-dashed border-border-subtle rounded-lg hover:bg-surface-overlay transition-colors"
            >
              <Plus size={13} /> Add goal
            </button>

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => setStep('describe')}
                className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay"
              >
                <ArrowLeft size={13} /> Back
              </button>
              <button
                type="button"
                onClick={() => setStep('run')}
                disabled={goals.length === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg disabled:opacity-30"
              >
                Review & Run <ArrowRight size={13} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Run ── */}
        {step === 'run' && (
          <div className="space-y-3">
            <span className="text-xs text-text-secondary">
              Goals run sequentially. Each pauses for your plan approval before writing code.
            </span>
            <ol className="space-y-1.5">
              {goals.map((g, i) => (
                <li
                  key={g.id}
                  className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-overlay px-3 py-2"
                >
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/15 text-cyan-400 text-[11px] font-semibold flex-shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary truncate">
                      {GOAL_TYPE_LABELS[g.goalType].emoji} {g.title || '(untitled)'}
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {g.successCriteria.length} success criteri
                      {g.successCriteria.length === 1 ? 'on' : 'a'} · {g.phases.join(' → ')}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => setStep('review')}
                className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay"
              >
                <ArrowLeft size={13} /> Back
              </button>
              <button
                type="button"
                onClick={handleStart}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg disabled:opacity-30"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                Start Campaign
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * DesignConfigure — the three-step design wizard.
 *
 *   Brief → Commands → Scope + provider → Run
 *
 * All wizard state lives here; the steps are presentational. Two behaviours are
 * worth knowing before editing:
 *
 * 1. **The route call overlaps step 2.** `design:route` is fired on leaving the
 *    brief step and NOT awaited, so the user reads the card grid while the model
 *    thinks. It never blocks: the service degrades to a keyword table, so the
 *    only visible failure mode is a slightly-later preselect.
 *
 * 2. **A late route never overwrites a deliberate choice.** The answer can land
 *    after the user has already toggled a card or changed the scope, so both are
 *    guarded by refs — state would be stale inside the promise callback, and
 *    "the app undid my click a second later" is worse than no preselect at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Play, AlertTriangle } from 'lucide-react'
import {
  DESIGN_COMMANDS,
  MAX_DESIGN_FILES,
  validateDesignCommandSet
} from '../../../../../shared/design-commands'
import type {
  DesignCommandId,
  DesignRouteResult,
  DesignScope,
  DesignScopeTree,
  LLMProvider
} from '../../../../../shared/types'
import BriefStep from './BriefStep'
import CommandCardsStep from './CommandCardsStep'
import ScopeStep, { WHOLE_PROJECT } from './ScopeStep'

export interface DesignRunRequest {
  commandIds: DesignCommandId[]
  scope: DesignScope
  brief: string
  provider: LLMProvider
}

interface DesignConfigureProps {
  workspaceId: string
  onRun: (request: DesignRunRequest) => void
  onBack: () => void
  /** Refusal reason from a previous attempt, rendered inline. */
  error?: string | null
}

const STEPS = ['Brief', 'Commands', 'Scope'] as const
type StepIndex = 0 | 1 | 2

export default function DesignConfigure({
  workspaceId,
  onRun,
  onBack,
  error
}: DesignConfigureProps): React.JSX.Element {
  const [step, setStep] = useState<StepIndex>(0)
  const [brief, setBrief] = useState('')
  const [selected, setSelected] = useState<Set<DesignCommandId>>(
    () => new Set<DesignCommandId>(['critique', 'audit'])
  )
  const [provider, setProvider] = useState<LLMProvider>('claude')
  const [scopeTree, setScopeTree] = useState<DesignScopeTree | null>(null)
  const [scopeChoice, setScopeChoice] = useState<string>(WHOLE_PROJECT)
  const [route, setRoute] = useState<DesignRouteResult | null>(null)
  const [isRouting, setIsRouting] = useState(false)

  // Read inside async callbacks, where the corresponding state would be stale.
  const cardsTouchedRef = useRef(false)
  const scopeTouchedRef = useRef(false)
  const unmountedRef = useRef(false)
  // The scope tree and the route resolve independently and in either order, so
  // both are mirrored into refs and the hint is parked until the tree can
  // confirm it names a real directory.
  const scopeTreeRef = useRef<DesignScopeTree | null>(null)
  const pendingHintRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      unmountedRef.current = true
    },
    []
  )

  /**
   * Adopt a routed scope hint, but only once the tree can confirm it names a
   * directory the picker actually offers.
   *
   * Main has already proven the hint workspace-relative; a path that is simply
   * not in the tree would select nothing and blank the file count.
   */
  const adoptScopeHint = useCallback((hint: string | null) => {
    if (!hint || scopeTouchedRef.current) return
    const tree = scopeTreeRef.current
    if (!tree) {
      pendingHintRef.current = hint
      return
    }
    if (tree.dirs.some((d) => d.path === hint)) setScopeChoice(hint)
  }, [])

  // ── Scope tree ──
  // Loaded on mount rather than on reaching step 3: the renderer has no fs
  // access, this walk is the only source of truth for what is scannable, and
  // overlapping it with steps 1–2 means the scope step opens already populated.
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void window.api
      .designScopeTree({ workspaceId })
      .then((res) => {
        if (cancelled || !res.ok) return
        scopeTreeRef.current = res.data
        setScopeTree(res.data)
        if (!scopeTouchedRef.current) setScopeChoice(res.data.suggested ?? WHOLE_PROJECT)
        // A hint that arrived before the tree — apply it now that it can be
        // checked, overriding `suggested` because the user's brief is a stronger
        // signal than file density.
        const pending = pendingHintRef.current
        pendingHintRef.current = null
        adoptScopeHint(pending)
      })
      .catch(() => {
        // Whole-project stays selectable, so a failed scan degrades to the
        // opt-in rather than blocking the wizard.
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, adoptScopeHint])

  // ── Route ──
  const applyRoute = useCallback(
    (result: DesignRouteResult) => {
      setRoute(result)
      if (!cardsTouchedRef.current) setSelected(new Set(result.commandIds))
      adoptScopeHint(result.scopeHint)
    },
    [adoptScopeHint]
  )

  const handleBriefNext = useCallback(() => {
    setStep(1)
    const trimmed = brief.trim()
    if (!trimmed || !workspaceId) return

    setIsRouting(true)
    void window.api
      .designRoute({ workspaceId, brief: trimmed })
      .then((res) => {
        if (unmountedRef.current) return
        // The service never fails — an `ok: false` here means the channel itself
        // refused (bad workspace), which is not worth a banner mid-wizard.
        if (res.ok) applyRoute(res.data)
      })
      .catch(() => {})
      .finally(() => {
        if (!unmountedRef.current) setIsRouting(false)
      })
  }, [brief, workspaceId, applyRoute])

  const toggleCommand = useCallback((id: DesignCommandId) => {
    cardsTouchedRef.current = true
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleScopeChange = useCallback((choice: string) => {
    scopeTouchedRef.current = true
    setScopeChoice(choice)
  }, [])

  const selectedIds = useMemo(
    () => DESIGN_COMMANDS.filter((c) => selected.has(c.id)).map((c) => c.id),
    [selected]
  )
  const isValid = useMemo(
    () => selectedIds.length > 0 && validateDesignCommandSet(selectedIds).valid,
    [selectedIds]
  )

  const scopeFileCount =
    scopeChoice === WHOLE_PROJECT
      ? (scopeTree?.totalFiles ?? 0)
      : (scopeTree?.dirs.find((d) => d.path === scopeChoice)?.fileCount ?? 0)

  // The scope tree is deliberately uncapped — it counts to rank directories —
  // but `discoverDesignFiles` only hands the agent `MAX_DESIGN_FILES`. Rendering
  // the raw count told the user 393 files were reviewed when 100 were.
  const reviewedCount = Math.min(scopeFileCount, MAX_DESIGN_FILES)
  const runLabel =
    reviewedCount < scopeFileCount
      ? `${reviewedCount} of ${scopeFileCount} files`
      : `${reviewedCount} file${reviewedCount === 1 ? '' : 's'}`

  const handleRun = useCallback(() => {
    if (!isValid) return
    onRun({
      commandIds: selectedIds,
      scope:
        scopeChoice === WHOLE_PROJECT
          ? { mode: 'project', paths: [] }
          : { mode: 'paths', paths: [scopeChoice] },
      brief: brief.trim(),
      provider
    })
  }, [isValid, selectedIds, scopeChoice, brief, provider, onRun])

  return (
    <div data-testid="design-configure" className="flex flex-col h-full">
      {/* Header — step rail */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-2">
          <button
            data-testid="design-back-btn"
            onClick={() => (step === 0 ? onBack() : setStep((s) => (s - 1) as StepIndex))}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            title={step === 0 ? 'Back to history' : 'Previous step'}
          >
            <ChevronLeft size={16} />
          </button>
          <h2 className="text-sm font-bold text-text-primary">New Design Review</h2>
        </div>

        <div className="flex items-center gap-1.5" data-testid="design-step-rail">
          {STEPS.map((label, i) => (
            <span
              key={label}
              data-step-active={i === step}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors ${
                i === step
                  ? 'bg-purple-500/20 text-purple-300'
                  : i < step
                    ? 'text-text-secondary'
                    : 'text-text-muted'
              }`}
            >
              {i + 1}. {label}
            </span>
          ))}
        </div>

        {step < 2 ? (
          <button
            data-testid="design-next-btn"
            onClick={() => (step === 0 ? handleBriefNext() : setStep(2))}
            disabled={step === 1 && !isValid}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg bg-purple-500/15 text-purple-300 hover:bg-purple-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {step === 0 && brief.trim().length === 0 ? 'Skip' : 'Next'}
            <ChevronRight size={14} />
          </button>
        ) : (
          <button
            data-testid="design-run-btn"
            onClick={handleRun}
            disabled={!isValid}
            className="flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-lg bg-purple-500/15 text-purple-300 hover:bg-purple-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play size={14} />
            Run Review · {runLabel}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div
            data-testid="design-error"
            className="max-w-2xl mx-auto mt-6 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20"
          >
            <AlertTriangle size={14} className="text-danger shrink-0 mt-0.5" />
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        {step === 0 && (
          <BriefStep brief={brief} onBriefChange={setBrief} onNext={handleBriefNext} />
        )}
        {step === 1 && (
          <CommandCardsStep
            selected={selected}
            onToggle={toggleCommand}
            route={route}
            isRouting={isRouting}
          />
        )}
        {step === 2 && (
          <ScopeStep
            scopeTree={scopeTree}
            scopeChoice={scopeChoice}
            onScopeChange={handleScopeChange}
            provider={provider}
            onProviderChange={setProvider}
          />
        )}
      </div>
    </div>
  )
}

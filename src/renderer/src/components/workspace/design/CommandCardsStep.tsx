/**
 * CommandCardsStep — step 2 of the design wizard: which passes to run.
 *
 * ── Why an incompatible card is disabled rather than merely flagged ──────────
 * `validateDesignCommandSet` is enforced again in `parseDesignRunConfig`, which
 * *throws*. Letting the user assemble a set the main process will reject turns a
 * modelling rule into an unexplained failure at Run time, so a conflicting card
 * is unclickable and names the selection that blocks it.
 *
 * ── Why Evaluate is visually separated ──────────────────────────────────────
 * Only `audit` and `critique` execute. Every other card is a routing signal that
 * shapes the review and the downstream remediation brief. A grid that showed all
 * sixteen as equals would imply sixteen passes are about to run.
 */

import { useMemo } from 'react'
import { Check, Loader2, Wand2, AlertTriangle } from 'lucide-react'
import {
  DESIGN_COMMANDS,
  DESIGN_COMMANDS_BY_ID,
  validateDesignCommandSet
} from '../../../../../shared/design-commands'
import type {
  DesignCommandCategory,
  DesignCommandId,
  DesignRouteResult
} from '../../../../../shared/types'

const CATEGORY_SECTIONS: { id: DesignCommandCategory; title: string; hint: string }[] = [
  {
    id: 'evaluate',
    title: 'Evaluate',
    hint: 'These run as review passes and produce the findings.'
  },
  { id: 'refine', title: 'Refine', hint: 'Shapes what the review looks for and recommends.' },
  { id: 'simplify', title: 'Simplify', hint: 'Shapes what the review looks for and recommends.' },
  { id: 'harden', title: 'Harden', hint: 'Shapes what the review looks for and recommends.' }
]

interface CommandCardsStepProps {
  selected: Set<DesignCommandId>
  onToggle: (id: DesignCommandId) => void
  /** The route result once it lands; null while it is still in flight or absent. */
  route: DesignRouteResult | null
  isRouting: boolean
}

export default function CommandCardsStep({
  selected,
  onToggle,
  route,
  isRouting
}: CommandCardsStepProps): React.JSX.Element {
  /** commandId → the name of the selected card that rules it out. */
  const blockedBy = useMemo(() => {
    const map: Partial<Record<DesignCommandId, string>> = {}
    for (const cmd of DESIGN_COMMANDS) {
      if (selected.has(cmd.id)) continue
      const clash = cmd.incompatibleWith.find((other) => selected.has(other))
      if (clash) map[cmd.id] = DESIGN_COMMANDS_BY_ID[clash].name
    }
    return map
  }, [selected])

  const selectedIds = useMemo(
    () => DESIGN_COMMANDS.filter((c) => selected.has(c.id)).map((c) => c.id),
    [selected]
  )
  const validation = useMemo(() => validateDesignCommandSet(selectedIds), [selectedIds])
  const evaluateCount = selectedIds.filter(
    (id) => DESIGN_COMMANDS_BY_ID[id].category === 'evaluate'
  ).length

  return (
    <div data-testid="design-cards-step" className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      {/* Routing banner — the model's read of the brief, or its absence. */}
      {isRouting && (
        <div
          data-testid="design-route-pending"
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-overlay border border-border-subtle"
        >
          <Loader2 size={14} className="text-purple-400 animate-spin shrink-0" />
          <p className="text-xs text-text-secondary">Reading your brief…</p>
        </div>
      )}
      {!isRouting && route && (
        <div
          data-testid="design-route-rationale"
          data-used-fallback={route.usedFallback}
          className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20"
        >
          <Wand2 size={14} className="text-purple-400 shrink-0 mt-0.5" />
          <p className="text-xs text-purple-200">
            {route.rationale}
            {route.usedFallback && (
              <span className="text-text-muted"> (matched from keywords)</span>
            )}
          </p>
        </div>
      )}

      {/* The validator is the authority even though conflicting cards are
          disabled — a preselect that arrived from elsewhere still has to fail
          loudly rather than silently at Run time. */}
      {!validation.valid && (
        <div
          data-testid="design-conflict-banner"
          className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20"
        >
          <AlertTriangle size={14} className="text-danger shrink-0 mt-0.5" />
          <p className="text-xs text-danger">
            Incompatible selection:{' '}
            {validation.conflicts
              .map(
                ([a, b]) => `${DESIGN_COMMANDS_BY_ID[a].name} + ${DESIGN_COMMANDS_BY_ID[b].name}`
              )
              .join(', ')}
          </p>
        </div>
      )}

      {evaluateCount === 0 && (
        <p className="text-[11px] text-text-muted">
          No evaluate pass selected — Critique will run anyway, shaped by the cards you picked.
        </p>
      )}

      {CATEGORY_SECTIONS.map((section) => (
        <section key={section.id}>
          <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            {section.title}
          </h3>
          <p className="text-[11px] text-text-muted mb-3">{section.hint}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {DESIGN_COMMANDS.filter((c) => c.category === section.id).map((cmd) => {
              const isSelected = selected.has(cmd.id)
              const blocker = blockedBy[cmd.id]
              const wasRouted = route?.commandIds.includes(cmd.id) ?? false
              return (
                <button
                  key={cmd.id}
                  data-testid="design-command-card"
                  data-command-id={cmd.id}
                  data-selected={isSelected}
                  data-blocked={blocker !== undefined}
                  onClick={() => onToggle(cmd.id)}
                  disabled={blocker !== undefined}
                  className={`rounded-xl border p-4 text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    isSelected
                      ? 'border-purple-500/50 bg-purple-500/10'
                      : 'border-border-subtle bg-surface-raised hover:border-border-default'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border ${
                        isSelected
                          ? 'bg-purple-500 border-purple-500 text-white'
                          : 'border-border-default'
                      }`}
                    >
                      {isSelected && <Check size={13} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-text-primary">{cmd.name}</span>
                        {section.id === 'evaluate' && (
                          <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded bg-purple-500/20 text-purple-300">
                            Runs
                          </span>
                        )}
                        {wasRouted && (
                          <span
                            className="text-[9px] text-purple-300/70 uppercase tracking-wide"
                            title="Picked from your brief"
                          >
                            suggested
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-text-secondary mt-0.5 leading-snug">
                        {cmd.description}
                      </p>
                      {blocker && (
                        <p className="text-[10px] text-warning mt-1.5">Conflicts with {blocker}</p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

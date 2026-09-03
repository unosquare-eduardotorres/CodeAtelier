/**
 * Read-only promotion diagnostics.
 *
 * Answers "why is nothing ever being promoted?" — the tier histogram shows the
 * shape of the pyramid, and the stuck breakdown names the single gate each
 * eligible-looking T0 fact is failing. No actions, no mutations.
 */

import { useState } from 'react'

import {
  MEMORY_T0_PROMOTION_MIN_CONFIDENCE,
  MEMORY_T0_PROMOTION_MIN_CONFIRMS,
  MEMORY_T0_PROMOTION_MIN_DAYS
} from '../../../../../shared/types'
import type { MemoryPromotionDiagnostics } from '../../../../../shared/types'

const TIER_LABELS = ['T0 Observed', 'T1 Confirmed', 'T2 Established', 'T3 Wisdom'] as const

const TIER_BARS = ['bg-text-muted', 'bg-info', 'bg-success', 'bg-primary-text'] as const

interface PromotionDiagnosticsProps {
  diagnostics: MemoryPromotionDiagnostics | null
}

export default function PromotionDiagnostics({
  diagnostics
}: PromotionDiagnosticsProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  if (!diagnostics) return null

  const { tierCounts, stuck } = diagnostics
  const total = tierCounts.reduce((sum, n) => sum + n, 0)
  if (total === 0) return null

  const max = Math.max(...tierCounts, 1)

  return (
    <div className="shrink-0 px-3 py-2.5 mb-3 bg-surface-float border border-border-default rounded-md">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <span className="text-xs font-medium text-text-primary">Promotion</span>
        <span className="text-xs text-text-muted">
          {stuck.total > 0
            ? `${stuck.total} stuck at T0 · ${total} active`
            : `${total} active facts`}
        </span>
      </button>

      {/* Tier histogram — always visible, it is the whole point */}
      <div className="mt-2 flex items-end gap-2">
        {tierCounts.map((count, tier) => (
          <div key={tier} className="flex-1 flex flex-col gap-1" title={TIER_LABELS[tier]}>
            <span className="text-xs font-mono text-text-secondary">{count}</span>
            <div className="h-1.5 bg-border-default rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${TIER_BARS[tier]}`}
                style={{ width: `${Math.round((count / max) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-text-muted">{TIER_LABELS[tier]}</span>
          </div>
        ))}
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border-default text-xs text-text-secondary space-y-1">
          {stuck.total === 0 ? (
            <p className="text-text-muted">
              No facts are stuck: every active T0 fact with {MEMORY_T0_PROMOTION_MIN_CONFIRMS}+
              evidence confirmations has already been promoted.
            </p>
          ) : (
            <>
              <p className="text-text-muted">
                Facts still at T0 despite {MEMORY_T0_PROMOTION_MIN_CONFIRMS}+ evidence
                confirmations, grouped by the first gate each one fails:
              </p>
              <StuckRow
                count={stuck.needsMoreDays}
                label={`Confirmed on fewer than ${MEMORY_T0_PROMOTION_MIN_DAYS} distinct days`}
              />
              <StuckRow
                count={stuck.needsConfidence}
                label={`Confidence below ${MEMORY_T0_PROMOTION_MIN_CONFIDENCE}`}
              />
              <StuckRow
                count={stuck.awaitingSweep}
                label="Passing every gate — the next consolidation sweep should promote these"
              />
            </>
          )}
          <p className="pt-1 text-text-muted">
            Only independent evidence counts. Auto-dedup confirmations are recorded for audit but
            weigh nothing toward promotion.
          </p>
        </div>
      )}
    </div>
  )
}

function StuckRow({ count, label }: { count: number; label: string }): React.JSX.Element {
  return (
    <p className={count === 0 ? 'text-text-muted' : ''}>
      <span className="font-mono">{count}</span> · {label}
    </p>
  )
}

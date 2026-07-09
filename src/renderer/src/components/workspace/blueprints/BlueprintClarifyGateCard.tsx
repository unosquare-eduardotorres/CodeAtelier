/**
 * BlueprintClarifyGateCard — user-driven gate between clarify → plan.
 * Shows severity × status summary; user chooses "Continue to Plan" or "Ask more questions".
 */

import type { JSX } from 'react'
import { ArrowRight, MessageCircleQuestion, CheckCircle2, AlertTriangle } from 'lucide-react'
import type {
  ClarifyFindingsBlock,
  ClarifyFindingSeverity,
  ClarifyFindingStatus
} from '../../../../../shared/blueprint-clarify-parsers'

interface BlueprintClarifyGateCardProps {
  findings: ClarifyFindingsBlock | null
  onProceed: () => void
  onIterate: () => void
}

export function BlueprintClarifyGateCard({
  findings,
  onProceed,
  onIterate
}: BlueprintClarifyGateCardProps): JSX.Element {
  const matrix = computeMatrix(findings)
  const hasBlockers = matrix.critical.outstanding > 0 || matrix.high.outstanding > 0
  const totalOutstanding = Object.values(matrix).reduce((sum, row) => sum + row.outstanding, 0)

  return (
    <div
      data-testid="blueprint-clarify-gate"
      className={`rounded-xl border p-4 space-y-3 ${
        hasBlockers
          ? 'bg-amber-500/5 border-amber-500/30'
          : 'bg-green-500/5 border-green-500/30'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {hasBlockers ? (
          <AlertTriangle size={14} className="text-amber-400" />
        ) : (
          <CheckCircle2 size={14} className="text-green-400" />
        )}
        <span className="text-xs font-semibold text-text-primary">
          {hasBlockers
            ? `${totalOutstanding} outstanding gap${totalOutstanding > 1 ? 's' : ''} remain`
            : findings && findings.findings.length > 0
              ? 'All gaps resolved or deferred — safe to proceed'
              : 'No gaps found — ready to plan'}
        </span>
      </div>

      {/* Matrix summary (only if there are findings) */}
      {findings && findings.findings.length > 0 && (
        <div className="grid grid-cols-4 gap-1 text-[10px]">
          <div className="text-text-muted font-medium">Severity</div>
          <div className="text-text-muted font-medium text-center">Outstanding</div>
          <div className="text-text-muted font-medium text-center">Resolved</div>
          <div className="text-text-muted font-medium text-center">Deferred</div>
          {(['critical', 'high', 'medium', 'low'] as ClarifyFindingSeverity[]).map((sev) => {
            const row = matrix[sev]
            if (row.outstanding + row.resolved + row.deferred === 0) return null
            return (
              <div key={sev} className="contents">
                <div className="text-text-secondary capitalize">{sev}</div>
                <div className="text-center text-amber-400">
                  {row.outstanding || '—'}
                </div>
                <div className="text-center text-green-400">
                  {row.resolved || '—'}
                </div>
                <div className="text-center text-slate-400">
                  {row.deferred || '—'}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {hasBlockers ? (
          <>
            <button
              onClick={onIterate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
            >
              <MessageCircleQuestion size={12} />
              Ask more questions
            </button>
            <button
              onClick={onProceed}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-inset text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <ArrowRight size={12} />
              Continue anyway
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onProceed}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 transition-colors"
            >
              <ArrowRight size={12} />
              Continue to Plan
            </button>
            <button
              onClick={onIterate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-inset text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <MessageCircleQuestion size={12} />
              Ask more questions
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──

interface SeverityRow {
  outstanding: number
  resolved: number
  deferred: number
}

function computeMatrix(
  findings: ClarifyFindingsBlock | null
): Record<ClarifyFindingSeverity, SeverityRow> {
  const empty: SeverityRow = { outstanding: 0, resolved: 0, deferred: 0 }
  const result: Record<ClarifyFindingSeverity, SeverityRow> = {
    critical: { ...empty },
    high: { ...empty },
    medium: { ...empty },
    low: { ...empty }
  }

  if (!findings) return result

  for (const f of findings.findings) {
    const sev = result[f.severity]
    if (!sev) continue
    const status: ClarifyFindingStatus = f.status
    if (status === 'outstanding') sev.outstanding++
    else if (status === 'resolved') sev.resolved++
    else if (status === 'deferred') sev.deferred++
  }

  return result
}

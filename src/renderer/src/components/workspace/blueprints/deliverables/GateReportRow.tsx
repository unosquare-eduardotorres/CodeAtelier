/**
 * GateReportRow — one deterministic gate report, rendered as a labelled row of
 * verdict chips.
 *
 * Extracted from `BuildDeliverable`'s wave-gate row so VERIFY can render its own
 * `verify-gates` artifact with the same shape. Before this, the verify report was
 * written to the phase and read by nothing: the VERIFY deliverable showed only
 * `json.qualityGates`, which is what the MODEL claimed, not what the gates
 * measured — so a red or unverifiable e2e gate was invisible exactly where a user
 * goes to read the verdict.
 */

import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { GateReport } from '../../../../../../shared/gate-types'

const GATE_VERDICT_STYLE: Record<string, string> = {
  pass: 'text-success bg-success/10',
  fail: 'text-danger bg-danger/10',
  unverifiable: 'text-warning bg-warning/10'
}

export function GateReportRow({
  label,
  report,
  ungatedCommits,
  testId
}: {
  label: string
  report: GateReport
  /** B1 — commits in range with no task id, named on a failed wave. */
  ungatedCommits?: Array<{ sha: string; subject: string }>
  testId?: string
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-border-subtle bg-surface-inset/30 px-3 py-2"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono font-semibold text-text-secondary">{label}</span>
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
            report.overall === 'fail'
              ? 'text-danger bg-danger/10'
              : report.overall === 'unverifiable'
                ? 'text-warning bg-warning/10'
                : 'text-success bg-success/10'
          }`}
        >
          {report.overall}
        </span>
        {report.gates.map((g) => (
          <span
            key={g.name}
            title={g.evidence.join('\n')}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${GATE_VERDICT_STYLE[g.verdict] ?? 'text-text-muted bg-surface-inset'}`}
          >
            {g.name}:{g.verdict}
            {g.verdict === 'unverifiable' && g.reason ? ` (${g.reason})` : ''}
          </span>
        ))}
      </div>
      {/* B1 — attribution for commits no gate ever graded (manual terminal
          commits during the wave). Shown only on failed waves, by design. */}
      {ungatedCommits && ungatedCommits.length > 0 && (
        <div className="mt-2 rounded-md border border-warning/20 bg-warning/5 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={11} className="text-warning" />
            <span className="text-[11px] text-warning">
              {ungatedCommits.length} commit{ungatedCommits.length > 1 ? 's' : ''} since the build
              began carry no task id and were never gated:
            </span>
          </div>
          <ul className="space-y-0.5">
            {ungatedCommits.slice(0, 5).map((c) => (
              <li key={c.sha} className="text-[11px] font-mono text-text-muted truncate">
                {c.sha.slice(0, 8)} “{c.subject}”
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

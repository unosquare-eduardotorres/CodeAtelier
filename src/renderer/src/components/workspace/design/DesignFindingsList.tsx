/**
 * DesignFindingsList — findings for one design command.
 *
 * Differs from HealthFindingsList in one way that matters: a design run merges
 * two populations. Deterministic detector hits carry `source ===
 * 'impeccable-detector'` and are positional and literal; the rest are the
 * agent's own judgements. They are badged apart because a reader trusts them
 * differently.
 */

import { useMemo } from 'react'
import type { AuditFinding } from '../../../../../shared/types'

interface DesignFindingsListProps {
  findings: AuditFinding[]
  selectedFindings: AuditFinding[]
  onToggle: (finding: AuditFinding) => void
  commandName: string
  score: number | null
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

/** Mirrors `DETECTOR_SOURCE` in impeccable-detector.service.ts. */
const DETECTOR_SOURCE = 'impeccable-detector'

export default function DesignFindingsList({
  findings,
  selectedFindings,
  onToggle,
  commandName,
  score
}: DesignFindingsListProps): React.JSX.Element {
  // Derived collections are memoized — this list re-renders on every checkbox
  // toggle and findings can run to hundreds of rows.
  const selectedIds = useMemo(() => new Set(selectedFindings.map((f) => f.id)), [selectedFindings])
  const issues = useMemo(() => findings.filter((f) => f.severity !== 'info'), [findings])
  const passed = useMemo(() => findings.filter((f) => f.severity === 'info'), [findings])
  const detectorCount = useMemo(
    () => findings.filter((f) => f.source === DETECTOR_SOURCE).length,
    [findings]
  )

  if (findings.length === 0) {
    return (
      <div className="py-3 text-center text-xs text-text-muted">No findings for this pass yet.</div>
    )
  }

  return (
    <div data-testid="design-findings-list" className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-text-secondary">
          {commandName} — {score !== null ? `${score}/100` : '—'}
        </span>
        <span className="text-[11px] text-text-muted">
          {findings.length} finding{findings.length === 1 ? '' : 's'}
          {detectorCount > 0 && ` · ${detectorCount} from the detector`}
        </span>
      </div>

      {issues.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1">
            Issues ({issues.length})
          </span>
          {issues.map((finding) => (
            <label
              key={finding.id}
              data-testid="design-finding"
              className="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-overlay cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(finding.id)}
                onChange={() => onToggle(finding)}
                className="mt-0.5 rounded border-border-subtle text-primary focus:ring-primary/50"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded ${
                      SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info
                    }`}
                  >
                    {finding.severity}
                  </span>
                  <SourceBadge source={finding.source} />
                  <span className="text-xs font-medium text-text-primary truncate">
                    {finding.title}
                  </span>
                </div>
                <p className="text-[11px] text-text-secondary mt-0.5">{finding.description}</p>
                {finding.recommendation && (
                  <p className="text-[11px] text-text-muted mt-0.5">→ {finding.recommendation}</p>
                )}
                {finding.filePath && (
                  <span className="text-[10px] text-text-muted font-mono mt-0.5 block truncate">
                    {finding.filePath}
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {passed.length > 0 && (
        <div className="space-y-1 mt-3">
          <span className="text-[10px] font-semibold text-success uppercase tracking-wider px-1">
            ✓ Observations ({passed.length})
          </span>
          {passed.map((finding) => (
            <div key={finding.id} className="flex items-start gap-2 p-2 rounded-lg bg-success/5">
              <span className="text-success mt-0.5 flex-shrink-0">✓</span>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-text-primary">{finding.title}</span>
                <p className="text-[11px] text-text-secondary mt-0.5">{finding.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source?: string }): React.JSX.Element {
  const isDetector = source === DETECTOR_SOURCE
  return (
    <span
      data-testid="design-finding-source"
      data-source={isDetector ? 'detector' : 'agent'}
      className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded ${
        isDetector ? 'bg-info-muted text-info' : 'bg-accent-muted text-accent'
      }`}
      title={
        isDetector
          ? 'Deterministic scan — an exact rule match at this location'
          : 'Agent judgement — reviewed in context'
      }
    >
      {isDetector ? 'Detector' : 'Review'}
    </span>
  )
}

import { Wrench } from 'lucide-react'
import type { AuditFinding } from '../../../../shared/types'

interface HealthFindingsListProps {
  findings: AuditFinding[]
  selectedFindings: AuditFinding[]
  onToggle: (finding: AuditFinding) => void
  onConvertToChat: () => void
  trackName: string
  score: number | null
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

export default function HealthFindingsList({
  findings,
  selectedFindings,
  onToggle,
  onConvertToChat,
  trackName,
  score
}: HealthFindingsListProps): React.JSX.Element {
  const selectedIds = new Set(selectedFindings.map((f) => f.id))
  const selectedCount = selectedFindings.length

  const issues = findings.filter((f) => f.severity !== 'info')
  const passedChecks = findings.filter((f) => f.severity === 'info')

  if (findings.length === 0) {
    return (
      <div className="py-3 text-center text-xs text-text-muted">
        No analysis results available. Try re-running this auditor.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-text-secondary">
          {trackName} — {score !== null ? `${score}/100` : '—'}
        </span>
        <span className="text-[11px] text-text-muted">
          {findings.length} finding{findings.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Issues section */}
      {issues.length > 0 && (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1">
            Issues ({issues.length})
          </span>
          {issues.map((finding) => (
            <label
              key={finding.id}
              className="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-overlay cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(finding.id)}
                onChange={() => onToggle(finding)}
                className="mt-0.5 rounded border-border-subtle text-primary focus:ring-primary/50"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded ${
                      SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info
                    }`}
                  >
                    {finding.severity}
                  </span>
                  <span className="text-xs font-medium text-text-primary truncate">
                    {finding.title}
                  </span>
                </div>
                <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">
                  {finding.description}
                </p>
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

      {/* Passed Checks section */}
      {passedChecks.length > 0 && (
        <div className="space-y-1 mt-3">
          <span className="text-[10px] font-semibold text-success uppercase tracking-wider px-1">
            ✓ Passed Checks ({passedChecks.length})
          </span>
          {passedChecks.map((finding) => (
            <div key={finding.id} className="flex items-start gap-2 p-2 rounded-lg bg-success/5">
              <span className="text-success mt-0.5 flex-shrink-0">✓</span>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-text-primary">{finding.title}</span>
                <p className="text-[11px] text-text-secondary mt-0.5">{finding.description}</p>
                {finding.filePath && (
                  <span className="text-[10px] text-text-muted font-mono mt-0.5 block truncate">
                    {finding.filePath}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedCount > 0 && (
        <button
          onClick={onConvertToChat}
          className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium rounded-lg bg-primary/10 text-primary-text hover:bg-primary/20 transition-colors justify-center"
        >
          <Wrench size={12} />
          Fix {selectedCount} Selected in Chat
        </button>
      )}
    </div>
  )
}

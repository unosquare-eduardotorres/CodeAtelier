import type { JSX } from 'react'
import { FileCode, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'
import type { MpaVerifyReport } from '../../../../../shared/mpa-types'

const STATUS_ICONS: Record<string, JSX.Element> = {
  implemented: <CheckCircle size={12} className="text-success" />,
  partial: <AlertTriangle size={12} className="text-warning" />,
  missing: <XCircle size={12} className="text-danger" />
}

interface GoalArtifactViewerProps {
  report: MpaVerifyReport
}

export default function GoalArtifactViewer({ report }: GoalArtifactViewerProps): JSX.Element {
  return (
    <div data-testid="goal-artifact-viewer" className="space-y-4">
      {/* Summary */}
      <div
        className={`rounded-lg border p-3 ${
          report.allComplete ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          {report.allComplete ? (
            <CheckCircle size={16} className="text-success" />
          ) : (
            <AlertTriangle size={16} className="text-warning" />
          )}
          <span className="text-sm font-semibold text-text-primary">
            {report.allComplete ? 'All Items Verified' : 'Issues Found'}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div className="text-center">
            <p className="text-lg font-bold text-text-primary">{report.totalItems}</p>
            <p className="text-text-muted">Total</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-success">{report.implemented}</p>
            <p className="text-text-muted">Done</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-warning">{report.partial}</p>
            <p className="text-text-muted">Partial</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-danger">{report.missing}</p>
            <p className="text-text-muted">Missing</p>
          </div>
        </div>
      </div>

      {/* Per-criterion success criteria (campaign goals) */}
      {report.criteriaResults && report.criteriaResults.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-text-secondary">Success Criteria</h4>
          <div className="space-y-1.5">
            {report.criteriaResults.map((c, i) => (
              <div
                key={i}
                className="flex items-start gap-1.5 text-xs bg-surface-base rounded-lg border border-border-subtle p-2"
              >
                {c.status === 'pass' ? (
                  <CheckCircle size={12} className="text-success shrink-0 mt-0.5" />
                ) : (
                  <XCircle size={12} className="text-danger shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-text-primary">{c.criterion}</p>
                  {c.detail && <p className="text-text-muted mt-0.5">{c.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cross-cutting checks */}
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-text-secondary">Cross-Layer Checks</h4>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(report.crossCutting).map(([key, value]) => (
            <div key={key} className="flex items-center gap-1.5 text-xs">
              {value ? (
                <CheckCircle size={12} className="text-success" />
              ) : (
                <XCircle size={12} className="text-danger" />
              )}
              <span className="text-text-secondary">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Issues */}
      {report.issues.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-text-secondary">Issues</h4>
          {report.issues.map((issue, i) => (
            <div key={i} className="bg-surface-base rounded-lg border border-border-subtle p-2.5">
              <div className="flex items-center gap-2 mb-1">
                {STATUS_ICONS[issue.status]}
                <span className="text-xs font-mono text-text-muted">{issue.planItemId}</span>
                <span className="text-xs text-text-primary">{issue.status}</span>
              </div>
              <p className="text-xs text-text-secondary">{issue.detail}</p>
              {issue.filesChecked.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {issue.filesChecked.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-0.5 text-[10px] font-mono text-text-muted bg-surface-hover px-1 py-0.5 rounded"
                    >
                      <FileCode size={9} />
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Test Output */}
      {report.testOutput && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-text-secondary">Test Results</h4>
          <pre className="text-[10px] font-mono text-text-muted bg-surface-base rounded-lg border border-border-subtle p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
            {report.testOutput}
          </pre>
        </div>
      )}
    </div>
  )
}

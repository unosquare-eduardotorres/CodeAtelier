import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Search, UserRound, Users, RefreshCw, Lightbulb } from 'lucide-react'
import type { InvestigationReport } from '../../../../shared/types'

interface InvestigationReportCardProps {
  report: InvestigationReport
  specialist: string
  onFixSequential: () => void
  onFixParallel: () => void
  onRevise: () => void
  onSaveAsIdea: () => void
}

export default function InvestigationReportCard({
  report,
  specialist,
  onFixSequential,
  onFixParallel,
  onRevise,
  onSaveAsIdea
}: InvestigationReportCardProps): React.JSX.Element {
  // Impact badge styling
  const impactStyles: Record<string, string> = {
    'very-low': 'text-text-muted bg-surface-overlay',
    low: 'text-info bg-info-muted',
    medium: 'text-warning bg-warning-muted',
    high: 'text-danger bg-danger-muted',
    critical: 'text-white bg-danger'
  }
  const badgeClass = impactStyles[report.impact] ?? impactStyles.medium

  return (
    <div className="rounded-xl border border-primary/30 bg-primary-muted overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-primary/15 border-b border-primary/20">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-primary-text" />
          <span className="text-sm font-medium text-primary-text" title={`Specialist: ${specialist}`}>
            Investigation Complete
          </span>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}>
          {report.impact} impact
        </span>
      </div>

      {/* Problem */}
      <div className="px-5 py-3 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Problem</span>
        <div className="mt-1 prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.problem}</ReactMarkdown>
        </div>
      </div>

      {/* Root Cause */}
      <div className="px-5 py-3 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Root Cause</span>
        <div className="mt-1 prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.rootCause}</ReactMarkdown>
        </div>
      </div>

      {/* Proposed Fix */}
      <div className="px-5 py-3 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">How to Fix</span>
        <div className="mt-1 prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.proposedFix}</ReactMarkdown>
        </div>
      </div>

      {/* Files Affected */}
      {report.filesAffected.length > 0 && (
        <div className="px-5 py-3 border-b border-border-subtle">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Files Affected
          </span>
          <div className="mt-2 space-y-1">
            {report.filesAffected.map((file, idx) => (
              <div key={idx} className="flex items-start gap-2 text-sm">
                <code className="text-xs font-mono text-primary-text bg-surface-overlay px-1.5 py-0.5 rounded shrink-0">
                  {file.path}
                </code>
                <span className="text-text-secondary">{file.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Impact reason */}
      {report.impactReason && (
        <div className="px-5 py-2 text-xs text-text-muted">
          <strong>Impact:</strong> {report.impactReason}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-primary/20 bg-primary-muted">
        <button
          onClick={onFixSequential}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <UserRound size={14} /> Sequential Fix
        </button>
        <button
          onClick={onFixParallel}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <Users size={14} /> Multi-Agent
        </button>
        <button
          onClick={onRevise}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <RefreshCw size={14} /> Revise Plan
        </button>
        <button
          onClick={onSaveAsIdea}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <Lightbulb size={14} /> Save as Idea
        </button>
      </div>
    </div>
  )
}

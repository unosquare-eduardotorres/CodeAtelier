import { useState, type JSX } from 'react'
import {
  CheckCircle,
  MessageSquare,
  X,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
  Info,
  Shield,
  BarChart3
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { GATE_ICON } from './phase-icons'

// ── Types ──

interface BlueprintApprovalGateProps {
  planSummary: string
  /** Structured phase completion metrics (coverage, findings, recommendation, etc.) */
  completion?: Record<string, unknown>
  /** Full review report markdown (detailed findings, gaps, risks) */
  reviewMarkdown?: string
  onApprove: () => void
  onReject: (feedback: string) => void
  onCancel: () => void
}

// ── Recommendation Badge ──

type Recommendation = 'proceed' | 'fix_critical' | 're_specify' | string

function getRecommendationStyle(rec: Recommendation): { bg: string; text: string; border: string } {
  switch (rec) {
    case 'proceed':
      return { bg: 'bg-success/10', text: 'text-success', border: 'border-success/30' }
    case 'fix_critical':
      return { bg: 'bg-danger/10', text: 'text-danger', border: 'border-danger/30' }
    case 're_specify':
      return { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/30' }
    default:
      return { bg: 'bg-surface-inset', text: 'text-text-secondary', border: 'border-border-subtle' }
  }
}

function getRecommendationLabel(rec: Recommendation): string {
  switch (rec) {
    case 'proceed':
      return 'Proceed'
    case 'fix_critical':
      return 'Fix Critical Issues'
    case 're_specify':
      return 'Re-specify'
    default:
      return rec.replace(/_/g, ' ')
  }
}

// ── Severity Chip ──

function SeverityChip({ label, count }: { label: string; count: number }): JSX.Element | null {
  if (!count) return null
  const colorMap: Record<string, string> = {
    critical: 'bg-danger/10 text-danger border-danger/30',
    high: 'bg-warning/10 text-warning border-warning/30',
    medium: 'bg-info/10 text-info border-info/30',
    low: 'bg-surface-inset text-text-secondary border-border-subtle'
  }
  const cls = colorMap[label] ?? colorMap.low
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {count} {label}
    </span>
  )
}

// ── Main Component ──

export default function BlueprintApprovalGate({
  planSummary,
  completion,
  reviewMarkdown,
  onApprove,
  onReject,
  onCancel
}: BlueprintApprovalGateProps): JSX.Element {
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [reportExpanded, setReportExpanded] = useState(false)

  // Extract structured metrics from completion
  const findings = completion?.findings as
    | { critical?: number; high?: number; medium?: number; low?: number }
    | undefined
  const recommendation = (completion?.recommendation as string) ?? null
  const coveragePercent = completion?.coveragePercent as number | undefined
  const requirementsWithTasks = completion?.requirementsWithTasks as number | undefined
  const totalRequirements = completion?.totalRequirements as number | undefined
  const unmappedTasks = completion?.unmappedTasks as number | undefined
  const constitutionViolations = completion?.constitutionViolations as number | undefined

  const hasStructuredData = !!completion
  const hasReport = !!reviewMarkdown

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GATE_ICON.icon size={18} className="text-info" />
          <h3 className="text-sm font-semibold text-text-primary">Blueprint Review</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info font-medium">
            Approval Required
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Cancel blueprint"
        >
          <X size={16} />
        </button>
      </div>

      {/* ── Metrics Row (from structured completion) ── */}
      {hasStructuredData && (
        <div className="bg-surface-base rounded-lg border border-border-subtle p-3 space-y-3">
          {/* Top metrics row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Coverage */}
            {coveragePercent !== undefined && (
              <div className="flex items-center gap-1.5">
                <BarChart3 size={14} className="text-accent" />
                <span className="text-xs text-text-secondary">Coverage:</span>
                <span className={`text-sm font-semibold ${coveragePercent >= 80 ? 'text-success' : coveragePercent >= 50 ? 'text-warning' : 'text-danger'}`}>
                  {coveragePercent}%
                </span>
              </div>
            )}

            {/* Requirements mapping */}
            {requirementsWithTasks !== undefined && totalRequirements !== undefined && (
              <div className="flex items-center gap-1.5">
                <CheckCircle size={14} className="text-text-muted" />
                <span className="text-xs text-text-secondary">
                  {requirementsWithTasks}/{totalRequirements} requirements mapped
                </span>
              </div>
            )}

            {/* Unmapped tasks */}
            {unmappedTasks !== undefined && unmappedTasks > 0 && (
              <div className="flex items-center gap-1.5">
                <Info size={14} className="text-info" />
                <span className="text-xs text-text-secondary">
                  {unmappedTasks} unmapped tasks
                </span>
              </div>
            )}

            {/* Constitution violations */}
            {constitutionViolations !== undefined && constitutionViolations > 0 && (
              <div className="flex items-center gap-1.5">
                <Shield size={14} className="text-danger" />
                <span className="text-xs text-danger font-medium">
                  {constitutionViolations} constitution violation{constitutionViolations > 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>

          {/* Findings severity chips */}
          {findings && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-text-muted font-medium">Findings:</span>
              <SeverityChip label="critical" count={findings.critical ?? 0} />
              <SeverityChip label="high" count={findings.high ?? 0} />
              <SeverityChip label="medium" count={findings.medium ?? 0} />
              <SeverityChip label="low" count={findings.low ?? 0} />
              {!findings.critical && !findings.high && !findings.medium && !findings.low && (
                <span className="text-xs text-success font-medium">None</span>
              )}
            </div>
          )}

          {/* Recommendation badge */}
          {recommendation && (() => {
            const style = getRecommendationStyle(recommendation)
            const label = getRecommendationLabel(recommendation)
            const RecIcon = recommendation === 'proceed'
              ? CheckCircle
              : recommendation === 'fix_critical'
                ? AlertTriangle
                : AlertCircle
            return (
              <div className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border ${style.bg} ${style.text} ${style.border}`}>
                <RecIcon size={13} />
                {label}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Full Report (collapsible markdown) ── */}
      {hasReport && (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <button
            type="button"
            onClick={() => setReportExpanded(!reportExpanded)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay hover:bg-surface-hover/50 transition-colors text-left"
          >
            {reportExpanded ? (
              <ChevronDown size={14} className="text-text-muted" />
            ) : (
              <ChevronRight size={14} className="text-text-muted" />
            )}
            <span className="text-xs font-semibold text-text-primary">Full Review Report</span>
            <span className="text-[10px] text-text-muted ml-auto">
              {reportExpanded ? 'Collapse' : 'Expand to see detailed findings, gaps, and risks'}
            </span>
          </button>
          {reportExpanded && (
            <div className="bg-surface-base border-t border-border-subtle p-3 max-h-96 overflow-y-auto">
              <div className="prose prose-sm max-w-none text-text-body
                prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
                prose-p:leading-relaxed prose-p:text-sm
                prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
                prose-strong:text-text-primary prose-strong:font-semibold
                prose-li:text-sm prose-li:text-text-body
              ">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {reviewMarkdown!}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Fallback: Plan Summary (when no structured data) ── */}
      {!hasStructuredData && (
        <div className="bg-surface-base rounded-lg border border-info/20 p-3 max-h-80 overflow-y-auto">
          <p className="text-xs font-medium text-text-secondary mb-1.5">Plan Summary</p>
          <div className="prose prose-sm max-w-none text-text-body
            prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
            prose-p:leading-relaxed prose-p:text-sm
            prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
            prose-strong:text-text-primary prose-strong:font-semibold
            prose-li:text-sm prose-li:text-text-body
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {planSummary}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Feedback Input */}
      {showFeedback && (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be changed? Be specific about what needs to be revised..."
            rows={3}
            autoFocus
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-info resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowFeedback(false)}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => feedback.trim() && onReject(feedback.trim())}
              disabled={!feedback.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors disabled:opacity-50"
            >
              Send Feedback & Revise
            </button>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      {!showFeedback && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
          <button
            type="button"
            onClick={() => setShowFeedback(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-lg transition-colors"
          >
            <MessageSquare size={14} />
            Request Changes
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-success hover:bg-success/80 rounded-lg transition-colors"
          >
            <CheckCircle size={14} />
            Approve & Build
          </button>
        </div>
      )}
    </div>
  )
}

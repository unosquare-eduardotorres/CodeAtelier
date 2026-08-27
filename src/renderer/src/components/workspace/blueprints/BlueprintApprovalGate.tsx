import { useState, useEffect, useRef, type JSX } from 'react'
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
  BarChart3,
  RefreshCw,
  Terminal,
  Key,
  Globe,
  FileText
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { GATE_ICON } from './phase-icons'
import { stripBlueprintBlocks } from '../../../../../shared/blueprint-clarify-parsers'

// ── Types ──

/** Single preflight check result. */
interface PreflightCheckUI {
  id: string
  name: string
  kind: string // 'cli-tool' | 'env-var' | 'service'
  status: string // 'pass' | 'warn' | 'blocker'
  message: string
  remediation?: string
  sources: string[]
}

interface PreflightResultUI {
  checks: PreflightCheckUI[]
  ranAt: string
  hasBlockers: boolean
  hasWarnings: boolean
}

interface PreflightDataUI {
  result: PreflightResultUI
  overridden: boolean
}

interface BlueprintApprovalGateProps {
  /** Needed to run the revision loop directly against the main process. */
  blueprintId: string
  planSummary: string
  /** Structured phase completion metrics (coverage, findings, recommendation, etc.) */
  completion?: Record<string, unknown>
  /** Full review report markdown (detailed findings, gaps, risks) */
  reviewMarkdown?: string
  /**
   * The revised plan from the last revision turn. Rendered under its own
   * heading — a plan shown as a review report claims a review it has not had.
   */
  revisedPlanMarkdown?: string
  /** Preflight check results (environment validation). */
  preflight?: PreflightDataUI
  /** Callback to re-run preflight checks. */
  onRerunPreflight?: () => void
  onApprove: () => void
  /** Hard reject — rewinds the pipeline to PLAN. Feedback is still recorded. */
  onReject: (feedback: string) => void
  onCancel: () => void
}

/** One entry in the revision ledger, as returned by the main process. */
interface RevisionRequestUI {
  round: number
  at: string
  phase: string
  feedback: string
  disposition: 'revised' | 'rewound'
  /** The text was longer than the per-request cap and was cut before storing. */
  truncated?: boolean
}

/** How often to re-check a turn started by a previous mount of this gate. */
const REVISION_POLL_MS = 3000

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
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`}
    >
      {count} {label}
    </span>
  )
}

// ── Main Component ──

// ── Preflight Check Row ──

function PreflightCheckRow({ check }: { check: PreflightCheckUI }): JSX.Element {
  const statusConfig = {
    pass: { icon: CheckCircle, color: 'text-success', bg: 'bg-success/10', label: 'Pass' },
    warn: { icon: AlertTriangle, color: 'text-warning', bg: 'bg-warning/10', label: 'Warning' },
    blocker: { icon: AlertCircle, color: 'text-danger', bg: 'bg-danger/10', label: 'Blocker' }
  }
  const config = statusConfig[check.status as keyof typeof statusConfig] ?? statusConfig.warn
  const StatusIcon = config.icon

  const kindIcon = check.kind === 'cli-tool' ? Terminal : check.kind === 'env-var' ? Key : Globe
  const KindIcon = kindIcon

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded-lg ${config.bg} border border-transparent`}
    >
      <StatusIcon size={14} className={`${config.color} mt-0.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <KindIcon size={11} className="text-text-muted" />
          <span className="text-xs font-medium text-text-primary truncate">{check.name}</span>
          <span
            className={`text-[10px] px-1.5 py-0 rounded-full border ${config.bg} ${config.color} font-medium`}
          >
            {config.label}
          </span>
        </div>
        <p className="text-[11px] text-text-secondary mt-0.5">{check.message}</p>
        {check.remediation && check.status !== 'pass' && (
          <p className="text-[11px] text-text-muted mt-0.5 italic">💡 {check.remediation}</p>
        )}
      </div>
    </div>
  )
}

export default function BlueprintApprovalGate({
  blueprintId,
  planSummary,
  completion,
  reviewMarkdown,
  revisedPlanMarkdown,
  preflight,
  onRerunPreflight,
  onApprove,
  onReject,
  onCancel
}: BlueprintApprovalGateProps): JSX.Element {
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  // ── Revision loop state ──
  const [history, setHistory] = useState<RevisionRequestUI[]>([])
  const [revising, setRevising] = useState(false)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [lastRevision, setLastRevision] = useState<{
    summary: string
    changes: string[]
    concerns: string[]
  } | null>(null)
  const [accepting, setAccepting] = useState(false)

  // Load the ledger once per gate. Rounds survive restarts, so a reopened gate
  // must show what was already asked — otherwise the human retypes feedback the
  // agent has already acted on.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  if (loadedFor !== blueprintId) {
    setLoadedFor(blueprintId)
    void window.api
      .blueprintPlanReviseHistory({ blueprintId })
      .then((r) => {
        setHistory(r.requests as RevisionRequestUI[])
        setRevising(r.revising)
      })
      .catch(() => {
        /* the gate still works without history */
      })
  }

  // A turn started before this mount (or before a reload) leaves `revising`
  // true with nothing local to resolve it, which would disable the send button
  // forever. Poll the main process until it says the turn is done.
  const ownTurn = useRef(false)
  useEffect(() => {
    if (!revising || ownTurn.current) return
    const id = setInterval(() => {
      void window.api
        .blueprintPlanReviseHistory({ blueprintId })
        .then((r) => {
          setHistory(r.requests as RevisionRequestUI[])
          if (!r.revising) setRevising(false)
        })
        .catch(() => {
          /* transient — the next tick tries again */
        })
    }, REVISION_POLL_MS)
    return () => clearInterval(id)
  }, [revising, blueprintId])

  const sendRevision = async (): Promise<void> => {
    const text = feedback.trim()
    if (!text || revising) return
    ownTurn.current = true
    setRevising(true)
    setRevisionError(null)
    try {
      const res = await window.api.blueprintPlanReviseSend({ blueprintId, feedback: text })
      const fresh = await window.api.blueprintPlanReviseHistory({ blueprintId })
      setHistory(fresh.requests as RevisionRequestUI[])
      if (res.ok) {
        setLastRevision({
          summary: res.revision.summary,
          changes: res.revision.changes,
          concerns: res.revision.concerns
        })
        setFeedback('')
        setShowFeedback(false)
      } else {
        // Not a lost message — the ledger kept it. Say so precisely.
        setRevisionError(res.error)
      }
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRevising(false)
      ownTurn.current = false
    }
  }

  const acceptRevision = async (): Promise<void> => {
    setAccepting(true)
    setRevisionError(null)
    try {
      const res = await window.api.blueprintPlanReviseAccept({ blueprintId })
      // On success the gate is dismissed by the snapshot, so `accepting` stays
      // true until this card unmounts. A refusal has no such signal — clear it
      // here or the button spins forever on a gate that is going nowhere.
      if (!res.accepted) {
        setRevisionError(res.error ?? 'Could not accept the revision.')
        setAccepting(false)
      }
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : String(err))
      setAccepting(false)
    }
  }
  const [reportExpanded, setReportExpanded] = useState(false)
  const [revisedPlanExpanded, setRevisedPlanExpanded] = useState(false)
  // D13: default expanded only when there are issues (reduces noise for all-pass)
  const [preflightExpanded, setPreflightExpanded] = useState(
    () => !!(preflight?.result.hasBlockers || preflight?.result.hasWarnings)
  )

  // R3-3 fix: auto-expand when a re-run introduces blockers.
  // Uses React's "adjust state during render" pattern instead of useEffect
  // to avoid the react-hooks/set-state-in-effect lint error.
  const [lastPreflightRanAt, setLastPreflightRanAt] = useState(preflight?.result.ranAt)
  if (preflight?.result.ranAt !== lastPreflightRanAt) {
    setLastPreflightRanAt(preflight?.result.ranAt)
    if (preflight?.result.hasBlockers) setPreflightExpanded(true)
  }

  // Extract structured metrics from completion
  const findings = completion?.findings as
    { critical?: number; high?: number; medium?: number; low?: number } | undefined
  const recommendation = (completion?.recommendation as string) ?? null
  const coveragePercent = completion?.coveragePercent as number | undefined
  const requirementsWithTasks = completion?.requirementsWithTasks as number | undefined
  const totalRequirements = completion?.totalRequirements as number | undefined
  const unmappedTasks = completion?.unmappedTasks as number | undefined
  const constitutionViolations = completion?.constitutionViolations as number | undefined

  const hasStructuredData = !!completion
  const hasReport = !!reviewMarkdown
  const hasRevisedPlan = !!revisedPlanMarkdown

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

      {/* ── Post-revision state ──
          The revision turn drops `completion` on purpose: coverage and finding
          counts describe a review of the plan that just changed. Say what is
          actually true instead of re-showing them. */}
      {hasRevisedPlan && !hasStructuredData && (
        <div
          className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 px-3 py-2"
          data-testid="blueprint-revision-pending-banner"
        >
          <RefreshCw size={13} className="text-info flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-text-secondary">
            <span className="font-medium text-text-primary">Plan revised — re-review pending.</span>{' '}
            Coverage and findings from the previous review no longer describe this plan. Accept to
            re-derive tasks and re-run the review against it.
          </p>
        </div>
      )}

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
                <span
                  className={`text-sm font-semibold ${coveragePercent >= 80 ? 'text-success' : coveragePercent >= 50 ? 'text-warning' : 'text-danger'}`}
                >
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
                <span className="text-xs text-text-secondary">{unmappedTasks} unmapped tasks</span>
              </div>
            )}

            {/* Constitution violations */}
            {constitutionViolations !== undefined && constitutionViolations > 0 && (
              <div className="flex items-center gap-1.5">
                <Shield size={14} className="text-danger" />
                <span className="text-xs text-danger font-medium">
                  {constitutionViolations} constitution violation
                  {constitutionViolations > 1 ? 's' : ''}
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
          {recommendation &&
            (() => {
              const style = getRecommendationStyle(recommendation)
              const label = getRecommendationLabel(recommendation)
              const RecIcon =
                recommendation === 'proceed'
                  ? CheckCircle
                  : recommendation === 'fix_critical'
                    ? AlertTriangle
                    : AlertCircle
              return (
                <div
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border ${style.bg} ${style.text} ${style.border}`}
                >
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
            {/* After a revision the report describes the plan that was replaced,
                so it is labelled as such rather than as a review of what is on
                screen — its findings still matter, but they are not current. */}
            <span className="text-xs font-semibold text-text-primary">
              {hasRevisedPlan ? 'Review of the pre-revision plan' : 'Full Review Report'}
            </span>
            <span className="text-[10px] text-text-muted ml-auto">
              {reportExpanded ? 'Collapse' : 'Expand to see detailed findings, gaps, and risks'}
            </span>
          </button>
          {reportExpanded && (
            <div className="bg-surface-base border-t border-border-subtle p-3 max-h-96 overflow-y-auto">
              <div
                className="prose prose-sm max-w-none text-text-body
                prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
                prose-p:leading-relaxed prose-p:text-sm
                prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
                prose-strong:text-text-primary prose-strong:font-semibold
                prose-li:text-sm prose-li:text-text-body
              "
              >
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {stripBlueprintBlocks(reviewMarkdown!)}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Revised Plan (collapsible markdown) ── */}
      {hasRevisedPlan && (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <button
            type="button"
            onClick={() => setRevisedPlanExpanded(!revisedPlanExpanded)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay hover:bg-surface-hover/50 transition-colors text-left"
          >
            {revisedPlanExpanded ? (
              <ChevronDown size={14} className="text-text-muted" />
            ) : (
              <ChevronRight size={14} className="text-text-muted" />
            )}
            <FileText size={14} className="text-info" />
            <span className="text-xs font-semibold text-text-primary">Revised Plan</span>
            <span className="text-[10px] text-text-muted ml-auto">
              {revisedPlanExpanded ? 'Collapse' : 'Expand to read the plan you are approving'}
            </span>
          </button>
          {revisedPlanExpanded && (
            <div className="bg-surface-base border-t border-border-subtle p-3 max-h-96 overflow-y-auto">
              <div
                className="prose prose-sm max-w-none text-text-body
                prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
                prose-p:leading-relaxed prose-p:text-sm
                prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
                prose-strong:text-text-primary prose-strong:font-semibold
                prose-li:text-sm prose-li:text-text-body
              "
              >
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {stripBlueprintBlocks(revisedPlanMarkdown!)}
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
          <div
            className="prose prose-sm max-w-none text-text-body
            prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
            prose-p:leading-relaxed prose-p:text-sm
            prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
            prose-strong:text-text-primary prose-strong:font-semibold
            prose-li:text-sm prose-li:text-text-body
          "
          >
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {stripBlueprintBlocks(planSummary)}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* ── Environment Preflight Checks ── */}
      {preflight && preflight.result.checks.length > 0 && (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          {/* A4 fix: header is a div with two sibling buttons — no nested <button> */}
          <div className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay">
            <button
              type="button"
              onClick={() => setPreflightExpanded(!preflightExpanded)}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left flex-1 min-w-0"
              aria-expanded={preflightExpanded}
              aria-label="Toggle environment checks"
            >
              {preflightExpanded ? (
                <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
              )}
              <Terminal
                size={14}
                className={`flex-shrink-0 ${preflight.result.hasBlockers ? 'text-danger' : preflight.result.hasWarnings ? 'text-warning' : 'text-success'}`}
              />
              <span className="text-xs font-semibold text-text-primary">Environment Checks</span>
              <span className="text-[10px] text-text-muted ml-1">
                {preflight.result.checks.filter((c) => c.status === 'pass').length} pass
                {preflight.result.checks.filter((c) => c.status === 'warn').length > 0 && (
                  <>, {preflight.result.checks.filter((c) => c.status === 'warn').length} warn</>
                )}
                {preflight.result.checks.filter((c) => c.status === 'blocker').length > 0 && (
                  <>
                    ,{' '}
                    <span className="text-danger font-medium">
                      {preflight.result.checks.filter((c) => c.status === 'blocker').length} blocker
                      {preflight.result.checks.filter((c) => c.status === 'blocker').length > 1
                        ? 's'
                        : ''}
                    </span>
                  </>
                )}
              </span>
            </button>
            {onRerunPreflight && (
              <button
                type="button"
                onClick={onRerunPreflight}
                className="ml-auto flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors flex-shrink-0"
                title="Re-run environment checks"
              >
                <RefreshCw size={11} />
                Re-run
              </button>
            )}
          </div>
          {preflightExpanded && (
            <div className="bg-surface-base border-t border-border-subtle p-2 space-y-1 max-h-64 overflow-y-auto">
              {preflight.result.checks.map((check) => (
                <PreflightCheckRow key={check.id} check={check} />
              ))}
              <p className="text-[10px] text-text-muted pt-1 px-3">
                Checked at {new Date(preflight.result.ranAt).toLocaleTimeString()}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Revision transcript — what has already been asked, and what became of it */}
      {history.length > 0 && (
        <div className="space-y-2" data-testid="blueprint-revision-history">
          <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Change requests ({history.length})
          </h4>
          {history.map((r) => (
            <div
              key={`${r.round}-${r.at}`}
              className="rounded-lg border border-border-subtle bg-surface-base px-3 py-2"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-semibold text-text-muted">Round {r.round}</span>
                <span
                  className={`text-[10px] px-1.5 py-0 rounded-full border ${
                    r.disposition === 'revised'
                      ? 'bg-success/10 text-success border-success/30'
                      : 'bg-warning/10 text-warning border-warning/30'
                  }`}
                  title={
                    r.disposition === 'revised'
                      ? 'The plan was revised in place from this request'
                      : 'Saved — will be applied on the next full run of the plan'
                  }
                >
                  {r.disposition === 'revised' ? 'Applied' : 'Queued'}
                </span>
                <span className="text-[10px] text-text-muted ml-auto">
                  {new Date(r.at).toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap">{r.feedback}</p>
              {r.truncated && (
                <p className="text-[10px] text-warning mt-1">
                  Trimmed to fit — the agent saw only the text shown above.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Outcome of the most recent revision turn */}
      {lastRevision && (
        <div
          className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 space-y-1"
          data-testid="blueprint-revision-result"
        >
          <p className="text-xs text-text-primary font-medium">
            Plan revised — {lastRevision.summary || 'see the report above'}
          </p>
          {lastRevision.changes.length > 0 && (
            <ul className="text-[11px] text-text-secondary list-disc list-inside">
              {lastRevision.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {lastRevision.concerns.length > 0 && (
            <div className="pt-1">
              <p className="text-[11px] font-medium text-warning">Agent pushed back:</p>
              <ul className="text-[11px] text-text-secondary list-disc list-inside">
                {lastRevision.concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-text-muted pt-1">
            Keep iterating, or accept to re-derive tasks and re-review against this plan.
          </p>
        </div>
      )}

      {/* A turn that could not run. The text was still saved — say so. */}
      {revisionError && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
          <AlertTriangle size={13} className="text-warning flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-text-secondary">{revisionError}</p>
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
            disabled={revising}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-info resize-none disabled:opacity-60"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowFeedback(false)}
              disabled={revising}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            {/* Full rewind stays available and stays explicit — it costs a full
                plan → tasks → review cycle, so it should never be the accident. */}
            <button
              type="button"
              onClick={() => feedback.trim() && onReject(feedback.trim())}
              disabled={!feedback.trim() || revising}
              title="Discard this plan and re-plan from scratch with your feedback (slow — re-runs plan, tasks and review)"
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border-subtle rounded-lg transition-colors disabled:opacity-50"
            >
              Re-plan from scratch
            </button>
            <button
              type="button"
              onClick={() => void sendRevision()}
              disabled={!feedback.trim() || revising}
              data-testid="blueprint-revision-send"
              title="Revise this plan in place — the agent keeps its current context"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors disabled:opacity-50"
            >
              {revising ? (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  Revising…
                </>
              ) : (
                'Send & Revise Plan'
              )}
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
            disabled={revising || accepting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-lg transition-colors disabled:opacity-50"
          >
            <MessageSquare size={14} />
            Request Changes
          </button>
          {/* Only offered once a revision actually landed — re-deriving against an
              unchanged plan is pure cost. `revisedPlanMarkdown` comes from the
              snapshot, so the offer survives a reload; `lastRevision` alone is
              local state and would strand a reloaded user with no way to accept. */}
          {(lastRevision || hasRevisedPlan) && (
            <button
              type="button"
              onClick={() => void acceptRevision()}
              disabled={accepting || revising}
              data-testid="blueprint-revision-accept"
              title="Re-run tasks and review against the revised plan (the plan phase is not re-run)"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-primary bg-surface-base hover:bg-surface-hover border border-info/40 rounded-lg transition-colors disabled:opacity-50"
            >
              {accepting ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <CheckCircle size={14} />
              )}
              Accept & Re-derive Tasks
            </button>
          )}
          <button
            type="button"
            onClick={onApprove}
            disabled={revising || accepting}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 ${
              preflight?.result.hasBlockers
                ? 'bg-warning hover:bg-warning/80'
                : 'bg-success hover:bg-success/80'
            }`}
          >
            {preflight?.result.hasBlockers ? (
              <>
                <AlertTriangle size={14} />
                Build Anyway
              </>
            ) : (
              <>
                <CheckCircle size={14} />
                Approve & Build
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

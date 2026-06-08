import { useEffect, useMemo, useState } from 'react'
import { Zap, X, ArrowUp, ArrowDown } from 'lucide-react'
import type { WorkspaceUsageSummary } from '../../../../shared/types'
import Skeleton from './Skeleton'

interface TokenDetailsModalProps {
  isOpen: boolean
  /** Workspace whose unified usage is shown (null when none active). */
  workspaceId: string | null
  /** Current context window size (point-in-time, from SDK getContextUsage) */
  contextWindowTokens: number
  /** Live output token count from agent.store */
  liveOutputTokens: number
  onClose: () => void
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function fmtCost(cents: number): string {
  if (cents === 0) return '$0.00'
  return `$${(cents / 100).toFixed(2)}`
}

/** Human-friendly labels for the usage_log feature buckets. */
const FEATURE_LABELS: Record<string, string> = {
  chat: 'Chat',
  grill: 'Grill',
  grill_plan: 'Grill — plan',
  council: 'Council',
  council_peer_review: 'Council — peer review',
  mpa: 'Goals (MPA)',
  audit: 'Audit',
  audit_plan: 'Audit — plan',
  audit_recovery: 'Audit — recovery',
  condense: 'Condense',
  goal_decompose: 'Goal decomposition',
  claude_md: 'CLAUDE.md generation',
  specialist_build: 'Specialist build',
  skill_enrich: 'Skill enrichment',
  skill_recommend: 'Skill recommendations',
  commit_message: 'Commit message',
  recovery_nudge: 'Recovery nudge',
  plan_recovery: 'Plan recovery'
}

function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature.replace(/_/g, ' ')
}

export default function TokenDetailsModal({
  isOpen,
  workspaceId,
  contextWindowTokens,
  liveOutputTokens,
  onClose
}: TokenDetailsModalProps): React.JSX.Element | null {
  const [summary, setSummary] = useState<WorkspaceUsageSummary | null>(null)
  const [globalSummary, setGlobalSummary] = useState<WorkspaceUsageSummary | null>(null)
  const [loading, setLoading] = useState(false)

  // Load unified workspace usage breakdown when opened. The render path gates on
  // `workspaceId`, so stale summary from a previous workspace is never shown.
  useEffect(() => {
    if (!isOpen || !workspaceId) return
    let cancelled = false
    setLoading(true)
    window.api
      .getWorkspaceUsageSummary({ workspaceId })
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch((err) => {
        console.warn('[TokenDetailsModal] Non-fatal: usage summary load failed:', err)
        if (!cancelled) setSummary(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, workspaceId])

  // Load global (all-workspaces) usage breakdown when opened.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    window.api
      .getGlobalUsageSummary()
      .then((data) => {
        if (!cancelled) setGlobalSummary(data)
      })
      .catch((err) => {
        console.warn('[TokenDetailsModal] Non-fatal: global usage summary load failed:', err)
        if (!cancelled) setGlobalSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  // Esc to close
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Claude API token fields are non-overlapping:
  // input = uncached input, cacheRead = served from cache, cacheCreation = written to cache.
  // Cache hit % = cacheRead / (input + cacheRead + cacheCreation).
  const cacheHitPercent = useMemo(() => {
    if (!summary) return null
    const totalInput = summary.totalInput + summary.totalCacheRead + summary.totalCacheCreation
    if (totalInput === 0) return null
    return Math.round((summary.totalCacheRead / totalInput) * 100)
  }, [summary])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(15,21,23,0.85)] backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-surface-float border border-border-default rounded-lg shadow-2xl max-w-md w-full mx-4 animate-in fade-in zoom-in-95 max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Zap size={18} className="text-primary" />
            </div>
            <div>
              <h3 id="token-dialog-title" className="text-base font-semibold text-text-primary">
                Workspace Token Usage
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                Token consumption across this workspace, by feature
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Live counters card */}
        <div className="px-5 pb-4">
          <div className="rounded-lg border border-border-default bg-surface-overlay p-4 space-y-3">
            <div className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">
              Live session counters
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <ArrowUp size={14} className="text-sky-400 flex-shrink-0" />
                <div>
                  <div className="text-lg font-semibold text-text-primary tabular-nums">
                    {fmtTokens(contextWindowTokens)}
                  </div>
                  <div className="text-[10px] text-text-muted">Context window</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ArrowDown size={14} className="text-emerald-400 flex-shrink-0" />
                <div>
                  <div className="text-lg font-semibold text-text-primary tabular-nums">
                    {fmtTokens(liveOutputTokens)}
                  </div>
                  <div className="text-[10px] text-text-muted">Output tokens</div>
                </div>
              </div>
            </div>
            <div className="border-t border-border-subtle pt-2 flex justify-between items-center text-xs text-text-secondary">
              <span>
                {cacheHitPercent !== null && (
                  <span className="px-1 py-0.5 rounded bg-success/10 text-success text-[10px]">
                    Cache: {cacheHitPercent}% hit
                  </span>
                )}
              </span>
              <span className="font-mono tabular-nums text-text-muted text-[10px]">
                Updates live across all features
              </span>
            </div>
          </div>
        </div>

        {/* Workspace usage by feature */}
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">
              Workspace usage by feature
            </div>
            {summary && (
              <div className="text-[10px] text-text-muted font-mono tabular-nums">
                {fmtTokens(summary.totalTokens)} · {fmtCost(summary.totalCostCents)}
              </div>
            )}
          </div>

          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {!loading && workspaceId && summary && summary.byFeature.length > 0 && (
            <div className="text-[11px] text-text-secondary space-y-1.5">
              {summary.byFeature.map((f) => (
                <div key={f.feature} className="flex justify-between items-center py-0.5">
                  <span>
                    {featureLabel(f.feature)}
                    <span className="text-text-muted ml-1">
                      ({f.calls} call{f.calls !== 1 ? 's' : ''})
                    </span>
                  </span>
                  <span className="font-mono tabular-nums">
                    {fmtTokens(f.tokens)}
                    <span className="text-text-muted ml-1">{fmtCost(f.costCents)}</span>
                  </span>
                </div>
              ))}

              {/* Estimated total cost */}
              <div className="mt-3 pt-2 border-t border-border-subtle flex justify-between items-center text-text-primary font-medium">
                <span>Estimated total</span>
                <span className="font-mono tabular-nums">
                  {fmtTokens(summary.totalTokens)}
                  <span className="text-text-secondary ml-1">
                    {fmtCost(summary.totalCostCents)}
                  </span>
                </span>
              </div>

              {/* Global (all workspaces) */}
              {globalSummary && (
                <div className="flex justify-between items-center text-[11px] text-text-muted">
                  <span>Global (all workspaces)</span>
                  <span className="font-mono tabular-nums">
                    {fmtTokens(globalSummary.totalTokens)}
                    <span className="ml-1">{fmtCost(globalSummary.totalCostCents)}</span>
                  </span>
                </div>
              )}
            </div>
          )}

          {!loading && workspaceId && summary && summary.byFeature.length === 0 && (
            <p className="text-[11px] text-text-muted">
              No token usage recorded for this workspace yet.
            </p>
          )}

          {!loading && !workspaceId && (
            <p className="text-[11px] text-text-muted">
              No active workspace — open one to see token usage.
            </p>
          )}
        </div>

        {/* Explanation footnote */}
        <div className="px-5 pb-4">
          <p className="text-[10px] text-text-muted leading-snug">
            Context window shows the current model context size. The breakdown aggregates every
            feature in this workspace (chat, grill, council, goals, audit, and background ops).
            Costs are estimated from token counts and model pricing.
          </p>
        </div>

        {/* Close button */}
        <div className="px-5 pb-5 pt-1 text-center">
          <button
            onClick={onClose}
            className="text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

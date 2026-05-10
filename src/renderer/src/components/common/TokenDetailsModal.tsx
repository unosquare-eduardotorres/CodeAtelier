import { useEffect, useMemo, useState } from 'react'
import { Zap, X, ArrowUp, ArrowDown } from 'lucide-react'
import type { TokenSummary } from '../../../../shared/types'
import Skeleton from './Skeleton'

interface TokenDetailsModalProps {
  isOpen: boolean
  conversationId: string | null
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

export default function TokenDetailsModal({
  isOpen,
  conversationId,
  contextWindowTokens,
  liveOutputTokens,
  onClose
}: TokenDetailsModalProps): React.JSX.Element | null {
  const [summary, setSummary] = useState<TokenSummary | null>(null)
  const [loading, setLoading] = useState(false)

  // Load persisted breakdown when opened
  useEffect(() => {
    if (!isOpen || !conversationId) {
      setSummary(null)
      return
    }
    let cancelled = false
    setLoading(true)
    window.api
      .getConversationTokenSummary({ conversationId })
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, conversationId])

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
  // input_tokens = uncached input, cache_read = served from cache, cache_creation = written to cache.
  // Total context = input + cacheRead + cacheCreation. Cache hit % = cacheRead / total.
  const cacheHitPercent = useMemo(() => {
    if (!summary) return null
    const totalInput =
      summary.totalInputTokens + summary.totalCacheReadTokens + summary.totalCacheCreationTokens
    if (totalInput === 0) return null
    return Math.round((summary.totalCacheReadTokens / totalInput) * 100)
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
                Session Token Usage
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                Input / output breakdown for this session
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
                {summary && summary.totalTurns > 0 && <>Turns: {summary.totalTurns} · </>}
                {cacheHitPercent !== null && (
                  <span className="ml-2 px-1 py-0.5 rounded bg-success/10 text-success text-[10px]">
                    Cache: {cacheHitPercent}% hit
                  </span>
                )}
              </span>
              <span className="font-mono tabular-nums text-text-muted text-[10px]">
                Claude Max — no per-token billing
              </span>
            </div>
          </div>
        </div>

        {/* Persisted breakdown */}
        <div className="px-5 pb-4">
          <div className="text-[10px] uppercase tracking-wide text-text-muted mb-2 font-semibold">
            Persisted conversation breakdown
          </div>

          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {!loading && summary && (
            <div className="text-[11px] text-text-secondary space-y-1.5">
              {/* Context tokens — total context processed across all turns */}
              {summary.totalContextTokens > 0 && (
                <div className="flex justify-between">
                  <span>Total context processed</span>
                  <span className="font-mono tabular-nums">
                    {fmtTokens(summary.totalContextTokens)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className={summary.totalContextTokens > 0 ? 'pl-3' : ''}>Uncached input</span>
                <span className="font-mono tabular-nums">
                  {fmtTokens(summary.totalInputTokens)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className={summary.totalContextTokens > 0 ? 'pl-3' : ''}>
                  Cache read
                  {cacheHitPercent !== null && (
                    <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-success/10 text-success">
                      {cacheHitPercent}% hit
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums">
                  {fmtTokens(summary.totalCacheReadTokens)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className={summary.totalContextTokens > 0 ? 'pl-3' : ''}>Cache creation</span>
                <span className="font-mono tabular-nums">
                  {fmtTokens(summary.totalCacheCreationTokens)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Total output</span>
                <span className="font-mono tabular-nums">
                  {fmtTokens(summary.totalOutputTokens)}
                </span>
              </div>
              <div className="flex justify-between text-text-muted">
                <span>Turns</span>
                <span className="font-mono tabular-nums">{summary.totalTurns}</span>
              </div>

              {/* Per-agent breakdown */}
              {summary.byAgent && summary.byAgent.length > 0 && (
                <div className="mt-3 pt-2 border-t border-border-subtle">
                  <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5 font-semibold">
                    By agent
                  </div>
                  {summary.byAgent.map((agent) => (
                    <div key={agent.agentType} className="flex justify-between items-center py-0.5">
                      <span className="capitalize">{agent.agentType.replace('-', ' ')}</span>
                      <span className="font-mono tabular-nums">
                        {fmtTokens(agent.totalTokens)}
                        <span className="text-text-muted ml-1">
                          ({agent.sessionCount} turn{agent.sessionCount !== 1 ? 's' : ''})
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!loading && !summary && conversationId && (
            <p className="text-[11px] text-text-muted">
              No token data available for this conversation.
            </p>
          )}

          {!conversationId && (
            <p className="text-[11px] text-text-muted">
              No active conversation — start a chat to see token breakdown.
            </p>
          )}
        </div>

        {/* Explanation footnote */}
        <div className="px-5 pb-4">
          <p className="text-[10px] text-text-muted leading-snug">
            Context window shows the current model context size. Cached input tokens are served from
            prompt cache at ~90% discount. Persisted breakdown shows per-turn API-reported values.
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

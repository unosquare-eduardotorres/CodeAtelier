import { Database } from 'lucide-react'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toString()
}

interface TurnBreakdown {
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  timestamp: number
}

interface CacheEfficiencyData {
  hitRate: number
  savedTokens: number
  totalInput: number
  turns: number
  turnBreakdown: TurnBreakdown[]
}

/**
 * Cache efficiency panel: summary stats grid + per-turn breakdown bars.
 * Extracted from TokenUsagePage.
 */
export default function CacheEfficiencyPanel({
  cacheEfficiency,
  cacheReadTokens,
  cacheCreationTokens,
  cacheHitRate
}: {
  cacheEfficiency: CacheEfficiencyData | null
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
}): React.JSX.Element | null {
  // Prompt Cache Performance (aggregate)
  const showCachePerf = cacheReadTokens > 0 || cacheCreationTokens > 0

  return (
    <>
      {showCachePerf && (
        <div className="bg-surface-overlay border border-border-subtle rounded-lg p-4 shadow-sm mb-4">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <Database size={12} />
            Prompt Cache Performance
          </div>
          <div className="flex items-center gap-6">
            <div>
              <div className="text-2xl font-display font-normal text-text-primary">
                {cacheHitRate.toFixed(1)}%
              </div>
              <div className="text-xs text-text-secondary mt-0.5">Cache Hit Rate</div>
            </div>
            <div className="h-8 w-px bg-border-subtle" />
            <div>
              <div className="text-sm font-mono text-text-body">
                {formatTokens(cacheReadTokens)}
              </div>
              <div className="text-xs text-text-secondary mt-0.5">Cache Reads</div>
            </div>
            <div>
              <div className="text-sm font-mono text-text-body">
                {formatTokens(cacheCreationTokens)}
              </div>
              <div className="text-xs text-text-secondary mt-0.5">Cache Writes</div>
            </div>
          </div>
        </div>
      )}

      {/* Per-session cache efficiency */}
      {cacheEfficiency && cacheEfficiency.turns > 0 && (
        <section className="mb-8">
          <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium mb-3">
            Cache Efficiency
          </h3>
          <div className="bg-surface-overlay border border-border-subtle rounded-lg p-4 space-y-4">
            {/* Summary stats row */}
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-lg font-semibold text-primary">
                  {cacheEfficiency.hitRate.toFixed(1)}%
                </p>
                <p className="text-xs text-text-secondary">Cache Hit Rate</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">
                  {formatTokens(cacheEfficiency.savedTokens)}
                </p>
                <p className="text-xs text-text-secondary">Tokens Saved</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-text-body">{cacheEfficiency.turns}</p>
                <p className="text-xs text-text-secondary">Turns Tracked</p>
              </div>
            </div>

            {/* Per-turn breakdown bars */}
            {cacheEfficiency.turnBreakdown.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-text-secondary font-medium">Per-Turn Token Breakdown</p>
                {cacheEfficiency.turnBreakdown.map((t) => {
                  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens
                  if (total === 0) return null
                  return (
                    <div key={t.turn} className="flex items-center gap-2 text-xs">
                      <span className="w-8 text-text-muted text-right">T{t.turn}</span>
                      <div className="flex-1 flex h-4 rounded overflow-hidden bg-surface-base">
                        <div
                          className="bg-primary/60"
                          style={{ width: `${(t.inputTokens / total) * 100}%` }}
                          title={`Input: ${formatTokens(t.inputTokens)}`}
                        />
                        <div
                          className="bg-success/60"
                          style={{ width: `${(t.cacheReadTokens / total) * 100}%` }}
                          title={`Cache read: ${formatTokens(t.cacheReadTokens)}`}
                        />
                        <div
                          className="bg-warning/60"
                          style={{ width: `${(t.outputTokens / total) * 100}%` }}
                          title={`Output: ${formatTokens(t.outputTokens)}`}
                        />
                      </div>
                      <span className="w-12 text-text-muted text-right">
                        {t.cacheHitRate.toFixed(0)}%
                      </span>
                    </div>
                  )
                })}
                {/* Legend */}
                <div className="flex gap-4 mt-1 text-[10px] text-text-muted">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded bg-primary/60" /> Input
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded bg-success/60" /> Cache
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded bg-warning/60" /> Output
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  )
}

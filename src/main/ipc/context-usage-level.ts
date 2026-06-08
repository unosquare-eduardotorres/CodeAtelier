import type { ContextUsageLevel } from '../../shared/types'

/**
 * Resolve the UI context-usage `level` (badge/bar colour) and `qualityLevel`
 * (modal label) from RAW context-window usage.
 *
 * Thresholds align with the compaction trigger points in
 * agent-stream-processor (`computeCompactThresholds`): warning = 56%/48%,
 * suggest = 70%/60%, auto = 85%/75% (large >200K / small ≤200K windows).
 *
 * The previous implementation scored quality against a separate "quality
 * window" capped at 500K (50% of the real window). On a 1M-context model that
 * cap meant a fresh session at ~42% real usage reported 83% → "Low" + a red
 * bar, even though it was nowhere near any compaction threshold. Basing the
 * level on raw usage makes the colour reflect actual context pressure.
 */
export function resolveContextLevel(
  percentage: number,
  contextWindow: number
): { level: ContextUsageLevel; qualityLevel: 'excellent' | 'good' | 'moderate' | 'low' } {
  const isSmallWindow = contextWindow <= 200_000
  const warnPct = isSmallWindow ? 48 : 56
  const suggestPct = isSmallWindow ? 60 : 70
  const autoPct = isSmallWindow ? 75 : 85

  const level: ContextUsageLevel =
    percentage >= autoPct
      ? 'critical'
      : percentage >= suggestPct
        ? 'red'
        : percentage >= warnPct
          ? 'yellow'
          : 'green'
  const qualityLevel: 'excellent' | 'good' | 'moderate' | 'low' =
    percentage < warnPct
      ? 'excellent'
      : percentage < suggestPct
        ? 'good'
        : percentage < autoPct
          ? 'moderate'
          : 'low'
  return { level, qualityLevel }
}

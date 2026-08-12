import type { ContextUsageLevel } from '../../shared/types'
import { COMPACTION_RATIOS } from '../../shared/constants'

/**
 * Resolve the UI context-usage `level` (badge/bar colour) and `qualityLevel`
 * (modal label) from RAW context-window usage.
 *
 * Thresholds come from COMPACTION_RATIOS and align with the compaction trigger
 * points in compaction-policy (`resolveCompactionThresholds`): warning = 48%,
 * suggest = 60%, auto = 75% — uniform for every window size.
 *
 * The previous implementation scored quality against a separate "quality
 * window" capped at 500K (50% of the real window). On a 1M-context model that
 * cap meant a fresh session at ~42% real usage reported 83% → "Low" + a red
 * bar, even though it was nowhere near any compaction threshold. Basing the
 * level on raw usage makes the colour reflect actual context pressure.
 */
export function resolveContextLevel(
  percentage: number,
  /** Advisory only — the bands are window-size independent. Kept for call-site compatibility. */
  _contextWindow: number
): { level: ContextUsageLevel; qualityLevel: 'excellent' | 'good' | 'moderate' | 'low' } {
  const warnPct = COMPACTION_RATIOS.warn * 100 // 48
  const suggestPct = COMPACTION_RATIOS.suggest * 100 // 60
  const autoPct = COMPACTION_RATIOS.auto * 100 // 75

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

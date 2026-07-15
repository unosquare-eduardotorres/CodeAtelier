/**
 * Shared constants for memory graph components (GraphView, FilterPopover).
 */

import type { MemoryFactCategory } from '../../../../../shared/types'

/** Category → CSS custom property mapping */
export const CATEGORY_COLOR_VAR: Record<MemoryFactCategory, string> = {
  decision: '--color-info',
  convention: '--color-success',
  gotcha: '--color-mode-build-text',
  preference: '--color-mode-plan-text',
  reference: '--color-text-muted'
}

/** Human-readable tier labels */
export const TIER_LABELS = ['T0 Observed', 'T1 Confirmed', 'T2 Established', 'T3 Wisdom'] as const

/** All valid tier numbers */
export const ALL_TIERS = [0, 1, 2, 3] as const

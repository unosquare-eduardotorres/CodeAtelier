/**
 * Shared constants for memory graph components (GraphView, FilterPopover).
 */

import type { MemoryFactCategory } from '../../../../../shared/types'

/** Category → neon CSS custom property mapping (graph-scoped palette) */
export const CATEGORY_COLOR_VAR: Record<MemoryFactCategory, string> = {
  decision: '--graph-node-decision',
  convention: '--graph-node-convention',
  gotcha: '--graph-node-gotcha',
  preference: '--graph-node-preference',
  reference: '--graph-node-reference'
}

/** Edge kind → neon CSS custom property mapping */
export const EDGE_COLOR_VAR = {
  similarity: '--graph-link',
  superseded: '--graph-edge-superseded',
  contradiction: '--graph-edge-contradiction'
} as const

/** Human-readable tier labels */
export const TIER_LABELS = ['T0 Observed', 'T1 Confirmed', 'T2 Established', 'T3 Wisdom'] as const

/** All valid tier numbers */
export const ALL_TIERS = [0, 1, 2, 3] as const

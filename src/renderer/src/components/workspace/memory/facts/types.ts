import type { MemoryFact, MemoryFactCategory } from '../../../../../../shared/types'

export const ALL_CATEGORIES: MemoryFactCategory[] = [
  'decision',
  'convention',
  'gotcha',
  'preference',
  'reference'
]

export const ALL_TIERS = [0, 1, 2, 3] as const

export const TIER_LABELS: Record<number, string> = {
  0: 'T0 Observed',
  1: 'T1 Confirmed',
  2: 'T2 Established',
  3: 'T3 Wisdom'
}

export const TIER_TEXT: Record<number, string> = {
  0: 'text-text-muted',
  1: 'text-info',
  2: 'text-success',
  3: 'text-primary-text'
}

export const TIER_DOT: Record<number, string> = {
  0: 'bg-text-muted',
  1: 'bg-info',
  2: 'bg-success',
  3: 'bg-primary-text'
}

export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'tier', label: 'Tier' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'confirms', label: 'Confirms' }
] as const

export type SortMode = (typeof SORT_OPTIONS)[number]['value']

export const STATUS_OPTIONS = [
  { value: 'all', label: 'Active' },
  { value: 'validated', label: 'Validated' },
  { value: 'unvalidated', label: 'Unvalidated' },
  { value: 'pending-embedding', label: 'Pending embed' },
  { value: 'superseded', label: 'Superseded' }
] as const

export type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

export type SearchMode = 'filter' | 'semantic'

export type Density = 'compact' | 'comfortable'

/** Flattened list model — group headers and facts share one virtualized array. */
export type FactRowItem =
  | { kind: 'group'; tier: number; count: number; collapsed: boolean }
  | { kind: 'fact'; fact: MemoryFact }

export function isValidated(fact: MemoryFact): boolean {
  return fact.tier >= 1 || (fact.evidenceCount ?? 0) > 0
}

export function relativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

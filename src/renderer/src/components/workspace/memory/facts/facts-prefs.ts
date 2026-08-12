/**
 * Persisted Memories filters.
 *
 * Filters used to reset on every tab switch, so narrowing to one category and
 * glancing at Review threw the narrowing away. Stored alongside the tab key.
 *
 * The search box is deliberately NOT persisted — reopening the page to a
 * silently-filtered list with a query you no longer remember typing is worse
 * than losing it.
 */
import type { MemoryFactCategory } from '../../../../../../shared/types'
import {
  ALL_CATEGORIES,
  ALL_TIERS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type SortMode,
  type StatusFilter
} from './types'

const STORAGE_KEY = 'memory-facts-filters'

export interface FactsFilters {
  categories: MemoryFactCategory[]
  tiers: number[]
  status: StatusFilter
  sort: SortMode
}

export const DEFAULT_FILTERS: FactsFilters = {
  categories: [...ALL_CATEGORIES],
  tiers: [...ALL_TIERS],
  status: 'all',
  sort: 'newest'
}

/**
 * Every field is validated against the current option sets: a value dropped in
 * a later release would otherwise persist forever and filter the list down to
 * nothing with no visible cause.
 */
export function parseFilters(raw: string | null): FactsFilters {
  if (!raw) return DEFAULT_FILTERS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_FILTERS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FILTERS
  const value = parsed as Partial<Record<keyof FactsFilters, unknown>>

  const categories = Array.isArray(value.categories)
    ? ALL_CATEGORIES.filter((c) => (value.categories as unknown[]).includes(c))
    : []
  const tiers = Array.isArray(value.tiers)
    ? ALL_TIERS.filter((t) => (value.tiers as unknown[]).includes(t))
    : []
  const status = STATUS_OPTIONS.some((o) => o.value === value.status)
    ? (value.status as StatusFilter)
    : DEFAULT_FILTERS.status
  const sort = SORT_OPTIONS.some((o) => o.value === value.sort)
    ? (value.sort as SortMode)
    : DEFAULT_FILTERS.sort

  return {
    // An empty set shows nothing, which reads as a bug — fall back to all.
    categories: categories.length > 0 ? categories : DEFAULT_FILTERS.categories,
    tiers: tiers.length > 0 ? tiers : DEFAULT_FILTERS.tiers,
    status,
    sort
  }
}

export function readFilters(): FactsFilters {
  try {
    return parseFilters(localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_FILTERS
  }
}

export function writeFilters(filters: FactsFilters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters))
  } catch {
    // Storage full or unavailable — losing a filter preference is not worth
    // taking the page down for.
  }
}

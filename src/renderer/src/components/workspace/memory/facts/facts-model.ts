/**
 * The memories list pipeline as plain functions.
 *
 * Kept out of `useFactsModel` so the rules that decide what the user sees —
 * status scoping, narrowing, sort order, group flattening — are testable
 * without a React renderer, which this repo has no harness for.
 */
import type { MemoryFact, MemoryFactCategory } from '../../../../../../shared/types'
import {
  ALL_CATEGORIES,
  isValidated,
  type FactRowItem,
  type SortMode,
  type StatusFilter
} from './types'

/** Facts the current status filter admits. Every other step reads this set. */
export function scopeFacts(facts: MemoryFact[], status: StatusFilter): MemoryFact[] {
  if (status === 'superseded') return facts.filter((f) => f.status === 'superseded')
  const active = facts.filter((f) => f.status === 'active')
  switch (status) {
    case 'validated':
      return active.filter(isValidated)
    case 'unvalidated':
      return active.filter((f) => !isValidated(f))
    case 'pending-embedding':
      return active.filter((f) => f.embeddingPending)
    default:
      return active
  }
}

export function countByTier(facts: MemoryFact[]): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const f of facts) counts[Math.min(f.tier, 3)] += 1
  return counts
}

export function countByCategory(facts: MemoryFact[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const cat of ALL_CATEGORIES) counts[cat] = 0
  for (const f of facts) counts[f.category] = (counts[f.category] ?? 0) + 1
  return counts
}

export function validatedPercent(facts: MemoryFact[]): number {
  if (facts.length === 0) return 0
  return Math.round((facts.filter(isValidated).length / facts.length) * 100)
}

interface NarrowOptions {
  categories: ReadonlySet<MemoryFactCategory>
  tiers: ReadonlySet<number>
  sort: SortMode
  /** Empty in semantic mode — that search is resolved server-side. */
  needle: string
}

export function narrowAndSort(
  facts: MemoryFact[],
  { categories, tiers, sort, needle }: NarrowOptions
): MemoryFact[] {
  const query = needle.trim().toLowerCase()
  const items = facts.filter((f) => {
    if (!categories.has(f.category)) return false
    if (!tiers.has(Math.min(f.tier, 3))) return false
    if (query) {
      const haystack = `${f.title} ${f.content} ${f.tags.join(' ')}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })

  const sorted = [...items]
  switch (sort) {
    case 'newest':
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      break
    case 'tier':
      sorted.sort((a, b) => b.tier - a.tier || b.confidence - a.confidence)
      break
    case 'confidence':
      sorted.sort((a, b) => b.confidence - a.confidence)
      break
    case 'confirms':
      sorted.sort((a, b) => b.confirmationCount - a.confirmationCount)
      break
  }
  return sorted
}

/**
 * Flattens facts into the virtualizer's row array. Only `tier` sort groups;
 * every other sort is a flat list, because grouping a date-ordered list by
 * tier reorders it behind the user's back.
 */
export function buildRows(
  facts: MemoryFact[],
  sort: SortMode,
  collapsedTiers: ReadonlySet<number>
): FactRowItem[] {
  if (sort !== 'tier') return facts.map((fact) => ({ kind: 'fact' as const, fact }))

  const groups: Record<number, MemoryFact[]> = { 3: [], 2: [], 1: [], 0: [] }
  for (const f of facts) groups[Math.min(f.tier, 3)].push(f)

  const out: FactRowItem[] = []
  for (const tier of [3, 2, 1, 0]) {
    const group = groups[tier]
    // Empty groups are never rendered — the page previously showed nothing
    // but collapsed headers for tiers that held zero facts.
    if (group.length === 0) continue
    const collapsed = collapsedTiers.has(tier)
    out.push({ kind: 'group', tier, count: group.length, collapsed })
    if (!collapsed) for (const fact of group) out.push({ kind: 'fact', fact })
  }
  return out
}

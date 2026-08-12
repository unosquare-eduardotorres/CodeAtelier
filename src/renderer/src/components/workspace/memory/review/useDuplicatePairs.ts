import { useEffect, useMemo, useState } from 'react'
import type { MemoryContradiction, MemoryFact } from '../../../../../../shared/types'
import { parseCosine } from './word-diff'

export interface DuplicatePair {
  contradiction: MemoryContradiction
  oldFact: MemoryFact | null
  newFact: MemoryFact | null
  /** Null for genuine contradictions, which carry no similarity score. */
  cosine: number | null
  isDuplicate: boolean
}

/**
 * Resolves both sides of every contradiction once for the whole list.
 *
 * Each card used to run its own pair of lookups on mount, so a page of 20
 * pairs issued up to 40 independent IPC calls.
 */
export function useDuplicatePairs(
  contradictions: MemoryContradiction[],
  allFacts: MemoryFact[]
): DuplicatePair[] {
  const [fetched, setFetched] = useState<Record<string, MemoryFact | null>>({})

  const localById = useMemo(() => {
    const map = new Map<string, MemoryFact>()
    for (const f of allFacts) map.set(f.id, f)
    return map
  }, [allFacts])

  const missingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of contradictions) {
      if (!localById.has(c.oldFactId) && !(c.oldFactId in fetched)) ids.add(c.oldFactId)
      if (!localById.has(c.newFactId) && !(c.newFactId in fetched)) ids.add(c.newFactId)
    }
    return [...ids]
  }, [contradictions, localById, fetched])

  useEffect(() => {
    if (missingIds.length === 0) return
    let cancelled = false
    void Promise.all(
      missingIds.map(async (id) => {
        try {
          return [id, await window.api.memoryFactsGet({ id })] as const
        } catch {
          return [id, null] as const
        }
      })
    ).then((entries) => {
      if (cancelled) return
      setFetched((prev) => ({ ...prev, ...Object.fromEntries(entries) }))
    })
    return () => {
      cancelled = true
    }
  }, [missingIds])

  return useMemo(
    () =>
      contradictions.map((contradiction) => ({
        contradiction,
        oldFact: localById.get(contradiction.oldFactId) ?? fetched[contradiction.oldFactId] ?? null,
        newFact: localById.get(contradiction.newFactId) ?? fetched[contradiction.newFactId] ?? null,
        cosine: parseCosine(contradiction.resolution),
        isDuplicate: contradiction.resolution?.startsWith('duplicate') ?? false
      })),
    [contradictions, localById, fetched]
  )
}

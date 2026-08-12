import { useMemo } from 'react'
import type { StructuredPlan } from '../../../../../shared/types'

// ── Helper ──

/** Safely filter an optional array from structured plan data. */
function filterPlanArray<T>(arr: T[] | undefined, predicate?: (item: T) => boolean): T[] {
  if (!Array.isArray(arr)) return []
  return predicate ? arr.filter(predicate) : arr
}

/**
 * All defensive `useMemo` filters for structured plan arrays.
 * Extracted from TaskPlanCard (now used by PlanTabContent in ChatExecutionPanel) to centralise validation logic.
 */
export function usePlanMemos(structuredPlan: StructuredPlan | null): {
  visibleFilesChanged: NonNullable<StructuredPlan['filesChanged']>
  visibleFiles: NonNullable<StructuredPlan['files']>
  visibleRisks: NonNullable<StructuredPlan['risks']>
  visibleDeferredItems: NonNullable<StructuredPlan['deferredItems']>
  visibleDiagrams: NonNullable<StructuredPlan['diagrams']>
  visibleSections: NonNullable<StructuredPlan['sections']>
  visibleRootCauses: NonNullable<StructuredPlan['rootCauses']>
  visibleVerification: NonNullable<StructuredPlan['verification']>
  visiblePhases: NonNullable<StructuredPlan['phases']>
  visibleDecisions: NonNullable<StructuredPlan['decisions']>
} {
  const visibleFilesChanged = useMemo(
    () =>
      filterPlanArray(
        structuredPlan?.filesChanged,
        (e) => !!e?.file?.trim() && !!e?.change?.trim()
      ),
    [structuredPlan]
  )

  const visibleFiles = useMemo(
    () =>
      filterPlanArray(
        structuredPlan?.files,
        (f): f is string => typeof f === 'string' && f.trim() !== ''
      ),
    [structuredPlan]
  )

  const visibleRisks = useMemo(
    () =>
      filterPlanArray(structuredPlan?.risks, (r) => {
        const sev = typeof r === 'string' ? 'medium' : r?.severity
        return sev === 'high' || sev === 'critical'
      }),
    [structuredPlan]
  )

  const visibleDeferredItems = useMemo(
    () =>
      filterPlanArray(
        structuredPlan?.deferredItems,
        (s): s is string => typeof s === 'string' && s.trim() !== ''
      ),
    [structuredPlan]
  )

  const visibleDiagrams = useMemo(
    () => filterPlanArray(structuredPlan?.diagrams, (d) => !!d?.mermaid?.trim()),
    [structuredPlan]
  )

  const visibleSections = useMemo(
    () => filterPlanArray(structuredPlan?.sections, (s) => !!s?.content?.trim()),
    [structuredPlan]
  )

  const visibleRootCauses = useMemo(
    () =>
      filterPlanArray(
        structuredPlan?.rootCauses,
        (rc) => !!rc?.title?.trim() && !!rc?.description?.trim()
      ),
    [structuredPlan]
  )

  const visibleVerification = useMemo(
    () =>
      filterPlanArray(
        structuredPlan?.verification,
        (v): v is string => typeof v === 'string' && v.trim() !== ''
      ),
    [structuredPlan]
  )

  const visiblePhases = useMemo(
    () => filterPlanArray(structuredPlan?.phases, (p) => !!p?.title?.trim()),
    [structuredPlan]
  )

  const visibleDecisions = useMemo(
    () => filterPlanArray(structuredPlan?.decisions, (d) => !!d?.what?.trim() && !!d?.why?.trim()),
    [structuredPlan]
  )

  return {
    visibleFilesChanged,
    visibleFiles,
    visibleRisks,
    visibleDeferredItems,
    visibleDiagrams,
    visibleSections,
    visibleRootCauses,
    visibleVerification,
    visiblePhases,
    visibleDecisions
  }
}

/**
 * MPA Artifact Parsers — shared between orchestration service and tests.
 *
 * Extracts structured plan and verify-report artifacts from raw agent output text.
 * Looks for tagged code blocks first (```goal-plan / ```goal-verify-report),
 * then falls back to JSON pattern matching.
 */

import log from 'electron-log'
import type { MpaPlanArtifact, MpaVerifyReport } from '../../shared/mpa-types'

const mpaLog = log.scope('mpa')

/**
 * Whether a verify report has at least one failing success criterion.
 * Guards against a non-array `criteriaResults` (a malformed field from the
 * model) so it can't throw and spuriously fail a run — a missing/invalid array
 * simply means "no failing criteria".
 */
export function hasFailingCriteria(report: MpaVerifyReport | null | undefined): boolean {
  return (
    Array.isArray(report?.criteriaResults) &&
    report.criteriaResults.some((c) => c?.status === 'fail')
  )
}

/**
 * Parse a plan artifact from agent output text.
 * Looks for ```goal-plan tagged block, then falls back to JSON with items array.
 */
export function parsePlanArtifact(text: string): MpaPlanArtifact | null {
  try {
    // Look for ```goal-plan ... ``` tagged block
    const match = text.match(/```goal-plan\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      const parsed = JSON.parse(match[1])
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed as MpaPlanArtifact
      }
    }

    // Fallback: look for any JSON with items array
    const jsonMatch = text.match(/\{[\s\S]*"items"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed as MpaPlanArtifact
      }
    }
  } catch (err) {
    mpaLog.warn('[parsePlanArtifact] Failed to parse plan:', err)
  }
  return null
}

/**
 * Parse a verify report from agent output text.
 * Looks for ```goal-verify-report tagged block, then falls back to JSON with allComplete key.
 */
export function parseVerifyReport(text: string): MpaVerifyReport | null {
  try {
    // Look for ```goal-verify-report ... ``` tagged block
    const match = text.match(/```goal-verify-report\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      const parsed = JSON.parse(match[1])
      if ('allComplete' in parsed) {
        return parsed as MpaVerifyReport
      }
    }

    // Fallback: look for JSON with allComplete key
    const jsonMatch = text.match(/\{[\s\S]*"allComplete"\s*:[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if ('allComplete' in parsed) {
        return parsed as MpaVerifyReport
      }
    }
  } catch (err) {
    mpaLog.warn('[parseVerifyReport] Failed to parse verify report:', err)
  }
  return null
}

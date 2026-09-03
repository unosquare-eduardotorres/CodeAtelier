/**
 * blueprint-failure-fingerprint.ts — stable identity of a blueprint failure.
 *
 * Two different consumers need the same question answered: "is this the SAME
 * failure I just saw, or a new one?"
 *
 *   - Phase level (`blueprint.service.ts` `saveRetryContext`) — F4 recurrence
 *     counter that gates the renderer's Retry button.
 *   - Task level (`blueprint-build.service.ts` `executeTaskWithGates`) — B3
 *     stop-loss: a builder ladder that produced a byte-identical gate failure
 *     twice cannot be argued out of it by a third cold session with the same
 *     prompt, so the remaining rungs are skipped in favour of escalation.
 *
 * Pure and dependency-free on purpose: no DB, no Electron, no clock. The whole
 * point is that the same input yields the same fingerprint in a unit test, in
 * the main process, and across app restarts.
 */
import type { GateReport } from '../../shared/gate-types'

/**
 * F4 — stable identity of a phase error for recurrence detection.
 *
 * Strips the parts that legitimately vary between attempts (task ids, counts,
 * timestamps, paths) so "R045: verification failed" and "R041: verification
 * failed" fingerprint as the SAME failure — which they were, 20 times in a
 * row, while nothing in the loop noticed it was not converging.
 */
export function fingerprintPhaseError(error: string): string {
  return error
    .replace(/\b[TWR]\d{2,}\b/g, 'T###') // task ids R045, T003, W10
    .replace(/\b\d+(?:\.\d+)?\b/g, '#') // counts, versions, timings
    .replace(/[A-Za-z]:\\[^\s;]+/g, '<path>') // Windows paths
    .replace(/(?:\/|\\)[\w.-]+(?:\/|\\)[\w.-]+/g, '<path>') // posix-ish paths
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * B3 — identity of a task-level GATE failure.
 *
 * Per failing gate rather than over the concatenation: `fingerprintPhaseError`
 * truncates at 200 chars, and a single blob of joined evidence would let the
 * first gate's output crowd the others out of the comparison. Sorted so gate
 * ORDER (which `shortCircuited` runs can change between attempts) never reads
 * as a different failure.
 *
 * Returns '' when no gate failed — an empty fingerprint must never compare
 * equal to a previous one, so callers treat it as "no signal".
 */
export function fingerprintGateFailure(report: GateReport | null | undefined): string {
  if (!report) return ''
  const parts = report.gates
    .filter((g) => g.verdict === 'fail')
    .map((g) => `${g.name}:${fingerprintPhaseError(g.evidence.join(' '))}`)
    .sort()
  return parts.join('|')
}

/**
 * Terminal reasons that mean the model/API call itself died (e.g. GLM
 * `api_error`) — the turn produced no real content.
 *
 * F12 (retry-correctness audit): this set lived privately in
 * `blueprint-spec.service.ts` (API-ERROR-FAIL), so SPEC refused to grade a dead
 * API call while BUILD graded one as a `quality` failure. T014 died on
 * `api_error` with `writes=0 bash=0` and was booked
 * `failureClass: "quality", reason: "quality gate failed: write-set"` — the
 * violation it "failed" on was the PREVIOUS attempt's file, still in the
 * worktree. Moving the constant here is what lets both phases consult the same
 * answer.
 */

/** Terminal reasons that mean the turn died before producing gradeable work. */
export const API_ERROR_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'api_error',
  'model_error',
  'failed'
])

/**
 * Did a turn end on a terminal reason that means the API call itself died?
 *
 * Such a rung did no work: the corrective nudge cannot fix a dead API call
 * (SPEC), and the gates must never grade it (BUILD — infra, never quality).
 */
export function isApiErrorTerminalReason(terminalReason: string | undefined | null): boolean {
  if (!terminalReason) return false
  return API_ERROR_TERMINAL_REASONS.has(terminalReason)
}

/**
 * T003 fix — deterministic-stop-loss retry exclusion.
 *
 * The B3 stop-loss fires when a task's gate failure fingerprint is unchanged
 * across attempts: the same environment, the same command, the same verdict.
 * Re-running that ladder (auto phase-retry or manual) re-runs the identical
 * experiment and burns MAX_BUILDER_ATTEMPTS more builder sessions + a lead
 * escalation for a result nothing in the code can change — the T003
 * infinite-retry loop.
 *
 * This module owns the wording contract between the WRITE site (the ladder's
 * stop-loss branch in blueprint-build.service) and the READ site (retryPhase in
 * blueprint.service), so the two can never drift apart silently.
 */

/** Mirrors the B3 stop-loss clause written by blueprint-build.service. */
export const STOP_LOSS_REASON_RE = /stop-loss after \d+ identical gate failure/i

/**
 * Belt-and-braces cap: MAX_BUILDER_ATTEMPTS (3) × 2 full phase retries. Any
 * task that has consumed this many builder attempts is excluded from further
 * resets even if a future wording change stops matching the regex above.
 * `attempts` is monotonic across phase retries by design.
 */
export const STOP_LOSS_EXCLUSION_ATTEMPT_CAP = 6

/**
 * D3b — hard dispatch ceiling: 2 × STOP_LOSS_EXCLUSION_ATTEMPT_CAP (≈ 4 full
 * ladders). The retry exclusion and the requeue guard above close the KNOWN
 * reset paths, but any future reset-path bug (a new status mutation, a missed
 * guard) would re-open an unbounded dispatch loop — the blueprint-2b08bb6e
 * incident ran 29 attempts on a task. A task at or beyond this ceiling is
 * settled by BOTH schedulers' resume pre-passes: never dispatched, counted
 * toward completion, one `attempt_ceiling` telemetry row. Monotonic `attempts`
 * means nothing legitimate ever reaches it — a healthy task completes in 1–3.
 */
export const TASK_DISPATCH_ATTEMPT_CEILING = STOP_LOSS_EXCLUSION_ATTEMPT_CAP * 2

/** Suffix format used at write time and parsed at read time. */
export function formatStopLossCommandSuffix(command: string): string {
  // Gate commands are paren-free (`isSafeGateCommand` refuses them), so a
  // `[^)]+` extraction round-trips exactly.
  return ` (command: ${command})`
}

/** The command recorded at stop-loss time, or null for older/absent rows. */
export function parseStopLossCommand(reason: string): string | null {
  const m = /\(command: ([^)]+)\)/.exec(reason)
  return m ? m[1] : null
}

/**
 * Should this failed task be EXCLUDED from a retryPhase reset?
 *
 * Three independent triggers:
 *  1. the failure reason carries a B3 stop-loss clause AND the resolved test
 *     command is byte-identical to the one recorded at stop-loss time — the
 *     experiment would repeat exactly;
 *  2. the reason carries a stop-loss clause but predates command recording —
 *     plain exclusion (conservative: assume unchanged);
 *  3. `attempts` reached the belt-and-braces cap — wording-drift guard.
 *
 * A RECORDED command that differs from `currentTestCommand` LIFTS the
 * exclusion: the operator overrode the command, the PLAN re-declared it, or
 * the environment re-resolved differently — that is a new experiment and the
 * task is allowed to retry.
 */
export function isDeterministicStopLoss(
  reason: string,
  attempts: number,
  currentTestCommand?: string | null
): boolean {
  if (attempts >= STOP_LOSS_EXCLUSION_ATTEMPT_CAP) return true
  if (!STOP_LOSS_REASON_RE.test(reason)) return false
  const recorded = parseStopLossCommand(reason)
  // No recorded command (older rows) or no current resolution to compare
  // against → keep the exclusion; the safest assumption for a deterministic
  // failure is that nothing changed.
  if (!recorded || !currentTestCommand) return true
  return recorded === currentTestCommand
}

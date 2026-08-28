/**
 * Deterministic quality-gate types — shared between main and renderer.
 *
 * Gates are kernel-owned: they run in the main process AFTER a build-task
 * session ends, so the graded agent never grades itself.
 *
 * The three verdicts are not a severity scale — they answer different questions:
 *   - `pass`         the check ran and the code satisfied it
 *   - `fail`         the check ran and the code did not satisfy it
 *   - `unverifiable` the check could not run at all (no command, no packet, …)
 *
 * INVARIANT: `unverifiable` NEVER becomes `fail`. It warns, the pipeline
 * continues, and the item is recorded in the unverified ledger, which taints
 * the blueprint's terminal status. Conversely a test that ran and went red is
 * always `fail` — never downgraded to `unverifiable`.
 */

export type GateVerdict = 'pass' | 'fail' | 'unverifiable'

/** Stable identifiers for every gate in the stack (G1–G6 + VERIFY extensions). */
export type GateName =
  /** G4 — changed files must stay inside the packet's allowed write-set. */
  | 'write-set'
  /** G3 — no TODO/FIXME/not-implemented/empty-body residue in changed files. */
  | 'stub-scan'
  /** G5 — packet test files unmodified, no added skips, test count not reduced. */
  | 'test-integrity'
  /** G2 — the workspace lint command. */
  | 'lint'
  /** G1 — the workspace build/typecheck command. */
  | 'build'
  /** G6 — the task's own tests, with red→green proof. */
  | 'task-tests'
  /** VERIFY — the full test suite as a backstop. */
  | 'full-suite'
  /** VERIFY — optional "does it boot" smoke command. */
  | 'smoke'
  /** VERIFY — code-graph structural analysis (new dead code / import cycles). */
  | 'structural'
  /** CODE-REVIEW — adversarial whole-diff review findings (M7). */
  | 'code-review'
  /** LEAD-REVIEW-PASS — post-verify whole-diff lead review findings (M6.1). */
  | 'lead-review-pass'
  /** PEER-REVIEW — per-task advisory review findings that survived the fix attempt (M5). */
  | 'peer-review'

/**
 * Why a gate could not be evaluated. Only meaningful on `unverifiable`
 * results — these are the strings that land in the unverified ledger.
 */
export type UnverifiableReason =
  /** No build/lint/test command could be resolved (override → declared → detected all empty). */
  | 'no_command'
  /** The task predates work packets, so there is no write-set/test list to check against. */
  | 'no_packet'
  /** The workspace is not a git repo, or the diff base could not be established. */
  | 'no_git'
  /** The command exceeded its timeout, so its outcome is unknown. */
  | 'timeout'
  /** The command could not be spawned at all (binary missing, cwd gone). */
  | 'command_error'
  /** The packet declared test files, but none of them exist on disk. */
  | 'no_tests'
  /** The task's tests were green BEFORE the build session — they prove nothing. */
  | 'vacuous_test'
  /** A code-graph / structural probe could not complete. */
  | 'analysis_unavailable'
  /** A code-review finding survived the fix round unresolved (M7). */
  | 'finding_unresolved'
  /** The lead-review pass itself errored (session failure, timeout) (M6.1). */
  | 'pass_error'

/** Serialized evidence is bounded so a runaway compiler log can never reach the DB or UI. */
export const EVIDENCE_MAX_CHARS = 2000

export interface GateResult {
  name: GateName
  verdict: GateVerdict
  /**
   * Human-readable proof lines (offending paths, error tail, command exit code).
   * Bounded: `boundEvidence` guarantees the serialized form is ≤ EVIDENCE_MAX_CHARS.
   */
  evidence: string[]
  /** Set only when `verdict === 'unverifiable'`. */
  reason?: UnverifiableReason
  /** Optional numeric facts (filesChanged, testsBefore, testsAfter, exitCode, …). */
  counts?: Record<string, number>
  durationMs: number
}

export interface GateReport {
  gates: GateResult[]
  overall: GateVerdict
  /** ISO timestamp of when the gate run started. */
  startedAt?: string
  /** True when the run short-circuited on a `fail` and later gates never ran. */
  shortCircuited?: boolean
}

/** One entry in the blueprint's unverified-items ledger. */
export interface UnverifiedItem {
  /** Blueprint task id ('T003'), or the phase name for blueprint-level items. */
  taskId: string
  gate: GateName
  reason: UnverifiableReason
  /** One short line of context; not the full evidence blob. */
  detail?: string
  at?: string
}

/**
 * Aggregate rule: any `fail` ⇒ `fail`; else any `unverifiable` ⇒ `unverifiable`;
 * else `pass`.
 *
 * An EMPTY gate list aggregates to `unverifiable`, not `pass`: nothing was
 * checked, so claiming a pass would assert a verification that never happened.
 */
export function aggregateVerdict(gates: readonly GateResult[]): GateVerdict {
  if (gates.length === 0) return 'unverifiable'
  if (gates.some((g) => g.verdict === 'fail')) return 'fail'
  if (gates.some((g) => g.verdict === 'unverifiable')) return 'unverifiable'
  return 'pass'
}

/** Build a report from results, computing `overall` with the aggregate rule. */
export function buildGateReport(
  gates: readonly GateResult[],
  extra?: Omit<GateReport, 'gates' | 'overall'>
): GateReport {
  return { ...extra, gates: [...gates], overall: aggregateVerdict(gates) }
}

/**
 * Trim evidence so `JSON.stringify(lines).length <= max`.
 *
 * Keeps whole lines from the FRONT (the first lines name the problem; the tail
 * of a compiler log is the noise). If even the first line is too long it is
 * hard-truncated. Always appends a marker when anything was dropped.
 */
export function boundEvidence(
  lines: readonly string[],
  max: number = EVIDENCE_MAX_CHARS
): string[] {
  if (JSON.stringify(lines).length <= max) return [...lines]

  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line, '…truncated']
    if (JSON.stringify(candidate).length > max) break
    kept.push(line)
  }

  if (kept.length === 0 && lines.length > 0) {
    // Even one whole line does not fit — hard-truncate the first one.
    // Budget: `max` minus the JSON overhead of ["…truncated"] plus quotes/comma.
    const overhead = JSON.stringify(['', '…truncated']).length
    const room = Math.max(0, max - overhead)
    kept.push(lines[0].slice(0, room))
  }

  kept.push('…truncated')
  return kept
}

/** Convenience: does this report allow the pipeline to advance? */
export function gatesBlockAdvance(report: GateReport | null | undefined): boolean {
  return report?.overall === 'fail'
}

/** Collect the unverifiable results of a report as ledger items. */
export function ledgerItemsFrom(
  report: GateReport,
  taskId: string,
  at: string = new Date().toISOString()
): UnverifiedItem[] {
  return report.gates
    .filter((g) => g.verdict === 'unverifiable')
    .map((g) => ({
      taskId,
      gate: g.name,
      reason: g.reason ?? 'no_command',
      detail: g.evidence[0],
      at
    }))
}

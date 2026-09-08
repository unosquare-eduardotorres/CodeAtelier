/**
 * Impeccable deterministic detector.
 *
 * Wraps `impeccable detect --json <targets>` and maps its output into the
 * `AuditFinding` vocabulary the rest of the audit/design stack already speaks.
 * This is the *deterministic* half of a design run — it finds slop the LLM half
 * would have to notice by eye, at zero token cost.
 *
 * ── Contract: this module never throws and never fails a run ──────────────────
 * A design run's value comes from the agent sessions. The detector is an
 * enrichment. A missing engine, an unscannable target, a timeout, or a payload
 * the parser does not recognise all degrade to "no detector findings" plus a
 * warning — never an exception that aborts the run.
 *
 * ── Ground truth (engine 0.1.3, captured 2026-09-07 against this repo) ────────
 * Verified empirically, not assumed. `detect --help` and real runs agree:
 *
 *   • `--json` writes a **bare array** to stdout — NOT an envelope object.
 *     An empty scan is `[]`. Human-readable text goes to stderr.
 *   • Keys: `antipattern` (rule id), `name`, `description`, `severity`,
 *     `category`, `file`, `line`, `snippet`, plus optional `importedBy` and
 *     optional `advisory`.
 *   • `file` is an **ABSOLUTE path**. We relativize at this boundary so no
 *     home-directory path ever reaches the UI, a report file, or a dedupe key
 *     that is compared against workspace-relative LLM findings.
 *   • `line` is `0` for file-level findings (e.g. `em-dash-overuse`).
 *   • Exit codes: `0` clean · `1` a target could not be scanned · `2` findings
 *     present. Advisory-only results still exit `0`, so exit `0` must be parsed
 *     rather than short-circuited as "nothing to see".
 *   • Observed severities: `warning`, `advisory`. Observed categories: `slop`,
 *     `quality`. The full enum is NOT enumerable — the binary is packed and
 *     there is no rule-catalog command — hence the defensive mapping below.
 *
 * Advisory findings ARE present in `--json` and ARE distinguishable (both
 * `severity: 'advisory'` and `advisory: true`), so we include them mapped to
 * `info` rather than suppressing them with `--no-advisory`. They never affect
 * the exit code upstream and they never inflate blueprint priority here.
 */
import { relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuditFinding } from '../../shared/types'
import { runEngine } from './impeccable-runtime.service'
import { skillLogger } from '../logger'

/**
 * Optional-call shim, matching `impeccable-runtime.service.ts`.
 *
 * This module promises never to throw, and the unit harness can leave
 * `../logger` partially mocked — logging must not be the thing that breaks that
 * promise.
 */
const log = {
  info: (msg: string): void => skillLogger?.info?.(msg),
  warn: (msg: string): void => skillLogger?.warn?.(msg)
}

/** Budget for a scoped detector scan. Matches `runEngine`'s own default. */
const DETECT_TIMEOUT_MS = 60_000

/**
 * Budget for a whole-project scan.
 *
 * Measured on this repo (engine 0.1.3, 2026-09-07): `detect .` took **37.8 s**
 * and returned **4283 findings**, against **0.5 s** and **27 findings** for
 * `detect src/renderer`. The difference is not repo size — the engine does NOT
 * honour `.gitignore`, so a project scan walks `coverage/` and `out/`, which
 * accounted for 98 % of those findings.
 *
 * 60 s therefore leaves almost no margin on a larger workspace, and a timeout
 * discards the entire deterministic scan silently. The scoped budget stays
 * tight because a scoped scan that takes a minute is genuinely wrong.
 */
const PROJECT_DETECT_TIMEOUT_MS = 180_000

/** Marks findings produced here. The UI badges on this, and coverage excludes it. */
export const DETECTOR_SOURCE = 'impeccable-detector'

export interface DetectionResult {
  /**
   * - `ok`          — the scan ran; `findings` is authoritative (possibly empty)
   * - `failed`      — the engine ran but could not scan a target (exit 1), or
   *                   emitted a payload we could not parse
   * - `unavailable` — the engine could not be spawned at all, or timed out
   */
  status: 'ok' | 'failed' | 'unavailable'
  findings: AuditFinding[]
  /** Distinct `antipattern` rule ids represented in `findings`. */
  ruleCount: number
  /** Human-readable explanation for a non-`ok` status. */
  reason?: string
}

/** One raw entry as emitted by `detect --json`, before any validation. */
interface RawDetectorFinding {
  antipattern?: unknown
  name?: unknown
  description?: unknown
  severity?: unknown
  category?: unknown
  file?: unknown
  line?: unknown
  snippet?: unknown
  importedBy?: unknown
  advisory?: unknown
}

type Severity = AuditFinding['severity']

/**
 * Engine severity → our severity.
 *
 * Only `warning` and `advisory` are observable today, so an exhaustive switch
 * is impossible to write honestly. Everything outside this table falls through
 * to `medium` and is logged ONCE per run, which is how the real enum gets
 * learned from telemetry instead of guessed at now.
 */
const SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  error: 'high',
  warning: 'medium',
  notice: 'info',
  info: 'info',
  advisory: 'info'
}

/** Fallback for an unrecognised severity. Never silently drops the finding. */
const UNKNOWN_SEVERITY_FALLBACK: Severity = 'medium'

function mapSeverity(raw: unknown, unknownSeen: Set<string>): Severity {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  const mapped = SEVERITY_MAP[key]
  if (mapped) return mapped

  // One log line per distinct unrecognised value per run — not per finding.
  if (!unknownSeen.has(key)) {
    unknownSeen.add(key)
    log.warn(
      `[impeccable-detector] unrecognised severity ${JSON.stringify(raw)} — ` +
        `mapping to '${UNKNOWN_SEVERITY_FALLBACK}'. If this appears often the severity ` +
        `map in impeccable-detector.service.ts should gain an explicit entry.`
    )
  }
  return UNKNOWN_SEVERITY_FALLBACK
}

/**
 * Convert the engine's absolute `file` into a workspace-relative POSIX path.
 *
 * This is load-bearing, not cosmetic. LLM findings carry workspace-relative
 * paths; leaving detector paths absolute would mean the two populations never
 * compare equal, so de-duplication against LLM findings would silently no-op
 * and every detector finding would be reported twice.
 */
export function relativizeDetectorPath(file: string, workspacePath: string): string {
  const absolute = resolve(workspacePath, file)
  const rel = relative(workspacePath, absolute).replace(/\\/g, '/')
  // `relative` returns '' when the target IS the workspace root, and a '../'
  // prefix for anything outside it. Neither leaks a home directory, so both are
  // preserved as-is rather than being rewritten into something misleading.
  return rel.length > 0 ? rel : '.'
}

/**
 * Stable identity for a detector finding.
 *
 * Includes `line` because detector findings are POSITIONAL, not topical: the
 * same rule legitimately fires many times in one file (this repo's `main.css`
 * has three distinct `side-tab` hits, at lines 480, 502 and 604). Keying on
 * file+rule alone would collapse them and silently discard real findings.
 */
export function detectorFindingKey(rule: string, filePath: string, line: number): string {
  return `${rule}|${filePath}|${line}`
}

/** Build the human-facing description, folding in the engine's extra context. */
function buildDescription(
  description: string,
  rule: string,
  category: string,
  filePath: string,
  line: number,
  snippet: string,
  importedBy: string[],
  isAdvisory: boolean
): string {
  const parts: string[] = []
  if (description) parts.push(description)

  // `line: 0` means "whole file" — rendering it as ':0' would be a lie.
  const location = line > 0 ? `${filePath}:${line}` : filePath
  const categoryNote = category ? `, category ${category}` : ''
  const advisoryNote = isAdvisory
    ? ' This rule is advisory: it never counts as a failure upstream.'
    : ''
  parts.push(
    `Detected by the Impeccable detector (rule \`${rule}\`${categoryNote}) at ${location}.${advisoryNote}`
  )

  if (snippet) parts.push(`\`\`\`\n${snippet}\n\`\`\``)
  if (importedBy.length > 0) {
    parts.push(`Reached via: ${importedBy.join(', ')}`)
  }

  return parts.join('\n\n')
}

/** Coerce `importedBy` defensively — it is optional and only present sometimes. */
function readImportedBy(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

export interface ParsedDetectorPayload {
  findings: AuditFinding[]
  ruleCount: number
  /** True when the payload could not be understood at all. */
  malformed: boolean
  /** Entries that were structurally unusable and skipped. */
  skipped: number
}

/**
 * Parse and map a raw `detect --json` payload.
 *
 * Exported so tests can drive it straight from captured fixtures rather than
 * mocking a subprocess. Never throws: an unparseable or wrongly-shaped payload
 * yields zero findings and `malformed: true`.
 */
export function parseDetectorPayload(stdout: string, workspacePath: string): ParsedDetectorPayload {
  const empty: ParsedDetectorPayload = {
    findings: [],
    ruleCount: 0,
    malformed: false,
    skipped: 0
  }

  const trimmed = stdout.trim()
  if (trimmed.length === 0) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    log.warn(
      `[impeccable-detector] could not parse detector JSON (${
        err instanceof Error ? err.message : String(err)
      }) — continuing with no detector findings`
    )
    return { ...empty, malformed: true }
  }

  // The top level is a bare array. An envelope object would mean the engine's
  // output contract changed under us; treat it as malformed rather than
  // guessing at a `.findings` key that may not mean what we think.
  if (!Array.isArray(parsed)) {
    log.warn(
      '[impeccable-detector] detector JSON was not a top-level array — ' +
        'the engine output contract may have changed. Continuing with no detector findings.'
    )
    return { ...empty, malformed: true }
  }

  const findings: AuditFinding[] = []
  const rules = new Set<string>()
  const unknownSeverities = new Set<string>()
  const seen = new Set<string>()
  let skipped = 0

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped++
      continue
    }
    const raw = entry as RawDetectorFinding

    // `antipattern` and `file` are the two fields we cannot synthesise. An
    // entry missing either is not actionable, so it is skipped rather than
    // rendered as a finding pointing nowhere.
    const rule = typeof raw.antipattern === 'string' ? raw.antipattern.trim() : ''
    const file = typeof raw.file === 'string' ? raw.file.trim() : ''
    if (!rule || !file) {
      skipped++
      continue
    }

    const filePath = relativizeDetectorPath(file, workspacePath)
    const line = typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : 0

    // Guard against the engine ever emitting the same positional finding twice.
    const key = detectorFindingKey(rule, filePath, line)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : rule
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    const category = typeof raw.category === 'string' ? raw.category.trim() : ''
    const snippet = typeof raw.snippet === 'string' ? raw.snippet.trim() : ''
    const isAdvisory = raw.advisory === true || raw.severity === 'advisory'

    rules.add(rule)
    findings.push({
      id: randomUUID(),
      severity: mapSeverity(raw.severity, unknownSeverities),
      title: name,
      description: buildDescription(
        description,
        rule,
        category,
        filePath,
        line,
        snippet,
        readImportedBy(raw.importedBy),
        isAdvisory
      ),
      filePath,
      source: DETECTOR_SOURCE
    })
  }

  return { findings, ruleCount: rules.size, malformed: false, skipped }
}

/**
 * Run the deterministic detector over `targets` within `workspacePath`.
 *
 * `cwd` is the workspace so the engine picks up `.impeccable/config.json`,
 * in-file `impeccable-disable` comments, and DESIGN.md exactly as it would from
 * the user's own terminal — waivers the user has already expressed must be
 * honoured rather than re-reported.
 *
 * `targets` are workspace-relative (already validated by `parseDesignRunConfig`).
 * An empty list scans the whole workspace.
 *
 * `signal` aborts the scan. Without it, cancelling a run during the detector
 * phase still waits out the full 60 s spawn before anything else can happen.
 * An abort is reported as `unavailable` with reason `cancelled` — checked
 * first, because a killed child is otherwise indistinguishable from a timeout.
 */
export async function runDetection(
  workspacePath: string,
  targets: string[] = [],
  signal?: AbortSignal
): Promise<DetectionResult> {
  const isProjectScan = targets.length === 0
  const scanTargets = isProjectScan ? ['.'] : targets
  const result = await runEngine(['detect', '--json', ...scanTargets], {
    cwd: workspacePath,
    timeoutMs: isProjectScan ? PROJECT_DETECT_TIMEOUT_MS : DETECT_TIMEOUT_MS,
    signal
  })

  if (signal?.aborted) {
    log.info('[impeccable-detector] detector aborted by cancellation')
    return { status: 'unavailable', findings: [], ruleCount: 0, reason: 'cancelled' }
  }

  if (result.timedOut) {
    log.warn(
      `[impeccable-detector] detector timed out after ` +
        `${isProjectScan ? PROJECT_DETECT_TIMEOUT_MS : DETECT_TIMEOUT_MS}ms — skipping`
    )
    return { status: 'unavailable', findings: [], ruleCount: 0, reason: 'detector timed out' }
  }
  if (result.error) {
    log.warn(`[impeccable-detector] engine unavailable: ${result.error}`)
    return { status: 'unavailable', findings: [], ruleCount: 0, reason: result.error }
  }

  // 0 = clean (but advisories may still be listed), 2 = findings present.
  // Both carry a valid payload. 1 = at least one target was unscannable.
  if (result.code !== 0 && result.code !== 2) {
    const detail = result.stderr.trim().slice(0, 200)
    log.warn(`[impeccable-detector] detector exited ${result.code}: ${detail}`)
    return {
      status: 'failed',
      findings: [],
      ruleCount: 0,
      reason: `detector exited ${result.code}${detail ? `: ${detail}` : ''}`
    }
  }

  const { findings, ruleCount, malformed, skipped } = parseDetectorPayload(
    result.stdout,
    workspacePath
  )

  if (malformed) {
    return {
      status: 'failed',
      findings: [],
      ruleCount: 0,
      reason: 'detector output could not be parsed'
    }
  }

  log.info(
    `[impeccable-detector] ${findings.length} finding(s) across ${ruleCount} rule(s)` +
      (skipped > 0 ? `, ${skipped} entr(ies) skipped` : '')
  )
  return { status: 'ok', findings, ruleCount }
}

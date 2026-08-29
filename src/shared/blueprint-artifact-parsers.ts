/**
 * Shared Blueprint Artifact Parsers — plan, tasks and gate-command block extraction.
 * Pure functions — no electron-log dependency. Importable by both main and renderer.
 *
 * Main process re-exports these to keep its existing API.
 */

import { sanitizeGateCommandSet, type GateCommandSet } from './gate-command-types'
import {
  LEAD_RUBRIC_CATEGORIES,
  MAX_REVIEW_FINDINGS,
  PEER_RUBRIC_CATEGORIES,
  type LeadReviewResult,
  type LeadRubricCategory,
  type PeerReviewResult,
  type ReviewFinding
} from './task-review-types'

// ── Plan block ──

const PLAN_REGEX = /```blueprint-plan\s*\n([\s\S]*?)```/g

/**
 * Parse the last blueprint-plan block from streamed text.
 * Returns null if no block found or parsing fails.
 */
export function parseBlueprintPlan(text: string): Record<string, unknown> | null {
  const matches = [...text.matchAll(PLAN_REGEX)]
  if (matches.length === 0) return null

  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    return JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── Gate commands block ──

const GATE_COMMANDS_REGEX = /```gate-commands\s*\n([\s\S]*?)```/g

/**
 * Parse the last `gate-commands` block declared by the PLAN phase.
 *
 * This is the ONLY route by which a model gets to name a command the main
 * process will execute, so the result is passed through the same safety guards
 * as every other source: shell metacharacters, absolute/`..` cwds and
 * over-long command lines are dropped rather than sanitised into something the
 * model did not write.
 *
 * Returns an empty set (not null) when the block is absent or unusable — no
 * declaration and an unusable declaration have the same consequence: the
 * affected gates fall through to detection, then to `unverifiable`.
 */
export function parseGateCommands(text: string): GateCommandSet {
  const matches = [...text.matchAll(GATE_COMMANDS_REGEX)]
  if (matches.length === 0) return {}

  const jsonStr = matches[matches.length - 1][1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  // Accept both `{ build: 'npm run build' }` and `{ build: { command, cwd } }`.
  // The shorthand is what models actually emit; rejecting it would mean the
  // declaration silently vanishes on the most common shape.
  const raw = parsed as Record<string, unknown>
  const normalized: GateCommandSet = {}
  for (const kind of ['build', 'lint', 'test', 'smoke'] as const) {
    const value = raw[kind]
    if (typeof value === 'string') {
      normalized[kind] = { command: value }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (typeof obj.command === 'string') {
        normalized[kind] = {
          command: obj.command,
          ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {})
        }
      }
    }
  }

  return sanitizeGateCommandSet(normalized)
}

// ── Review findings block ──

const REVIEW_REGEX = /```blueprint-review-findings\s*\n([\s\S]*?)```/g

function parseFinding(
  raw: unknown,
  allowed: readonly string[]
): { finding: ReviewFinding } | { reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reason: 'not an object' }
  }
  const obj = raw as Record<string, unknown>

  const category = typeof obj.category === 'string' ? obj.category.trim() : ''
  if (!allowed.includes(category)) {
    // The rubric is closed. A reviewer that invents a category has left the
    // checklist, and an off-rubric finding costs a build round-trip to satisfy.
    return { reason: `category '${category || '(missing)'}' is outside the rubric` }
  }

  const file = typeof obj.file === 'string' ? obj.file.trim() : ''
  const issue = typeof obj.issue === 'string' ? obj.issue.trim() : ''
  const requiredChange = typeof obj.requiredChange === 'string' ? obj.requiredChange.trim() : ''

  // A finding without a file or without a concrete change is an opinion. The
  // builder cannot act on it mechanically, so it would only produce another
  // failing attempt.
  if (!file) return { reason: 'no file' }
  if (!issue) return { reason: 'no issue' }
  if (!requiredChange) return { reason: 'no requiredChange — not mechanically actionable' }

  return {
    finding: {
      category: category as LeadRubricCategory,
      file,
      issue,
      requiredChange,
      ...(typeof obj.location === 'string' && obj.location.trim()
        ? { location: obj.location.trim() }
        : {}),
      ...(typeof obj.howVerified === 'string' && obj.howVerified.trim()
        ? { howVerified: obj.howVerified.trim() }
        : {})
    }
  }
}

function parseFindingsBlock(
  text: string,
  allowed: readonly string[]
): {
  findings: ReviewFinding[]
  rejected: { raw: unknown; reason: string }[]
  body: Record<string, unknown> | null
} {
  const matches = [...text.matchAll(REVIEW_REGEX)]
  if (matches.length === 0) return { findings: [], rejected: [], body: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(matches[matches.length - 1][1].trim())
  } catch {
    return { findings: [], rejected: [], body: null }
  }

  // Accept both `{ findings: […] }` and a bare array.
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(body?.findings)
      ? (body!.findings as unknown[])
      : []

  const findings: ReviewFinding[] = []
  const rejected: { raw: unknown; reason: string }[] = []
  for (const raw of rawFindings.slice(0, MAX_REVIEW_FINDINGS)) {
    const outcome = parseFinding(raw, allowed)
    if ('finding' in outcome) findings.push(outcome.finding)
    else rejected.push({ raw, reason: outcome.reason })
  }

  return { findings, rejected, body }
}

/**
 * Parse a peer-review response. Findings outside the four-category rubric are
 * rejected (and reported), never passed through to the builder.
 */
export function parsePeerReview(text: string): PeerReviewResult {
  const { findings, rejected } = parseFindingsBlock(text, PEER_RUBRIC_CATEGORIES)
  return { findings, rejected }
}

/**
 * Parse a lead-review response.
 *
 * A verdict is only `approved` when the model says so AND produced no findings:
 * "approved, but here are four things to change" is not an approval, and taking
 * the stated verdict at face value would ship the four things.
 */
export function parseLeadReview(text: string): LeadReviewResult {
  const { findings, rejected, body } = parseFindingsBlock(text, LEAD_RUBRIC_CATEGORIES)
  const stated = typeof body?.verdict === 'string' ? body.verdict.trim() : ''
  const verdict = stated === 'approved' && findings.length === 0 ? 'approved' : 'changes-required'
  return { verdict, findings, rejected }
}

// ── Tasks block ──

const TASKS_REGEX = /```blueprint-tasks\s*\n([\s\S]*?)```/g

/**
 * Repair a truncated blueprint-tasks JSON body by brace-balancing to the last
 * complete top-level element inside the `waves` array.
 *
 * Why this exists: models with long thinking narratives (GLM notably) can hit
 * their output cap mid-block, so the closing fence never arrives and the
 * extraction regex cannot match at all. When the fence DID arrive but the JSON
 * inside is cut mid-string, `JSON.parse` throws and the whole phase's work is
 * discarded — 25 of 27 tasks thrown away over a missing closing brace.
 *
 * The repair is conservative: it only ever TRUNCATES, never invents. It walks
 * the raw text tracking string/escape state, finds the last position where the
 * `waves` array contained only complete objects, and closes the structure
 * around what is provably there. Returns null when nothing complete can be
 * recovered.
 */
function repairTruncatedTasksJson(raw: string): Record<string, unknown> | null {
  // Locate the "waves" array start: "waves": [
  const wavesMatch = raw.match(/"waves"\s*:\s*\[/)
  if (!wavesMatch) return null
  const arrayStart = (wavesMatch.index ?? 0) + wavesMatch[0].length // first char after '['

  // Walk the text tracking JSON string state so braces inside strings don't
  // fool the depth counter.
  let depth = 1 // inside the waves array
  let inString = false
  let escaped = false
  let lastCompleteElementEnd = -1 // index AFTER the ']' or ',' closing a complete wave object
  let lastWaveObjectEnd = -1

  for (let i = arrayStart; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        // The waves array itself closed — the JSON was complete after all;
        // JSON.parse should have handled it. Nothing to repair.
        return null
      }
    } else if (ch === '{') {
      if (depth === 1) lastWaveObjectEnd = -1 // starting a new wave object
    } else if (ch === '}') {
      if (depth === 1) {
        lastWaveObjectEnd = i
      }
    } else if (ch === ',' && depth === 1 && lastWaveObjectEnd >= 0) {
      lastCompleteElementEnd = i // a comma at array depth follows a complete wave object
    }
  }

  if (lastCompleteElementEnd < 0 && lastWaveObjectEnd < 0) return null

  const cut = lastCompleteElementEnd >= 0 ? lastCompleteElementEnd : lastWaveObjectEnd + 1
  const repaired =
    raw.slice(0, cut) +
    (lastCompleteElementEnd >= 0 ? '' : '') +
    ']' +
    (raw.includes('"totalTasks"') ? '}' : '}')

  try {
    const parsed = JSON.parse(repaired) as Record<string, unknown>
    const waves = parsed.waves
    if (!Array.isArray(waves) || waves.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Parse the last blueprint-tasks block from streamed text.
 *
 * Extraction order:
 *   1. A complete fenced block that parses — the normal path.
 *   2. A fenced block whose JSON is truncated mid-string — repaired by
 *      brace-balancing to the last complete wave (see repairTruncatedTasksJson).
 *   3. An UNCLOSED fence (output cap hit mid-block, closing ``` never arrived)
 *      — treated as running to end-of-text and repaired the same way.
 *
 * Returns null if no block is found or nothing complete can be recovered.
 */
export function parseBlueprintTasks(text: string): Record<string, unknown> | null {
  if (text.length > 500_000) {
    // Same guard as parsePhaseCompletionBlock — don't run a regex over a
    // corrupted multi-megabyte stream.
    return null
  }

  const matches = [...text.matchAll(TASKS_REGEX)]

  let jsonStr: string | null = null
  if (matches.length > 0) {
    jsonStr = matches[matches.length - 1][1].trim()
  } else {
    // No closed fence. An opening ```blueprint-tasks with no closing ``` means
    // the stream was cut mid-block (output cap). Treat the rest of the text as
    // the block body and attempt repair.
    const openMatch = text.match(/```blueprint-tasks\s*\n([\s\S]*)$/)
    if (openMatch?.[1]) jsonStr = openMatch[1]
  }

  if (jsonStr === null) return null

  try {
    return JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return repairTruncatedTasksJson(jsonStr)
  }
}

/**
 * P2 — structured failure memory for a BUILD task retry.
 *
 * WHICH RETRY: the one that follows a THROW, not the one that follows a failed
 * gate. `buildTaskContext` injects the previous attempt's `build-partial`
 * artifact, and `build-partial` is written in exactly two places — the catch
 * block in `executeTask` and the phase-level exception handler. An attempt that
 * runs to completion and is then rejected by the gates writes no artifact, so
 * its retry has no transcript to compress and this module never runs for it
 * (that retry gets `gateFixInstructions` instead, which is already structured).
 * Read every "retry" below as "retry after an infrastructure failure".
 *
 * What it replaces on that path: a raw transcript tail, sliced at 4000
 * characters wherever that happens to land. It is unstructured, it is the END
 * of the attempt rather than the part that explains it, and the slice can cut a
 * sentence, a code fence or a path in half.
 *
 * What it produces instead: a FIXED SCHEMA. Deliberately not free-form
 * summarisation, for two reasons that both showed up in practice —
 *
 *   - Compression is unstable, not uniformly lossy. TRACE's finding is that
 *     what survives a summary varies run to run, so "smaller but still right"
 *     is not a property you get by asking for it.
 *   - A single distractor measurably degrades a model's performance (Chroma).
 *     A summary that keeps four irrelevant lines and drops the one that
 *     mattered is worse than the raw tail, not better.
 *
 * The concrete in-repo precedent: a package.json summariser dropped the `type`
 * key — the field that decides ESM vs CJS for every file the builder writes —
 * to save about forty characters. Exactly the class of mistake that costs a
 * retry. Named fields cannot silently drop the field that mattered; they can
 * only come back empty, which is visible.
 *
 * Failure is always survivable: every error path returns null and the caller
 * falls back to the raw dump it uses today.
 */

import log from 'electron-log'
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import type { GateReport } from '../../shared/gate-types'

const memoryLog = log.scope('blueprint-failure-memory')

/**
 * The fixed schema. Every field is optional-by-emptiness rather than
 * optional-by-absence: a field the extractor could not fill comes back empty
 * and is omitted from the render, so a partial extraction still helps.
 */
export interface FailureMemory {
  /** What the failed attempt was trying to do — one sentence, its approach. */
  hypothesisTried: string
  /** Files the attempt actually wrote or edited. */
  filesTouched: string[]
  /** The gate that rejected it ('task-tests', 'write-set', …), or '' if unknown. */
  failingGate: string
  /** First lines of the failure evidence — usually the error itself. */
  evidenceHead: string
  /** Last lines of the failure evidence — usually the summary/count. */
  evidenceTail: string
  /** Concrete things the next attempt must not do again. */
  doNotRepeat: string[]
}

/**
 * What one extraction cost, alongside what it produced.
 *
 * The plan's ceiling for this feature is Haiku staying under ~5% of build
 * tokens. `runOneShotClaude` already reports usage and cost; discarding them
 * here made that ceiling uncheckable, since the usage_log row is attributed to
 * the feature but not to the task or the attempt it belongs to.
 */
export interface FailureMemoryResult {
  memory: FailureMemory
  inputTokens: number
  outputTokens: number
  costCents: number
}

/** Injectable seam — the unit tests never make an LLM call. */
export interface FailureMemoryDeps {
  runClaude: typeof runOneShotClaude
  getModel: (workspaceId: string) => string
}

const DEFAULT_DEPS: FailureMemoryDeps = {
  runClaude: runOneShotClaude,
  getModel: (workspaceId) => modelConfigService.getModelById(workspaceId, 'haiku')
}

/**
 * Hard cap on the RENDERED block. The whole point of this work is to spend
 * fewer tokens on a retry than the 4000-char raw dump does, so the output is
 * capped below it rather than merely "usually smaller" — an extractor that
 * returns something long must not be able to cost more than what it replaced.
 */
export const MAX_RENDERED_CHARS = 2400

/**
 * Per-field caps, so one runaway field cannot crowd out the others.
 *
 * Sized so a normal extraction renders well inside `MAX_RENDERED_CHARS` and the
 * drop path in `renderFailureMemory` is the rare case rather than the default:
 * before this, twelve 200-char paths and six 300-char rules alone came to 4200
 * characters, which meant almost every full extraction was truncated.
 */
const MAX_HYPOTHESIS_CHARS = 400
const MAX_EVIDENCE_CHARS = 600
const MAX_FILES = 8
const MAX_FILE_CHARS = 120
const MAX_DO_NOT_REPEAT = 4
const MAX_RULE_CHARS = 200

/** Below this there is not enough transcript to extract anything from. */
const MIN_INPUT_CHARS = 200

/**
 * Keep the extractor's own input bounded. Head AND tail: the hypothesis is
 * stated at the start of an attempt and the evidence lands at the end, so a
 * tail-only window (what the raw dump effectively is) loses half the schema.
 */
const MAX_INPUT_CHARS = 24_000
const INPUT_HEAD_CHARS = 8_000

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extractor. You receive the transcript of a failed software build attempt and its quality-gate verdict, and you fill a fixed JSON schema describing what was tried and why it was rejected.

Rules:
- Report only what the transcript shows. Never invent a file, an error or a cause.
- "hypothesisTried" is ONE sentence naming the approach the attempt took — not what it should have done.
- "filesTouched" lists only paths the attempt actually wrote or edited, exactly as they appear.
- "failingGate" is the name of the gate that failed, copied verbatim from the verdict. Use "" if none is stated.
- "evidenceHead" is the first lines of the actual error output. "evidenceTail" is the last lines. Copy them; do not paraphrase.
- "doNotRepeat" lists concrete, checkable actions the next attempt must avoid, each tied to something in the transcript. Never generic advice.
- A field you cannot fill from the transcript must be "" or []. An empty field is correct; a guessed one is not.

Output schema (all fields required):
{
  "hypothesisTried": "<string>",
  "filesTouched": ["<path>", ...],
  "failingGate": "<string>",
  "evidenceHead": "<string>",
  "evidenceTail": "<string>",
  "doNotRepeat": ["<string>", ...]
}

Output ONLY valid JSON matching this exact schema — no markdown, no commentary, no fence blocks.`

/** Coerce an unknown JSON value into a bounded string. */
function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

/** Coerce an unknown JSON value into a bounded array of non-empty strings. */
function strArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => str(v, maxChars))
    .filter((s) => s !== '')
    .slice(0, maxItems)
}

/**
 * Parse the extractor's reply into the schema.
 *
 * Exported for the tests: this is where a malformed reply has to become `null`
 * rather than a half-built object, and it is the only part of the pipeline
 * whose behaviour is worth pinning without an LLM.
 */
export function parseFailureMemory(raw: string): FailureMemory | null {
  // Models fence JSON even when told not to. Strip it rather than fail — the
  // caller's only alternative is the raw dump this is meant to replace.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const memory: FailureMemory = {
    hypothesisTried: str(obj.hypothesisTried, MAX_HYPOTHESIS_CHARS),
    filesTouched: strArray(obj.filesTouched, MAX_FILES, MAX_FILE_CHARS),
    failingGate: str(obj.failingGate, 60),
    evidenceHead: str(obj.evidenceHead, MAX_EVIDENCE_CHARS),
    evidenceTail: str(obj.evidenceTail, MAX_EVIDENCE_CHARS),
    doNotRepeat: strArray(obj.doNotRepeat, MAX_DO_NOT_REPEAT, MAX_RULE_CHARS)
  }

  // An all-empty object is a failed extraction wearing the right shape. Handing
  // it to the caller would suppress the raw-dump fallback in exchange for a
  // heading and nothing under it.
  const empty =
    memory.hypothesisTried === '' &&
    memory.filesTouched.length === 0 &&
    memory.evidenceHead === '' &&
    memory.evidenceTail === '' &&
    memory.doNotRepeat.length === 0
  return empty ? null : memory
}

const RENDER_HEADER = '**⚠️ What the previous attempt did (structured):**'
const RENDER_INSTRUCTION =
  'Build on this — do NOT restart from scratch, and do NOT re-try the approach above. ' +
  'Re-read the listed files to confirm their current state before editing.'

/**
 * Evidence is command output, and command output contains fence markers often
 * enough to matter. Dropping them to two backticks keeps the text intact while
 * making it impossible for evidence to close the fence that wraps it — an
 * unbalanced fence swallows the retry instruction that follows it.
 */
function defence(evidence: string): string {
  return evidence.replace(/`{3,}/g, '``')
}

/**
 * Render the schema as the markdown block that goes into the retry prompt.
 *
 * Pure and capped. Empty fields are omitted entirely rather than rendered as
 * an empty heading: a labelled blank is a distractor, and distractors are the
 * documented failure mode this design is avoiding.
 *
 * The header and the trailing instruction are FIRST-CLASS, not text that
 * happens to be in the buffer: over budget, whole FIELDS are dropped from the
 * middle instead of slicing the tail off the joined string. Tail-slicing cut
 * the instruction — the only sentence telling the retry not to start over — and
 * could leave a fence open, so the block that most needed the instruction was
 * exactly the block that lost it.
 */
export function renderFailureMemory(memory: FailureMemory): string {
  // `drop` is the sacrifice order when the block is over budget — highest goes
  // first. `doNotRepeat` is last to go: it is the only part that tells the next
  // attempt what to change.
  const fields: { drop: number; lines: string[] }[] = []

  if (memory.doNotRepeat.length > 0) {
    fields.push({
      drop: 0,
      lines: ['- **Do NOT repeat**:', ...memory.doNotRepeat.map((item) => `  - ${item}`)]
    })
  }
  if (memory.failingGate) {
    fields.push({ drop: 1, lines: [`- **Rejected by gate**: ${memory.failingGate}`] })
  }
  if (memory.evidenceHead) {
    fields.push({
      drop: 2,
      lines: ['- **Failure evidence (start)**:', '```', defence(memory.evidenceHead), '```']
    })
  }
  if (memory.hypothesisTried) {
    fields.push({ drop: 3, lines: [`- **Approach tried**: ${memory.hypothesisTried}`] })
  }
  if (memory.filesTouched.length > 0) {
    fields.push({ drop: 4, lines: [`- **Files it wrote**: ${memory.filesTouched.join(', ')}`] })
  }
  // Only when it adds something: on a short failure the extractor legitimately
  // returns the same lines for both ends, and printing them twice spends tokens
  // to repeat itself.
  if (memory.evidenceTail && memory.evidenceTail !== memory.evidenceHead) {
    fields.push({
      drop: 5,
      lines: ['- **Failure evidence (end)**:', '```', defence(memory.evidenceTail), '```']
    })
  }

  // Rendered in reading order, dropped in `drop` order — the two are not the same.
  const READING_ORDER = [3, 1, 4, 2, 5, 0]
  const assemble = (kept: typeof fields): string =>
    [
      RENDER_HEADER,
      ...READING_ORDER.flatMap((d) => kept.find((f) => f.drop === d)?.lines ?? []),
      '',
      RENDER_INSTRUCTION
    ].join('\n')

  let kept = fields
  while (kept.length > 0 && assemble(kept).length > MAX_RENDERED_CHARS) {
    const victim = kept.reduce((worst, f) => (f.drop > worst.drop ? f : worst), kept[0])
    kept = kept.filter((f) => f !== victim)
  }
  return assemble(kept)
}

/** Bound the extractor's input from both ends — see MAX_INPUT_CHARS. */
function windowInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  const head = text.slice(0, INPUT_HEAD_CHARS)
  const tail = text.slice(-(MAX_INPUT_CHARS - INPUT_HEAD_CHARS))
  return `${head}\n\n[… middle truncated …]\n\n${tail}`
}

/** The gate verdict, as the few lines the extractor needs to name the failure. */
function summarizeGateReport(report: GateReport | null | undefined): string {
  if (!report) return 'No quality-gate verdict was recorded for the failed attempt.'
  const failed = report.gates.filter((g) => g.verdict === 'fail')
  if (failed.length === 0) return `Gate verdict: ${report.overall}. No individual gate failed.`
  return failed
    .map((g) => `Gate "${g.name}" FAILED:\n${(g.evidence ?? []).slice(0, 20).join('\n')}`)
    .join('\n\n')
}

/**
 * Extract a structured failure memory from a failed attempt.
 *
 * Returns null on every failure path — no transcript, an unparseable reply, a
 * CLI error, a timeout. Null means "use the raw dump", which is what the caller
 * did before this existed, so the worst case is the status quo plus one cheap
 * Haiku call.
 */
export async function extractFailureMemory(
  params: {
    /** The failed attempt's streamed content. */
    text: string
    gateReport?: GateReport | null
    /** Free-form reason, for the cases where no gate ran at all. */
    failureReason?: string | null
    blueprintId: string
    taskId: string
    workspaceId: string
  },
  deps: FailureMemoryDeps = DEFAULT_DEPS
): Promise<FailureMemoryResult | null> {
  const { text, blueprintId, taskId, workspaceId } = params

  if (text.trim().length < MIN_INPUT_CHARS) {
    memoryLog.info(
      `[extractFailureMemory] ${blueprintId}/${taskId}: only ${text.trim().length} chars — ` +
        'not enough to extract from, falling back to the raw dump'
    )
    return null
  }

  const userMessage = [
    'Extract what the failed build attempt tried and why it was rejected.',
    '',
    '<gate_verdict>',
    summarizeGateReport(params.gateReport),
    params.failureReason ? `\nReported failure reason: ${params.failureReason}` : '',
    '</gate_verdict>',
    '',
    '<attempt_transcript>',
    windowInput(text),
    '</attempt_transcript>'
  ].join('\n')

  let model: string
  try {
    model = deps.getModel(workspaceId)
  } catch (err) {
    memoryLog.warn(`[extractFailureMemory] ${blueprintId}/${taskId}: no haiku model resolved:`, err)
    return null
  }

  try {
    const {
      text: reply,
      usage,
      costCents
    } = await deps.runClaude({
      feature: 'blueprint_failure_memory',
      model,
      workspaceId,
      args: [
        '-p',
        userMessage,
        '--model',
        model,
        '--system-prompt',
        EXTRACTION_SYSTEM_PROMPT,
        '--permission-mode',
        'plan',
        '--max-turns',
        '1'
      ],
      // No retry loop, unlike the verify extractor: this call sits on the
      // critical path of a retry that is already slow, and its fallback (the
      // raw dump) is the behaviour we ship today. A second attempt would spend
      // up to another two minutes of wall clock to avoid the status quo.
      cli: { timeout: 120_000 }
    })
    const memory = parseFailureMemory(reply)
    if (!memory) {
      memoryLog.warn(
        `[extractFailureMemory] ${blueprintId}/${taskId}: reply did not parse — raw dump stands`
      )
      return null
    }
    return {
      memory,
      inputTokens: usage.input + usage.cacheRead + usage.cacheCreation,
      outputTokens: usage.output,
      costCents
    }
  } catch (err) {
    memoryLog.warn(`[extractFailureMemory] ${blueprintId}/${taskId}: extraction failed:`, err)
    return null
  }
}

/**
 * Shared parsers for Blueprint Clarify phase fenced JSON blocks.
 * Pure functions — imported by both main process and renderer for rehydration.
 */

import { z } from 'zod'
import type { GrillQuestion, GrillQuestionOption } from './types'

// ── Findings ──

const VALID_CATEGORIES = [
  'missing_requirements',
  'ambiguous_language',
  'unstated_assumptions',
  'conflicting_requirements',
  'missing_edge_cases',
  'incomplete_user_stories',
  'missing_success_criteria',
  'security_gaps',
  'performance_gaps'
] as const

export type ClarifyFindingCategory = (typeof VALID_CATEGORIES)[number]
export type ClarifyFindingSeverity = 'critical' | 'high' | 'medium' | 'low'
export type ClarifyFindingStatus = 'outstanding' | 'resolved' | 'deferred'

export interface ClarifyFinding {
  id: string
  category: ClarifyFindingCategory
  severity: ClarifyFindingSeverity
  status: ClarifyFindingStatus
  title: string
  description: string
  specRefs: string[]
  recommendation: string
  /**
   * Why this finding was auto-resolved instead of asked about — the citation the
   * clarify prompt requires. Optional: only resolved findings carry one, and
   * artifacts written before this field existed have none.
   */
  resolvedBy?: string
}

export interface ClarifyFindingsBlock {
  findings: ClarifyFinding[]
  summary: string
}

const FindingSchema = z.object({
  id: z.string().optional(),
  category: z.string().optional().default('missing_requirements'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
  status: z.enum(['outstanding', 'resolved', 'deferred']).optional().default('outstanding'),
  title: z.string().optional().default('Untitled finding'),
  description: z.string().optional().default(''),
  specRefs: z.array(z.string()).optional().default([]),
  recommendation: z.string().optional().default(''),
  // No `.default('')` — absence must stay distinguishable from "resolved for no
  // stated reason", and zod would otherwise strip this key entirely.
  resolvedBy: z.string().optional()
})

const FindingsBlockSchema = z.object({
  findings: z.array(FindingSchema).optional().default([]),
  summary: z.string().optional().default('')
})

// ── Questions ──

export interface ClarifyQuestionOption {
  label: string
  recommended: boolean
  recommendedReason?: string
}

export interface ClarifyQuestion {
  id: string
  header: string
  question: string
  multiSelect: boolean
  options: ClarifyQuestionOption[]
}

export interface ClarifyQuestionsBlock {
  questions: ClarifyQuestion[]
}

const QuestionOptionSchema = z.object({
  label: z.string(),
  recommended: z.boolean().optional().default(false),
  recommendedReason: z.string().optional()
})

const QuestionSchema = z.object({
  id: z.string().optional(),
  header: z.string().optional().default(''),
  question: z.string().optional().default(''),
  multiSelect: z.boolean().optional().default(false),
  options: z.array(QuestionOptionSchema).optional().default([])
})

const QuestionsBlockSchema = z.object({
  questions: z.array(QuestionSchema).optional().default([])
})

// ── Regex for fenced blocks ──

/** Info strings the pipeline treats as structured blocks rather than prose. */
const BLOCK_INFO_STRING =
  '(?:blueprint-[\\w-]+|council-verdict|grill-evaluation|goal-verify-[\\w-]+)'

/**
 * MERGED-FENCE-FIX: split a run of 6+ backticks that is glued to a block's info
 * string back into a closing fence and a separate opening fence.
 *
 * The clarify agent re-emits its findings every round, and when it puts the
 * closing fence of one block and the opening fence of the next on the SAME line
 * the two runs merge:
 *
 *     }
 *     ``````blueprint-clarify-findings
 *
 * Six backticks is never a legal single fence here — it is always close(3) +
 * open(3). Left alone it defeated `stripBlueprintBlocks`: the first block's
 * greedy `{3,} close swallowed all six, so the SECOND block lost its opening
 * backticks entirely and its label + JSON rendered as plain chat text, while its
 * real closing fence was left dangling as an empty code block.
 *
 * Runs of 4–5 are deliberately left alone — those are a legitimate wider fence
 * (as used by the prompt's own examples), not a merge.
 */
export function normalizeFenceRuns(text: string): string {
  return text.replace(new RegExp('`{6,}(?=[ \\t]*' + BLOCK_INFO_STRING + ')', 'g'), '```\n```')
}

// Openers and closers both accept 3-or-more backticks. Keeping the parser and
// the stripper on the SAME fence grammar is what prevents a block from being
// parsed but not stripped (or vice versa).
const FINDINGS_REGEX = /`{3,}[ \t]*blueprint-clarify-findings[ \t]*\r?\n([\s\S]*?)`{3,}/g
const QUESTIONS_REGEX = /`{3,}[ \t]*blueprint-clarify-questions[ \t]*\r?\n([\s\S]*?)`{3,}/g
const COMPLETION_REGEX = /`{3,}[ \t]*blueprint-phase-complete[ \t]*\r?\n([\s\S]*?)`{3,}/g

// ── Parsers ──

/**
 * LAST-MATCH-FIX: walk the emitted blocks newest → oldest and return the first
 * one that actually parses, instead of betting everything on the final match.
 *
 * The clarify agent re-emits its blocks every round, so a turn's text normally
 * carries several copies. The previous "take `matches[length - 1]`, return null
 * on any throw" shape meant ONE malformed emission discarded every good block
 * that came before it — the whole turn then logged as "zero parsed blocks" and
 * degraded to the free-text panel even though a well-formed block was present.
 *
 * Truncated tails and stray label lines are exactly the kind of damage that
 * lands on the LAST block (it is the one still streaming, or the one whose
 * opening fence a merged run swallowed), which is why the newest match is the
 * least trustworthy one to bet the turn on.
 *
 * Preserves "most recent re-emission wins" — it just no longer treats a single
 * bad block as fatal.
 */
function parseNewestParsableBlock<T>(
  text: string,
  regex: RegExp,
  transform: (raw: unknown) => T | null
): T | null {
  const matches = [...normalizeFenceRuns(text).matchAll(regex)]

  for (let i = matches.length - 1; i >= 0; i--) {
    let raw: unknown
    try {
      raw = JSON.parse(matches[i][1].trim())
    } catch {
      continue // malformed emission — fall back to the previous one
    }
    const result = transform(raw)
    if (result !== null) return result
  }

  return null
}

/**
 * Extract and parse the newest parsable blueprint-clarify-findings block.
 * Returns null only if no block found or every block fails to parse.
 * Tolerant: unknown categories coerced to 'missing_requirements', missing ids generated.
 */
export function parseClarifyFindings(text: string): ClarifyFindingsBlock | null {
  return parseNewestParsableBlock(text, FINDINGS_REGEX, (raw) => {
    const parsed = FindingsBlockSchema.safeParse(raw)
    if (!parsed.success) return null

    const block = parsed.data
    // Coerce and assign IDs
    const findings: ClarifyFinding[] = block.findings.map((f, i) => ({
      id: f.id || `f${i + 1}`,
      category: VALID_CATEGORIES.includes(f.category as ClarifyFindingCategory)
        ? (f.category as ClarifyFindingCategory)
        : 'missing_requirements',
      severity: f.severity,
      status: f.status,
      title: f.title,
      description: f.description,
      specRefs: f.specRefs,
      recommendation: f.recommendation,
      resolvedBy: f.resolvedBy
    }))

    return { findings, summary: block.summary }
  })
}

/**
 * Extract and parse the newest parsable blueprint-clarify-questions block.
 * Returns null only if no block found or every block fails to parse.
 * Tolerant: missing ids generated.
 */
export function parseClarifyQuestions(text: string): ClarifyQuestionsBlock | null {
  return parseNewestParsableBlock(text, QUESTIONS_REGEX, (raw) => {
    const parsed = QuestionsBlockSchema.safeParse(raw)
    if (!parsed.success) return null

    const block = parsed.data
    const questions: ClarifyQuestion[] = block.questions.map((q, i) => ({
      id: q.id || `q${i + 1}`,
      header: q.header,
      question: q.question,
      multiSelect: q.multiSelect,
      options: q.options.map((o) => ({
        label: o.label,
        recommended: o.recommended,
        recommendedReason: o.recommendedReason
      }))
    }))

    return { questions }
  })
}

/**
 * Parse the completion block from text.
 */
export function parseClarifyCompletion(
  text: string
): { phase: string; status: string; questionsAsked?: number; questionsAnswered?: number } | null {
  return parseNewestParsableBlock(text, COMPLETION_REGEX, (raw) => {
    const block = raw as { phase?: string; status?: string } | null
    if (block?.phase === 'clarify' && block?.status === 'complete') {
      return raw as { phase: string; status: string }
    }
    return null
  })
}

/**
 * Strip all blueprint fenced blocks from text for display purposes.
 * Removes any `blueprint-*` fenced block (findings, questions, phase-complete, tasks, plan, etc.)
 *
 * Patterns handled:
 * 1. Standard fenced blocks with 3+ backticks (open + close)
 * 2. Partial fenced blocks (opening fence present, no closing fence yet — mid-stream)
 */
// ── Question/Answer helpers ──

/** State for a single question's user response (mirrors Grill's QuestionState). */
export interface QuestionAnswerState {
  selectedOptions: string[]
  otherText: string
  otherSelected: boolean
  skipped: boolean
}

/**
 * Convert a ClarifyQuestion to a GrillQuestion so the shared QuestionItem
 * component can render it with radio/checkbox, recommended badges, and "Other".
 */
export function clarifyQuestionToGrillQuestion(q: ClarifyQuestion): GrillQuestion {
  const options: GrillQuestionOption[] = q.options.map((o) => ({
    label: o.label,
    recommended: o.recommended,
    recommendedReason: o.recommendedReason
  }))

  return {
    id: q.id,
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    allowOther: true,
    options
  }
}

/**
 * Format answered questions into a human-readable message for the chat transcript.
 * Includes selected options, Other free-text, and skipped marks.
 */
export function formatClarifyAnswerMessage(
  questions: ClarifyQuestion[],
  states: Record<string, QuestionAnswerState>
): string {
  const lines: string[] = []
  for (const q of questions) {
    const state = states[q.id]
    if (!state || state.skipped) {
      lines.push(`**${q.id} — ${q.header}**: _(skipped)_`)
      continue
    }
    const parts: string[] = [...state.selectedOptions]
    if (state.otherSelected && state.otherText.trim()) {
      parts.push(state.otherText.trim())
    }
    if (parts.length > 0) {
      lines.push(`**${q.id} — ${q.header}**: ${parts.join(', ')}`)
    } else {
      lines.push(`**${q.id} — ${q.header}**: _(skipped)_`)
    }
  }
  return lines.join('\n')
}

/**
 * Stable identity for a clarify question: id + exact text, so a genuinely
 * reworded follow-up counts as new while a verbatim re-emission does not.
 */
export function clarifyQuestionKey(q: ClarifyQuestion): string {
  return `${q.id}::${q.question}`
}

/**
 * Deduplicate questions: remove any question whose id+text match one in
 * `previouslyAsked`. Returns only genuinely new questions.
 *
 * NOTE: callers should pass the questions the user has already ANSWERED, not
 * every question ever displayed — the clarify prompt instructs the model to
 * re-emit still-unanswered questions, and those must survive dedupe.
 */
export function deduplicateClarifyQuestions(
  incoming: ClarifyQuestion[],
  previouslyAsked: ClarifyQuestion[]
): ClarifyQuestion[] {
  const askedSet = new Set(previouslyAsked.map(clarifyQuestionKey))
  return incoming.filter((q) => !askedSet.has(clarifyQuestionKey(q)))
}

// ── ask_user → ClarifyQuestion bridge ──

/**
 * Convert GrillQuestion[] (from ask_user tool call) into ClarifyQuestion[] suitable
 * for the clarify question card UI. Maps 1:1 — GrillQuestion and ClarifyQuestion share
 * the same semantic shape (id, header, question, multiSelect, options with recommended).
 */
export function grillQuestionsToClarifyBlock(questions: GrillQuestion[]): ClarifyQuestionsBlock {
  const mapped: ClarifyQuestion[] = questions.map((gq, idx) => ({
    id: gq.id || `aq${idx + 1}`,
    header: gq.header || '',
    question: gq.question,
    multiSelect: gq.multiSelect ?? false,
    options: (gq.options || []).map((o) => ({
      label: o.label,
      recommended: o.recommended ?? false,
      recommendedReason: o.recommendedReason
    }))
  }))
  return { questions: mapped }
}

// ── Strip helpers ──

/**
 * F10: strip an orphaned block CLOSER from a continuation segment.
 *
 * When a segment split lands inside a structured block (unfenced JSON, or a
 * fence the parity tracker missed), the FOLLOW-UP segment starts mid-content
 * and its first fence closes that block. Left alone, the JSON tail renders as
 * prose and the dangling ``` opens a phantom code block that swallows the
 * prose after it. Strip from segment start through that bare closing fence.
 *
 * Guarded against plain code blocks that legitimately OPEN a segment: the
 * fence must be bare (block closers never carry an info string — an opener
 * like ```ts fails the check), sit on its own line, and the text before it
 * must span no blank line (a blank line was a legal split point, so a true
 * continuation cannot cross one) and carry a JSON signal (block bodies are
 * JSON; plain code usually is not).
 */
export function stripOrphanedBlockCloser(text: string): string {
  const m = text.match(/`{3,}/)
  if (!m || m.index === undefined) return text

  const pre = text.slice(0, m.index)
  const rest = text.slice(m.index + m[0].length)

  // Fence must sit at line start (only whitespace since the last newline).
  const lineStart = pre.lastIndexOf('\n') + 1
  if (/[\S]/.test(pre.slice(lineStart))) return text
  // And be a closer: bare, ending the line (or the segment).
  if (!/^[ \t]*(?:\r?\n|$)/.test(rest)) return text

  const preTrimmed = pre.trim()
  if (!preTrimmed) return text // empty pre → indistinguishable from a plain opener; leave it
  if (/\n[ \t]*\n/.test(pre)) return text // blank line before the fence → not a continuation
  const jsonSignal =
    /^[{["]/.test(preTrimmed) || (/":/.test(preTrimmed) && /[}\]]$/.test(preTrimmed))
  if (!jsonSignal) return text

  // Strip start-of-segment through the closing fence (incl. its line break).
  return rest.replace(/^[ \t]*\r?\n/, '')
}

export function stripBlueprintBlocks(text: string): string {
  // 0. MERGED-FENCE-FIX: un-glue back-to-back blocks before anything else, so a
  //    greedy close can't eat the next block's opening fence.
  let cleaned = normalizeFenceRuns(text)

  // 1. Standard fenced blocks (3+ backticks on open and close)
  //    Covers: blueprint-*, council-verdict, grill-evaluation, goal-verify-*
  cleaned = cleaned.replace(
    new RegExp('`{3,}\\s*' + BLOCK_INFO_STRING + '\\s*\\n[\\s\\S]*?`{3,}', 'g'),
    ''
  )

  // 2. Partial fenced blocks (opening fence present, no closing fence yet — mid-stream).
  //    `[\s\S]*` is greedy, so it already runs to end-of-string — no anchor needed.
  cleaned = cleaned.replace(new RegExp('`{3,}\\s*' + BLOCK_INFO_STRING + '[\\s\\S]*', 'g'), '')

  // 3. F10: orphaned closer — the continuation segment of a block that was
  //    split mid-content. Its own strip pass cannot see the opener (it lived
  //    in the previous segment), so clean it here instead.
  cleaned = stripOrphanedBlockCloser(cleaned)

  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

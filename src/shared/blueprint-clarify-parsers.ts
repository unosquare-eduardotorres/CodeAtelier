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
  recommendation: z.string().optional().default('')
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

const FINDINGS_REGEX = /```blueprint-clarify-findings\s*\n([\s\S]*?)```/g
const QUESTIONS_REGEX = /```blueprint-clarify-questions\s*\n([\s\S]*?)```/g
const COMPLETION_REGEX = /```blueprint-phase-complete\s*\n([\s\S]*?)```/g

// ── Parsers ──

/**
 * Extract and parse the last blueprint-clarify-findings block from text.
 * Returns null if no block found or parsing fails entirely.
 * Tolerant: unknown categories coerced to 'missing_requirements', missing ids generated.
 */
export function parseClarifyFindings(text: string): ClarifyFindingsBlock | null {
  const matches = [...text.matchAll(FINDINGS_REGEX)]
  if (matches.length === 0) return null

  // Use the last match (most recent re-emission)
  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    const raw = JSON.parse(jsonStr)
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
      recommendation: f.recommendation
    }))

    return { findings, summary: block.summary }
  } catch {
    return null
  }
}

/**
 * Extract and parse the last blueprint-clarify-questions block from text.
 * Returns null if no block found or parsing fails entirely.
 * Tolerant: missing ids generated.
 */
export function parseClarifyQuestions(text: string): ClarifyQuestionsBlock | null {
  const matches = [...text.matchAll(QUESTIONS_REGEX)]
  if (matches.length === 0) return null

  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    const raw = JSON.parse(jsonStr)
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
  } catch {
    return null
  }
}

/**
 * Parse the completion block from text.
 */
export function parseClarifyCompletion(
  text: string
): { phase: string; status: string; questionsAsked?: number; questionsAnswered?: number } | null {
  const matches = [...text.matchAll(COMPLETION_REGEX)]
  if (matches.length === 0) return null

  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    const raw = JSON.parse(jsonStr)
    if (raw?.phase === 'clarify' && raw?.status === 'complete') {
      return raw
    }
    return null
  } catch {
    return null
  }
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
 * Deduplicate questions: remove any question whose id+text match one already asked.
 * Returns only genuinely new questions.
 */
export function deduplicateClarifyQuestions(
  incoming: ClarifyQuestion[],
  previouslyAsked: ClarifyQuestion[]
): ClarifyQuestion[] {
  const askedSet = new Set(
    previouslyAsked.map((q) => `${q.id}::${q.question}`)
  )
  return incoming.filter((q) => !askedSet.has(`${q.id}::${q.question}`))
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

export function stripBlueprintBlocks(text: string): string {
  let cleaned = text

  // 1. Standard fenced blocks (3+ backticks on open and close)
  //    Covers: blueprint-*, council-verdict, grill-evaluation, goal-verify-*
  cleaned = cleaned.replace(/`{3,}\s*(?:blueprint-[\w-]+|council-verdict|grill-evaluation|goal-verify-[\w-]+)\s*\n[\s\S]*?`{3,}/g, '')

  // 2. Partial fenced blocks (opening fence present, no closing fence yet — mid-stream)
  cleaned = cleaned.replace(/`{3,}\s*(?:blueprint-[\w-]+|council-verdict|grill-evaluation|goal-verify-[\w-]+)[\s\S]*$/g, '')

  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

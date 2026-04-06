/**
 * Structured output validation for specialist responses.
 *
 * Provides Zod-based schema validation for investigation reports and other
 * structured outputs, with multiple JSON extraction strategies and
 * auto-retry on parse failure.
 */
import { z } from 'zod'
import type { InvestigationReport } from '../../../shared/types'

// ── Validation Result Types ──

interface ValidationSuccess<T> {
  success: true
  data: T
  /** Which extraction strategy succeeded */
  strategy: ExtractionStrategy
}

interface ValidationFailure {
  success: false
  errors: string[]
  /** Raw text that was attempted to parse */
  rawText?: string
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

type ExtractionStrategy =
  | 'code-fence'       // ```json or ```investigation-report blocks
  | 'bracket-match'    // First { to last } or first [ to last ]
  | 'direct-parse'     // Try JSON.parse on the entire input

// ── JSON Extraction Strategies ──

/**
 * Try multiple strategies to extract JSON from LLM output.
 * LLMs frequently wrap JSON in markdown code fences, add leading/trailing text, etc.
 * Order: code-fence → bracket-match → direct-parse (most to least common).
 */
export function extractJSON(text: string): { json: string; strategy: ExtractionStrategy } | null {
  // Strategy 0: Prefer investigation-report fences (most specific — avoids false positives
  // from generic ```json blocks or bare ``` blocks in non-investigation output)
  const reportFenceRegex = /```investigation-report\s*\n([\s\S]*?)```/
  const reportMatch = text.match(reportFenceRegex)
  if (reportMatch) {
    const candidate = reportMatch[1].trim()
    if (isValidJSON(candidate)) {
      return { json: candidate, strategy: 'code-fence' }
    }
  }

  // Strategy 1: Explicit ```json code fences (no bare ``` — too greedy)
  const jsonFenceRegex = /```json\s*\n([\s\S]*?)```/
  const fenceMatch = text.match(jsonFenceRegex)
  if (fenceMatch) {
    const candidate = fenceMatch[1].trim()
    if (isValidJSON(candidate)) {
      return { json: candidate, strategy: 'code-fence' }
    }
  }

  // Strategy 2: Bracket matching — find outermost { } pair
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.substring(firstBrace, lastBrace + 1)
    if (isValidJSON(candidate)) {
      return { json: candidate, strategy: 'bracket-match' }
    }
  }

  // Strategy 2b: Bracket matching for arrays — find outermost [ ] pair
  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = text.substring(firstBracket, lastBracket + 1)
    if (isValidJSON(candidate)) {
      return { json: candidate, strategy: 'bracket-match' }
    }
  }

  // Strategy 3: Direct parse — maybe the entire string is valid JSON
  const trimmed = text.trim()
  if (isValidJSON(trimmed)) {
    return { json: trimmed, strategy: 'direct-parse' }
  }

  return null
}

function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// ── Zod Schemas ──

export const InvestigationReportSchema = z.object({
  problem: z.string().min(1),
  rootCause: z.string().min(1),
  proposedFix: z.string().min(1),
  filesAffected: z.array(z.object({
    path: z.string().min(1),
    reason: z.string().min(1)
  })),
  impact: z.enum(['very-low', 'low', 'medium', 'high', 'critical']),
  impactReason: z.string().min(1)
})

// Type assertion — ensures schema matches InvestigationReport interface
type SchemaOutput = z.infer<typeof InvestigationReportSchema>
const _typeCheck: InvestigationReport = {} as SchemaOutput // compile-time guard
void _typeCheck // suppress unused variable warning

// ── Investigation Report Validator ──

const VALID_IMPACT_LEVELS = new Set(['very-low', 'low', 'medium', 'high', 'critical'])

/**
 * Validate and parse an investigation report from specialist output.
 * Tries multiple JSON extraction strategies before failing.
 * Uses Zod schema for type-safe validation with field-level error reporting.
 */
export function validateInvestigationReport(
  text: string
): ValidationResult<InvestigationReport> {
  const extracted = extractJSON(text)
  if (!extracted) {
    return {
      success: false,
      errors: ['No valid JSON found in specialist output'],
      rawText: text.substring(0, 500)
    }
  }

  try {
    const parsed = JSON.parse(extracted.json)
    const result = InvestigationReportSchema.safeParse(parsed)

    if (result.success) {
      return { success: true, data: result.data as InvestigationReport, strategy: extracted.strategy }
    }

    return {
      success: false,
      errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      rawText: extracted.json.substring(0, 500)
    }
  } catch (error) {
    return {
      success: false,
      errors: [`JSON parse error: ${(error as Error).message}`],
      rawText: extracted.json.substring(0, 500)
    }
  }
}

/**
 * Validate a parsed JSON object against a Zod schema.
 * Returns a discriminated union with typed data on success or error messages on failure.
 */
export function validateWithSchema<T>(
  data: unknown,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; errors: string[] } {
  const result = schema.safeParse(data)
  if (result.success) return { success: true, data: result.data }
  return {
    success: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
  }
}

// ── Generic Schema Validator ──

// ── Fallback Report Builder ──

/**
 * Build a degraded investigation report when validation fails.
 * Preserves whatever fields are valid and fills in defaults for the rest.
 */
export function buildFallbackReport(
  partialData: Record<string, unknown> | null,
  reason: string
): InvestigationReport {
  return {
    problem: (typeof partialData?.problem === 'string' && partialData.problem)
      || 'Investigation completed but the report could not be fully parsed.',
    rootCause: (typeof partialData?.rootCause === 'string' && partialData.rootCause)
      || reason,
    proposedFix: (typeof partialData?.proposedFix === 'string' && partialData.proposedFix)
      || 'Check the specialist output above for details.',
    filesAffected: Array.isArray(partialData?.filesAffected)
      ? (partialData.filesAffected as InvestigationReport['filesAffected'])
      : [],
    impact: VALID_IMPACT_LEVELS.has(partialData?.impact as string)
      ? (partialData!.impact as InvestigationReport['impact'])
      : 'medium',
    impactReason: (typeof partialData?.impactReason === 'string' && partialData.impactReason)
      || `Validation failed: ${reason}`
  }
}

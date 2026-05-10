/**
 * Audit Response Parser — extracts structured data from auditor stream output.
 *
 * Two extraction strategies, tried in order:
 *
 * 1. **Progressive blocks** (preferred) — the auditor emits individual
 *    ```audit-finding blocks as it discovers issues, then a final
 *    ```audit-score block. Even if the model stops early, partial
 *    findings are captured.
 *
 * 2. **Legacy single JSON block** — one ```json ... ``` block containing
 *    { score, summary, findings[] }. Kept for backward compatibility.
 *
 * Both strategies inject generated UUIDs for each finding.
 */

import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import type { AuditFinding, AuditCoverageStats } from '../../shared/types'

const parserLog = log.scope('audit-parser')

export interface ParsedAuditResponse {
  score: number
  summary: string
  findings: AuditFinding[]
}

// ── Coverage gate ─────────────────────────────────────────────────────────

export interface CoverageGatedResult extends ParsedAuditResponse {
  coverageStats: AuditCoverageStats
  isSufficient: boolean
  coveragePercent: number | null
}

const MIN_FINDINGS_FOR_TRUST = 3
const MIN_FILES_FOR_TRUST = 2

/**
 * Apply a coverage gate to a parsed audit response.
 * Returns `isSufficient: false` when the audit didn't gather enough
 * evidence to trust the score — preventing hallucinated results.
 */
export function applyCoverageGate(
  parsed: ParsedAuditResponse,
  stats: AuditCoverageStats
): CoverageGatedResult {
  const isSufficient =
    parsed.findings.length >= MIN_FINDINGS_FOR_TRUST && stats.fileCount >= MIN_FILES_FOR_TRUST

  return {
    ...parsed,
    coverageStats: stats,
    isSufficient,
    coveragePercent: null // Set by the discovery phase (Tier 2)
  }
}

const VALID_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical'])

// ── Block extraction helpers ──────────────────────────────────────────────

/**
 * Extract all fenced code blocks with a given tag.
 * E.g. extractAllBlocks(text, 'audit-finding') finds all ```audit-finding ... ``` blocks.
 * Also matches blocks where the tag is on the same line as opening backticks with no newline.
 */
function extractAllBlocks(text: string, tag: string): string[] {
  // Primary regex: tag followed by newline then content
  const regex = new RegExp('```' + tag + '[\\t ]*\\n([\\s\\S]*?)```', 'g')
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim()
    if (content) blocks.push(content)
  }

  // Fallback: tag followed by JSON on the same line (no newline separator)
  if (blocks.length === 0) {
    const inlineRegex = new RegExp('```' + tag + '\\s*(\\{[\\s\\S]*?\\})\\s*```', 'g')
    while ((match = inlineRegex.exec(text)) !== null) {
      const content = match[1].trim()
      if (content) blocks.push(content)
    }
  }

  return blocks
}

/**
 * Extract the last fenced code block with a given tag (last one wins if multiple).
 */
function extractLastBlock(text: string, tag: string): string | null {
  const blocks = extractAllBlocks(text, tag)
  return blocks.length > 0 ? blocks[blocks.length - 1] : null
}

// ── Individual finding parser ─────────────────────────────────────────────

/**
 * Parse a single audit-finding JSON string into an AuditFinding.
 * Returns null if the JSON is malformed or missing required fields.
 */
function parseIndividualFinding(json: string): AuditFinding | null {
  try {
    const raw = JSON.parse(json)
    if (!raw || typeof raw !== 'object') return null

    const f = raw as Record<string, unknown>
    return {
      id: randomUUID(),
      severity: normalizeSeverity(f.severity),
      title: typeof f.title === 'string' ? f.title : 'Untitled finding',
      description: typeof f.description === 'string' ? f.description : '',
      filePath: typeof f.filePath === 'string' ? f.filePath : undefined,
      recommendation:
        typeof f.recommendation === 'string'
          ? f.recommendation
          : f.recommendation === null
            ? undefined
            : undefined
    }
  } catch {
    parserLog.warn(`[audit-parser] Failed to parse individual finding: ${json.slice(0, 200)}`)
    return null
  }
}

// ── Score inference from findings ─────────────────────────────────────────

/**
 * Infer a score from findings when no explicit audit-score block was emitted.
 * Starts at 100 and subtracts severity-weighted penalties.
 */
export function inferScoreFromFindings(findings: AuditFinding[]): number {
  if (findings.length === 0) return 0

  const penalties: Record<string, number> = {
    critical: 25,
    high: 15,
    medium: 8,
    low: 3,
    info: 0
  }

  const totalPenalty = findings.reduce((sum, f) => sum + (penalties[f.severity] ?? 0), 0)

  return Math.max(10, Math.min(100, 100 - totalPenalty))
}

// ── Main parser ───────────────────────────────────────────────────────────

function clampScore(value: unknown): number {
  const score = typeof value === 'number' ? Math.round(value) : 0
  return Math.max(0, Math.min(100, score))
}

/**
 * Parse the auditor's streaming response to extract the structured result.
 *
 * Strategy order:
 * 1. Progressive blocks (audit-finding + audit-score)
 * 2. Legacy single ```json block
 * 3. Bare JSON object fallback
 * 4. Fallback: score=0, summary=first 500 chars
 */
export function parseAuditResponse(text: string): ParsedAuditResponse {
  // ── Strategy 1: Progressive blocks (audit-finding + audit-score) ──
  const findingBlocks = extractAllBlocks(text, 'audit-finding')
  const scoreBlock = extractLastBlock(text, 'audit-score')

  if (findingBlocks.length > 0) {
    const findings = findingBlocks.map(parseIndividualFinding).filter(Boolean) as AuditFinding[]

    parserLog.info(
      `[audit-parser] Progressive extraction: ${findings.length}/${findingBlocks.length} findings parsed`
    )

    if (scoreBlock) {
      try {
        const parsed = JSON.parse(scoreBlock)
        return {
          score: clampScore(parsed.score),
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
          findings
        }
      } catch {
        parserLog.warn('[audit-parser] Failed to parse audit-score block — inferring from findings')
      }
    }

    // No score block or failed to parse — infer from findings
    return {
      score: inferScoreFromFindings(findings),
      summary: `Partial audit: ${findings.length} finding${findings.length !== 1 ? 's' : ''} discovered before analysis completed.`,
      findings
    }
  }

  // ── Strategy 2: Legacy single ```json block (backward compat) ──
  const jsonBlockRegex = /```json\s*\n([\s\S]*?)```/g
  let lastMatch: string | null = null
  let match: RegExpExecArray | null

  while ((match = jsonBlockRegex.exec(text)) !== null) {
    lastMatch = match[1].trim()
  }

  if (!lastMatch) {
    // Try bare JSON object as fallback (no code fence)
    const bareJsonRegex = /\{[\s\S]*"score"[\s\S]*"findings"[\s\S]*\}/
    const bareMatch = bareJsonRegex.exec(text)
    if (bareMatch) {
      lastMatch = bareMatch[0]
    }
  }

  if (!lastMatch) {
    parserLog.warn(
      `[audit-parser] No JSON block found in ${text.length}-char response. ` +
        `First 200 chars: ${text.slice(0, 200).replace(/\n/g, ' ')}`
    )

    // ── Strategy 3: Extract score from inline text patterns ──
    // The model might have written "Score: 85/100" or similar without a code block.
    const inlineScore = extractInlineScore(text)

    // Build a meaningful summary from the analysis text
    const analysisPreview = buildAnalysisPreview(text)

    return {
      score: inlineScore ?? 0,
      summary: analysisPreview || 'No structured response received from auditor.',
      findings: []
    }
  }

  try {
    const parsed = JSON.parse(lastMatch)
    return validateAndNormalize(parsed)
  } catch {
    return {
      score: 0,
      summary: `Failed to parse auditor response JSON. Raw excerpt: ${lastMatch.slice(0, 300)}`,
      findings: []
    }
  }
}

function validateAndNormalize(raw: unknown): ParsedAuditResponse {
  if (!raw || typeof raw !== 'object') {
    return { score: 0, summary: 'Invalid response shape', findings: [] }
  }

  const obj = raw as Record<string, unknown>

  // Score: must be 0-100 integer
  const score = clampScore(obj.score)

  // Summary: must be a string
  const summary = typeof obj.summary === 'string' ? obj.summary : ''

  // Findings: must be an array
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
  const findings: AuditFinding[] = rawFindings
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
    .map((f) => ({
      id: randomUUID(),
      severity: normalizeSeverity(f.severity),
      title: typeof f.title === 'string' ? f.title : 'Untitled finding',
      description: typeof f.description === 'string' ? f.description : '',
      filePath: typeof f.filePath === 'string' ? f.filePath : undefined,
      recommendation: typeof f.recommendation === 'string' ? f.recommendation : undefined
    }))

  return { score, summary, findings }
}

function normalizeSeverity(value: unknown): 'info' | 'low' | 'medium' | 'high' | 'critical' {
  if (typeof value === 'string' && VALID_SEVERITIES.has(value.toLowerCase())) {
    return value.toLowerCase() as 'info' | 'low' | 'medium' | 'high' | 'critical'
  }
  return 'info'
}

// ── Inline score extraction ───────────────────────────────────────────────

/**
 * Try to extract a numeric score from inline text when no structured block exists.
 * Matches patterns like "Score: 85/100", "Overall Score: 72", "**Score**: 90/100", etc.
 */
function extractInlineScore(text: string): number | null {
  // Match common score patterns in the text
  const patterns = [
    /(?:overall\s+)?score[:\s]+(\d{1,3})\s*(?:\/\s*100)?/i,
    /(\d{1,3})\s*\/\s*100\s*(?:overall|score)/i,
    /rating[:\s]+(\d{1,3})\s*(?:\/\s*100)?/i
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) {
      const score = parseInt(match[1], 10)
      if (score >= 0 && score <= 100) {
        parserLog.info(`[audit-parser] Extracted inline score: ${score}`)
        return score
      }
    }
  }

  return null
}

/**
 * Build a human-readable preview from the raw analysis text.
 * Strips tool call artifacts and produces a clean summary.
 */
function buildAnalysisPreview(text: string): string {
  if (!text || text.length < 20) return ''

  // Remove tool-use blocks and their results (artifacts from streaming)
  const cleaned = text
    .replace(/```(?:tool_use|tool_result)[\s\S]*?```/g, '')
    .replace(/\[Tool call:.*?\]/g, '')
    .trim()

  // Take the last meaningful paragraphs (the model usually summarizes at the end)
  const paragraphs = cleaned.split(/\n{2,}/).filter((p) => p.trim().length > 20)
  if (paragraphs.length === 0) return cleaned.slice(0, 800)

  // Prefer the last few paragraphs (likely the summary/conclusion)
  const summary = paragraphs.slice(-3).join('\n\n')
  return summary.length > 1000 ? summary.slice(0, 1000) + '…' : summary
}

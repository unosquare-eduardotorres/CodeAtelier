/**
 * Audit Response Parser — extracts structured JSON from auditor stream output.
 *
 * Auditors are instructed to emit exactly one ```json ... ``` block containing
 * { score, summary, findings[] }. This parser finds that block, validates it,
 * and injects generated UUIDs for each finding.
 */

import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import type { AuditFinding } from '../../shared/types'

const parserLog = log.scope('audit-parser')

export interface ParsedAuditResponse {
  score: number
  summary: string
  findings: AuditFinding[]
}

const VALID_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical'])

/**
 * Parse the auditor's streaming response to extract the structured JSON result.
 *
 * Strategy:
 * 1. Find ```json ... ``` block in text (last one wins if multiple)
 * 2. JSON.parse it
 * 3. Validate shape (score 0-100, findings array)
 * 4. Add generated UUIDs to each finding
 * 5. Fallback: if no valid JSON found, return score=0, summary=first 500 chars
 */
export function parseAuditResponse(text: string): ParsedAuditResponse {
  // Find all ```json ... ``` blocks (last one is most likely the final result)
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
    return {
      score: 0,
      summary: text.slice(0, 500).trim() || 'No structured response received from auditor.',
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
  let score = typeof obj.score === 'number' ? Math.round(obj.score) : 0
  score = Math.max(0, Math.min(100, score))

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

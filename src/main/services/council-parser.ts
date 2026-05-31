/**
 * council-parser.ts — pure-function parsers for council structured output blocks.
 *
 * Extracts ```council-review, ```council-peer-review, and ```council-verdict
 * fenced JSON blocks from Claude CLI output text. Each function validates
 * required fields and normalises optional arrays.
 *
 * Extracted from CouncilService to improve testability and reduce god-file size.
 */

import log from 'electron-log'
import type {
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict
} from '../../shared/types'

const councilLog = log.scope('council-parser')

// ── Helpers ─────────────────────────────────────────────────────────────

/** Extract the last fenced block matching ```<tag>\n...\n``` */
function extractLastFencedBlock(text: string, tag: string): string | null {
  const regex = new RegExp('```' + tag + '\\n([\\s\\S]*?)```', 'g')
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    lastMatch = match
  }

  return lastMatch ? lastMatch[1] : null
}

// ── Public API ──────────────────────────────────────────────────────────

/** Parse a ```council-review fenced block from advisor output. */
export function parseCouncilReview(
  text: string,
  expectedRole: CouncilAdvisorRole
): CouncilReview | null {
  const jsonStr = extractLastFencedBlock(text, 'council-review')
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr) as CouncilReview

    // Validate required fields
    if (
      typeof parsed.score !== 'number' ||
      !parsed.verdict ||
      !Array.isArray(parsed.keyFindings)
    ) {
      councilLog.warn(`[council:${expectedRole}] Parsed council-review has invalid structure`)
      return null
    }

    // Ensure role matches (or fill it in)
    parsed.advisorRole = expectedRole

    // Normalize optional arrays
    if (!parsed.blindSpots) parsed.blindSpots = []
    if (!parsed.evidence) parsed.evidence = []

    return parsed
  } catch (err) {
    councilLog.error(`[council:${expectedRole}] Failed to parse council-review JSON:`, err)
    return null
  }
}

/** Parse a ```council-peer-review fenced block from peer review output. */
export function parsePeerReview(
  text: string,
  reviewerRole: CouncilAdvisorRole
): CouncilPeerReview | null {
  const jsonStr = extractLastFencedBlock(text, 'council-peer-review')
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr)

    return {
      reviewerRole,
      strongestResponse: parsed.strongestResponse ?? 'A',
      strongestReason: parsed.strongestReason ?? '',
      biggestBlindSpot: parsed.biggestBlindSpot ?? 'A',
      blindSpotDescription: parsed.blindSpotDescription ?? '',
      missedByAll: parsed.missedByAll ?? ''
    }
  } catch (err) {
    councilLog.error(`[council:peer-review:${reviewerRole}] Failed to parse JSON:`, err)
    return null
  }
}

/** Parse a ```council-verdict fenced block from chairman output. */
export function parseCouncilVerdict(text: string): CouncilVerdict | null {
  const jsonStr = extractLastFencedBlock(text, 'council-verdict')
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr) as CouncilVerdict

    if (
      typeof parsed.overallScore !== 'number' ||
      !parsed.sections ||
      !parsed.sections.recommendation
    ) {
      councilLog.warn('[council:chairman] Parsed council-verdict has invalid structure')
      return null
    }

    // Normalize optional fields
    if (!parsed.revisions) parsed.revisions = []
    if (!parsed.individualScores) parsed.individualScores = {} as CouncilVerdict['individualScores']
    if (!parsed.rankingsMatrix) parsed.rankingsMatrix = {}

    return parsed
  } catch (err) {
    councilLog.error('[council:chairman] Failed to parse council-verdict JSON:', err)
    return null
  }
}

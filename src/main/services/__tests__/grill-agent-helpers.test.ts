/**
 * Unit tests for Grill Agent service pure functions — track validation,
 * session configuration, status transitions, result extraction.
 *
 * Phase 14, Track 8a — grill-agent.service.ts (~650 lines at ~29%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { GRILL_TRACKS } from '../../../shared/constants'

// ── Replicated pure logic from GrillAgentService ──


/**
 * Replicated from GrillAgentService.parseGrillEvaluation.
 * Extracts and validates grill evaluation from LLM response.
 */
function parseGrillEvaluation(text: string): {
  score: number
  questions: Array<{ question: string; severity: string }>
} | null {
  // Extract last grill-evaluation code block
  const regex = /```grill-evaluation\s*\n([\s\S]*?)```/g
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    lastMatch = match
  }

  if (!lastMatch) return null

  try {
    const parsed = JSON.parse(lastMatch[1])
    if (typeof parsed.score !== 'number' || !isFinite(parsed.score)) return null
    if (parsed.score < 0 || parsed.score > 10) return null
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
    return { score: parsed.score, questions: parsed.questions }
  } catch {
    return null
  }
}

/**
 * Replicated status transition logic.
 */
type GrillStatus = 'pending' | 'evaluating' | 'complete' | 'failed' | 'cancelled'

function transitionGrillStatus(
  current: GrillStatus,
  event: 'start' | 'complete' | 'fail' | 'cancel'
): GrillStatus {
  switch (event) {
    case 'start': return current === 'pending' ? 'evaluating' : current
    case 'complete': return current === 'evaluating' ? 'complete' : current
    case 'fail': return current === 'evaluating' ? 'failed' : current
    case 'cancel': return current === 'evaluating' || current === 'pending' ? 'cancelled' : current
  }
}

/**
 * Replicated decision parsing from grill output.
 */
function parseGrillDecision(text: string): 'proceed' | 'revise' | 'reject' | null {
  const lower = text.toLowerCase()
  if (lower.includes('"decision":"reject"') || lower.includes('"decision": "reject"')) return 'reject'
  if (lower.includes('"decision":"revise"') || lower.includes('"decision": "revise"')) return 'revise'
  if (lower.includes('"decision":"proceed"') || lower.includes('"decision": "proceed"')) return 'proceed'
  return null
}

// ── Tests ──

describe('Grill — track ID validation', () => {
  test('GRILL_TRACKS_contains_expected_tracks', () => {
    const trackIds = Object.keys(GRILL_TRACKS)
    assert.ok(trackIds.includes('architecture'))
    assert.ok(trackIds.includes('security'))
    assert.ok(trackIds.includes('requirements'))
    assert.ok(trackIds.includes('ux-ui'))
    assert.ok(trackIds.length >= 5)
  })

  test('each_track_has_name_and_description', () => {
    for (const [id, track] of Object.entries(GRILL_TRACKS)) {
      assert.ok((track as any).name, `Track ${id} missing name`)
      assert.ok((track as any).description, `Track ${id} missing description`)
    }
  })
})

describe('Grill — parseGrillEvaluation', () => {
  test('valid_grill_evaluation_block_parsed', () => {
    const text = '```grill-evaluation\n{"score": 7.5, "questions": [{"question": "Why?", "severity": "high"}]}\n```'
    const result = parseGrillEvaluation(text)
    assert.ok(result)
    assert.equal(result!.score, 7.5)
    assert.equal(result!.questions.length, 1)
  })

  test('multiple_blocks_uses_last_one', () => {
    const text = [
      '```grill-evaluation\n{"score": 3, "questions": [{"question": "Old?", "severity": "low"}]}\n```',
      'Some other text',
      '```grill-evaluation\n{"score": 8, "questions": [{"question": "New?", "severity": "high"}]}\n```'
    ].join('\n')
    const result = parseGrillEvaluation(text)
    assert.ok(result)
    assert.equal(result!.score, 8)
  })

  test('score_out_of_range_negative_returns_null', () => {
    const text = '```grill-evaluation\n{"score": -1, "questions": [{"question": "Q", "severity": "low"}]}\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('score_out_of_range_above_10_returns_null', () => {
    const text = '```grill-evaluation\n{"score": 11, "questions": [{"question": "Q", "severity": "low"}]}\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('missing_questions_returns_null', () => {
    const text = '```grill-evaluation\n{"score": 5}\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('empty_questions_returns_null', () => {
    const text = '```grill-evaluation\n{"score": 5, "questions": []}\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('malformed_JSON_returns_null', () => {
    const text = '```grill-evaluation\n{broken json\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('NaN_score_returns_null', () => {
    const text = '```grill-evaluation\n{"score": "high", "questions": [{"question": "Q", "severity": "low"}]}\n```'
    assert.equal(parseGrillEvaluation(text), null)
  })

  test('no_block_returns_null', () => {
    assert.equal(parseGrillEvaluation('No evaluation here'), null)
  })
})

describe('Grill — status transitions', () => {
  test('pending_start_goes_to_evaluating', () => {
    assert.equal(transitionGrillStatus('pending', 'start'), 'evaluating')
  })

  test('evaluating_complete_goes_to_complete', () => {
    assert.equal(transitionGrillStatus('evaluating', 'complete'), 'complete')
  })

  test('evaluating_fail_goes_to_failed', () => {
    assert.equal(transitionGrillStatus('evaluating', 'fail'), 'failed')
  })

  test('pending_cancel_goes_to_cancelled', () => {
    assert.equal(transitionGrillStatus('pending', 'cancel'), 'cancelled')
  })

  test('complete_start_stays_complete', () => {
    assert.equal(transitionGrillStatus('complete', 'start'), 'complete')
  })
})

describe('Grill — decision parsing', () => {
  test('proceed_decision_detected', () => {
    assert.equal(parseGrillDecision('{"decision": "proceed", "reason": "Looks good"}'), 'proceed')
  })

  test('revise_decision_detected', () => {
    assert.equal(parseGrillDecision('{"decision":"revise"}'), 'revise')
  })

  test('reject_decision_detected', () => {
    assert.equal(parseGrillDecision('Output:\n{"decision": "reject", "reason": "Too risky"}'), 'reject')
  })

  test('no_decision_returns_null', () => {
    assert.equal(parseGrillDecision('The plan looks good'), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

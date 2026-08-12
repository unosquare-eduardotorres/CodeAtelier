/**
 * Tests for grill-prompt-blocks.ts — shared prompt building blocks.
 *
 * Covers 4 exported functions that had 0% function coverage:
 * - buildReEvalBlock
 * - buildGrillEvaluationSchema
 * - buildGrillEvaluationSchemaLean
 * - isGrillLean
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildReEvalBlock,
  buildGrillEvaluationSchema,
  buildGrillEvaluationSchemaLean,
  isGrillLean,
  GRILL_QUESTION_QUALITY_RULES,
  GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA,
  GRILL_QUESTION_QUALITY_RULES_LEAN,
  GRILL_SCORING_RULES,
  GRILL_SCORING_RULES_LEAN
} from '../role-adapters/grill-prompt-blocks'

// ── buildReEvalBlock ──

describe('buildReEvalBlock', () => {
  test('undefined previousScore → empty string', () => {
    assert.equal(buildReEvalBlock(undefined), '')
  })

  test('previousScore = 0 → includes "0/100"', () => {
    const result = buildReEvalBlock(0)
    assert.ok(result.includes('0/100'), 'missing zero score')
    assert.ok(result.includes('## Re-evaluation Context'), 'missing heading')
  })

  test('previousScore = 85 → formatted with score and anchor instruction', () => {
    const result = buildReEvalBlock(85)
    assert.ok(result.includes('85/100'), 'missing score')
    assert.ok(result.includes('ANCHOR your new score'), 'missing anchor instruction')
    assert.ok(result.includes('Do NOT re-ask questions'), 'missing re-ask rule')
  })
})

// ── buildGrillEvaluationSchema ──

describe('buildGrillEvaluationSchema', () => {
  test('contains trackId interpolated', () => {
    const result = buildGrillEvaluationSchema('requirements')
    assert.ok(result.includes('"trackId": "requirements"'), 'missing trackId')
  })

  test('wrapped in grill-evaluation code fence', () => {
    const result = buildGrillEvaluationSchema('architecture')
    assert.ok(result.includes('```grill-evaluation'), 'missing opening fence')
    assert.ok(result.endsWith('```'), 'missing closing fence')
  })

  test('contains all required keys', () => {
    const result = buildGrillEvaluationSchema('requirements')
    const requiredKeys = ['score', 'scoreLabel', 'feedback', 'questions', 'suggestedNextTrack']
    for (const key of requiredKeys) {
      assert.ok(result.includes(`"${key}"`), `missing key: ${key}`)
    }
  })

  test('contains question structure keys', () => {
    const result = buildGrillEvaluationSchema('requirements')
    const questionKeys = [
      'id',
      'question',
      'header',
      'options',
      'label',
      'description',
      'recommended',
      'recommendedReason'
    ]
    for (const key of questionKeys) {
      assert.ok(result.includes(`"${key}"`), `missing question key: ${key}`)
    }
  })
})

// ── buildGrillEvaluationSchemaLean ──

describe('buildGrillEvaluationSchemaLean', () => {
  test('contains trackId interpolated', () => {
    const result = buildGrillEvaluationSchemaLean('requirements')
    assert.ok(result.includes('"requirements"'), 'missing trackId')
  })

  test('much shorter than full schema', () => {
    const full = buildGrillEvaluationSchema('requirements')
    const lean = buildGrillEvaluationSchemaLean('requirements')
    assert.ok(
      lean.length < full.length,
      `lean (${lean.length}) should be shorter than full (${full.length})`
    )
  })

  test('mentions all required keys compactly', () => {
    const result = buildGrillEvaluationSchemaLean('requirements')
    assert.ok(result.includes('score'), 'missing score')
    assert.ok(result.includes('scoreLabel'), 'missing scoreLabel')
    assert.ok(result.includes('feedback'), 'missing feedback')
    assert.ok(result.includes('questions'), 'missing questions')
    assert.ok(result.includes('suggestedNextTrack'), 'missing suggestedNextTrack')
  })

  test('uses different trackId (architecture)', () => {
    const result = buildGrillEvaluationSchemaLean('architecture')
    assert.ok(result.includes('"architecture"'), 'missing architecture trackId')
  })
})

// ── isGrillLean ──

describe('isGrillLean', () => {
  test('undefined model → false', () => {
    assert.equal(isGrillLean(undefined), false)
  })

  test('empty string → false', () => {
    assert.equal(isGrillLean(''), false)
  })

  test('claude-haiku-4-5 → false', () => {
    assert.equal(isGrillLean('claude-haiku-4-5'), false)
  })

  // Sonnet 4.6+ is deliberately in the lean set -- resolvePromptVerbosity in
  // shared/constants.ts:948 returns 'lean' for it (~800-1200 tokens/turn saved).
  // This case predates that and asserted the pre-4-6 behaviour.
  test('claude-sonnet-4-6 → true (lean model)', () => {
    assert.equal(isGrillLean('claude-sonnet-4-6'), true)
  })

  test('claude-opus-4-8 → true (lean model)', () => {
    assert.equal(isGrillLean('claude-opus-4-8'), true)
  })

  test('claude-fable-5 → true (lean model)', () => {
    assert.equal(isGrillLean('claude-fable-5'), true)
  })

  test('unknown model string → false', () => {
    assert.equal(isGrillLean('gpt-4o'), false)
  })
})

// ── Exported constants sanity checks ──

describe('grill-prompt-blocks constants', () => {
  test('GRILL_QUESTION_QUALITY_RULES is non-empty and contains heading', () => {
    assert.ok(GRILL_QUESTION_QUALITY_RULES.length > 50, 'too short')
    assert.ok(GRILL_QUESTION_QUALITY_RULES.includes('## Question Quality Rules'), 'missing heading')
  })

  test('GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA mentions DESIGN CHOICES', () => {
    assert.ok(GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA.includes('DESIGN CHOICES'))
  })

  test('GRILL_QUESTION_QUALITY_RULES_LEAN is shorter than full', () => {
    assert.ok(GRILL_QUESTION_QUALITY_RULES_LEAN.length < GRILL_QUESTION_QUALITY_RULES.length)
  })

  test('GRILL_SCORING_RULES contains all 5 score bands', () => {
    const bands = ['Raw', 'Warming Up', 'Medium Rare', 'Well Done', 'Perfectly Grilled']
    for (const band of bands) {
      assert.ok(GRILL_SCORING_RULES.includes(band), `missing band: ${band}`)
    }
  })

  test('GRILL_SCORING_RULES_LEAN is shorter than full', () => {
    assert.ok(GRILL_SCORING_RULES_LEAN.length < GRILL_SCORING_RULES.length)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

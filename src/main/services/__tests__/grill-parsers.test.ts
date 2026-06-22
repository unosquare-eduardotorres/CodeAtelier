/**
 * Unit tests for the pure parsers in grill-agent.service.ts and
 * grill-plan-generator.service.ts.
 *
 * parseGrillEvaluation and parsePlan are private — exercised via the exported
 * singletons with `as unknown as {…}` casts. No DB or CLI is touched.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { grillAgentService } from '../grill-agent.service'
import { grillPlanGeneratorService } from '../grill-plan-generator.service'

const grill = grillAgentService as unknown as {
  parseGrillEvaluation: (text: string) => { score: number; questions: unknown[] } | null
}
const planGen = grillPlanGeneratorService as unknown as {
  parsePlan: (
    text: string,
    fallback: string
  ) => { title: string; version: number; originalDescription: string } | null
}

function fence(tag: string, obj: unknown): string {
  return '```' + tag + '\n' + JSON.stringify(obj) + '\n```'
}

describe('parseGrillEvaluation', () => {
  const valid = { score: 7, questions: [{ q: 'why?' }] }

  test('parses a valid evaluation block', () => {
    const out = grill.parseGrillEvaluation(fence('grill-evaluation', valid))
    assert.ok(out)
    assert.equal(out!.score, 7)
    assert.equal(out!.questions.length, 1)
  })

  test('returns null when no block present', () => {
    assert.equal(grill.parseGrillEvaluation('no blocks'), null)
  })

  test('returns null when score is not a number', () => {
    assert.equal(
      grill.parseGrillEvaluation(fence('grill-evaluation', { score: 'x', questions: [1] })),
      null
    )
  })

  test('returns null when questions array is empty', () => {
    assert.equal(
      grill.parseGrillEvaluation(fence('grill-evaluation', { score: 5, questions: [] })),
      null
    )
  })

  test('returns null on malformed JSON', () => {
    assert.equal(grill.parseGrillEvaluation('```grill-evaluation\n{bad\n```'), null)
  })

  test('uses the last block when multiple present', () => {
    const text =
      fence('grill-evaluation', { score: 1, questions: [1] }) +
      '\n' +
      fence('grill-evaluation', { score: 9, questions: [1] })
    assert.equal(grill.parseGrillEvaluation(text)!.score, 9)
  })
})

describe('parsePlan', () => {
  // PLAN-GEN-01: Items must have all required fields (id, title, description, files, dependsOn)
  // to pass the new validatePlanStructure() check.
  const valid = {
    title: 'T',
    summary: 'S',
    items: [
      {
        id: 'item-1',
        title: 'Item One',
        description: 'Desc',
        scope: 'backend',
        files: ['src/a.ts'],
        dependsOn: [],
        includesTests: false
      }
    ]
  }

  test('parses a valid plan, sets version=1', () => {
    const out = planGen.parsePlan(fence('grill-plan', valid), 'fallback desc')
    assert.ok(out)
    assert.equal(out!.title, 'T')
    assert.equal(out!.version, 1)
  })

  test('populates originalDescription from the fallback when missing', () => {
    const out = planGen.parsePlan(fence('grill-plan', valid), 'the fallback')
    assert.equal(out!.originalDescription, 'the fallback')
  })

  test('keeps an explicit originalDescription', () => {
    const out = planGen.parsePlan(
      fence('grill-plan', { ...valid, originalDescription: 'explicit' }),
      'fallback'
    )
    assert.equal(out!.originalDescription, 'explicit')
  })

  test('returns null when required fields missing', () => {
    assert.equal(planGen.parsePlan(fence('grill-plan', { title: 'T' }), 'fb'), null)
  })

  test('returns null when no block present', () => {
    assert.equal(planGen.parsePlan('plain text', 'fb'), null)
  })

  test('returns null on malformed JSON', () => {
    assert.equal(planGen.parsePlan('```grill-plan\nnope\n```', 'fb'), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

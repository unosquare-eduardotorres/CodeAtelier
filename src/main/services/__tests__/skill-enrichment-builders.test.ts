/**
 * Unit tests for skill-enrichment.service.ts — pure logic tests.
 *
 * Tests parseEnrichment + parseRecommendations (via instance-access pattern),
 * plus the public isStale and computeSkillsHash methods.
 *
 * Phase 4E — ~12 tests. No I/O (parsing + hashing only).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { skillEnrichmentService } from '../skill-enrichment.service'

const svc = skillEnrichmentService as any

// ── parseEnrichment ──

describe('SkillEnrichmentService.parseEnrichment', () => {
  test('valid JSON → returns enrichment object', () => {
    const result = svc.parseEnrichment(
      JSON.stringify({
        keywords: ['typescript', 'electron', 'ipc'],
        applicableTo: 'When building Electron IPC handlers',
        complexity: 'intermediate'
      })
    )
    assert.deepEqual(result.keywords, ['typescript', 'electron', 'ipc'])
    assert.equal(result.applicableTo, 'When building Electron IPC handlers')
    assert.equal(result.complexity, 'intermediate')
  })

  test('JSON with markdown fences → fences stripped before parse', () => {
    const raw = '```json\n{"keywords":["react"],"applicableTo":"UI","complexity":"foundational"}\n```'
    const result = svc.parseEnrichment(raw)
    assert.deepEqual(result.keywords, ['react'])
    assert.equal(result.complexity, 'foundational')
  })

  test('malformed JSON → returns defaults', () => {
    const result = svc.parseEnrichment('not valid json at all')
    assert.deepEqual(result.keywords, [])
    assert.equal(result.applicableTo, 'Development skill')
    assert.equal(result.complexity, 'intermediate')
  })

  test('empty string → returns defaults', () => {
    const result = svc.parseEnrichment('')
    assert.deepEqual(result.keywords, [])
    assert.equal(result.complexity, 'intermediate')
  })

  test('keywords with non-string entries → filtered out', () => {
    const result = svc.parseEnrichment(
      JSON.stringify({
        keywords: ['valid', 42, null, 'also-valid', true],
        applicableTo: 'test',
        complexity: 'advanced'
      })
    )
    assert.deepEqual(result.keywords, ['valid', 'also-valid'])
  })

  test('keywords truncated to 10 max', () => {
    const manyKeywords = Array.from({ length: 15 }, (_, i) => `kw-${i}`)
    const result = svc.parseEnrichment(
      JSON.stringify({ keywords: manyKeywords, applicableTo: 'test', complexity: 'foundational' })
    )
    assert.equal(result.keywords.length, 10)
  })

  test('applicableTo truncated to 120 chars', () => {
    const longText = 'x'.repeat(200)
    const result = svc.parseEnrichment(
      JSON.stringify({ keywords: [], applicableTo: longText, complexity: 'foundational' })
    )
    assert.equal(result.applicableTo.length, 120)
  })

  test('invalid complexity → defaults to intermediate', () => {
    const result = svc.parseEnrichment(
      JSON.stringify({ keywords: [], applicableTo: 'test', complexity: 'expert' })
    )
    assert.equal(result.complexity, 'intermediate')
  })

  test('missing applicableTo → fallback string', () => {
    const result = svc.parseEnrichment(JSON.stringify({ keywords: [], complexity: 'advanced' }))
    assert.equal(result.applicableTo, 'General development skill')
  })
})

// ── parseRecommendations ──

describe('SkillEnrichmentService.parseRecommendations', () => {
  test('valid JSON → returns sorted recommendations', () => {
    const result = svc.parseRecommendations(
      JSON.stringify({
        recommendations: [
          { skillId: 'skill-a', relevance: 0.5, rationale: 'Somewhat relevant' },
          { skillId: 'skill-b', relevance: 0.9, rationale: 'Very relevant' }
        ]
      })
    )
    assert.equal(result.length, 2)
    assert.equal(result[0].skillId, 'skill-b', 'highest relevance first')
    assert.equal(result[1].skillId, 'skill-a')
  })

  test('filters out recommendations with relevance < 0.3', () => {
    const result = svc.parseRecommendations(
      JSON.stringify({
        recommendations: [
          { skillId: 'low', relevance: 0.1, rationale: 'Not relevant' },
          { skillId: 'high', relevance: 0.8, rationale: 'Relevant' }
        ]
      })
    )
    assert.equal(result.length, 1)
    assert.equal(result[0].skillId, 'high')
  })

  test('malformed JSON → returns empty array', () => {
    const result = svc.parseRecommendations('not json')
    assert.deepEqual(result, [])
  })

  test('JSON with markdown fences → fences stripped', () => {
    const raw =
      '```json\n{"recommendations":[{"skillId":"s1","relevance":0.7,"rationale":"ok"}]}\n```'
    const result = svc.parseRecommendations(raw)
    assert.equal(result.length, 1)
    assert.equal(result[0].skillId, 's1')
  })

  test('missing rationale → defaults to empty string', () => {
    const result = svc.parseRecommendations(
      JSON.stringify({
        recommendations: [{ skillId: 'skill-a', relevance: 0.5 }]
      })
    )
    assert.equal(result[0].rationale, '')
  })

  test('relevance clamped to [0, 1]', () => {
    const result = svc.parseRecommendations(
      JSON.stringify({
        recommendations: [{ skillId: 's1', relevance: 1.5, rationale: 'over' }]
      })
    )
    assert.equal(result[0].relevance, 1)
  })

  test('missing recommendations key → empty array', () => {
    const result = svc.parseRecommendations(JSON.stringify({ other: 'data' }))
    assert.deepEqual(result, [])
  })
})

// ── isStale ──

describe('SkillEnrichmentService.isStale', () => {
  test('same hash → not stale', () => {
    assert.equal(skillEnrichmentService.isStale('abc123', 'abc123'), false)
  })

  test('different hash → stale', () => {
    assert.equal(skillEnrichmentService.isStale('abc123', 'def456'), true)
  })

  test('null stored hash → stale', () => {
    assert.equal(skillEnrichmentService.isStale('abc123', null), true)
  })
})

// ── computeSkillsHash ──

describe('SkillEnrichmentService.computeSkillsHash', () => {
  test('deterministic for same input', () => {
    const skills = [
      { id: 'a', enrichmentJson: '{"x":1}' },
      { id: 'b', enrichmentJson: null }
    ]
    const hash1 = skillEnrichmentService.computeSkillsHash(skills)
    const hash2 = skillEnrichmentService.computeSkillsHash(skills)
    assert.equal(hash1, hash2)
  })

  test('different input → different hash', () => {
    const hash1 = skillEnrichmentService.computeSkillsHash([{ id: 'a', enrichmentJson: '{}' }])
    const hash2 = skillEnrichmentService.computeSkillsHash([{ id: 'b', enrichmentJson: '{}' }])
    assert.notEqual(hash1, hash2)
  })

  test('order-independent (sorts by ID)', () => {
    const hash1 = skillEnrichmentService.computeSkillsHash([
      { id: 'b', enrichmentJson: '2' },
      { id: 'a', enrichmentJson: '1' }
    ])
    const hash2 = skillEnrichmentService.computeSkillsHash([
      { id: 'a', enrichmentJson: '1' },
      { id: 'b', enrichmentJson: '2' }
    ])
    assert.equal(hash1, hash2)
  })

  test('returns 16-char hex string', () => {
    const hash = skillEnrichmentService.computeSkillsHash([{ id: 'x', enrichmentJson: null }])
    assert.equal(hash.length, 16)
    assert.ok(/^[0-9a-f]+$/.test(hash), 'should be hex')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

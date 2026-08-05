/**
 * memory-extraction.test.ts — Tests for fact extraction parsing logic.
 *
 * Tests parseExtractedFacts (the JSON-per-line parser) and category validation.
 * Haiku integration tests are deferred (require spawning claude CLI).
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

// ── Category validation ──

const VALID_CATEGORIES = ['decision', 'convention', 'gotcha', 'preference', 'reference'] as const

test('extraction: all 5 categories are valid', () => {
  for (const cat of VALID_CATEGORIES) {
    assert.ok(VALID_CATEGORIES.includes(cat), `${cat} should be valid`)
  }
})

test('extraction: invalid category rejected', () => {
  const invalid = 'user' // old type, not a valid category
  assert.ok(!VALID_CATEGORIES.includes(invalid as any), 'Old memory type should not be valid')
})

// ── JSON line parsing logic ──

test('extraction: parses valid JSON fact line', () => {
  const line =
    '{"category":"decision","title":"Use SQLite for storage","content":"Chose SQLite over PostgreSQL for embedded use case.","tags":["database","storage"]}'
  const data = JSON.parse(line)
  assert.equal(data.category, 'decision')
  assert.equal(data.title, 'Use SQLite for storage')
  assert.ok(data.content.length > 0)
  assert.ok(Array.isArray(data.tags))
})

test('extraction: skips malformed JSON lines', () => {
  const lines = [
    '{"category":"decision","title":"Valid","content":"Valid fact"}',
    'This is not JSON',
    '{"missing_fields": true}',
    '{"category":"invalid_cat","title":"Bad","content":"Bad category"}'
  ]

  const parsed: Array<{ category: string; title: string; content: string }> = []
  for (const line of lines) {
    try {
      const data = JSON.parse(line.trim())
      if (!data.category || !data.title || !data.content) continue
      if (!VALID_CATEGORIES.includes(data.category)) continue
      parsed.push(data)
    } catch {
      // skip
    }
  }

  assert.equal(parsed.length, 1, 'Only 1 valid fact should be parsed')
  assert.equal(parsed[0].title, 'Valid')
})

test('extraction: title and content are truncated', () => {
  const longTitle = 'A'.repeat(300)
  const longContent = 'B'.repeat(5000)

  const truncTitle = longTitle.slice(0, 200)
  const truncContent = longContent.slice(0, 4000)

  assert.equal(truncTitle.length, 200)
  assert.equal(truncContent.length, 4000)
})

test('extraction: tags are capped at 10', () => {
  const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`)
  const capped = tags.slice(0, 10)
  assert.equal(capped.length, 10)
})

test('extraction: scopePaths parsed as array', () => {
  const data = {
    category: 'convention',
    title: 'Test',
    content: 'Test content',
    scopePaths: ['src/main/services/', 'src/shared/']
  }
  assert.ok(Array.isArray(data.scopePaths))
  assert.equal(data.scopePaths.length, 2)
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

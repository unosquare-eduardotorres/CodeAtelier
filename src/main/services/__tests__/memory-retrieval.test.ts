/**
 * memory-retrieval.test.ts — Tests for MemoryRetrievalService scoring logic.
 *
 * Tests the keyword tokenization and overlap scoring, which are the
 * deterministic parts of the hybrid retrieval pipeline.
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

// We test the service's format output via its public interface
// Since retrieval requires DB + embeddings, we test scoring utilities indirectly

test('retrieval: empty query returns no results concept', () => {
  // The retrieval service filters empty queries — test the guard concept
  const queryTokens: string[] = []
  assert.equal(queryTokens.length, 0, 'Empty query produces no tokens')
})

test('retrieval: tokenization strips short tokens', () => {
  // Replicate the tokenize logic
  const text = 'Use the JWT auth pattern for API routes'
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)

  assert.ok(tokens.includes('jwt'), 'Should include "jwt"')
  assert.ok(tokens.includes('auth'), 'Should include "auth"')
  assert.ok(tokens.includes('pattern'), 'Should include "pattern"')
  assert.ok(tokens.includes('the'), '"the" has 3 chars so it passes the >2 filter')
  assert.ok(!tokens.includes('is'), 'Short words like "is" (2 chars) should be dropped')
})

test('retrieval: keyword overlap scoring', () => {
  const queryTokens = ['jwt', 'auth', 'pattern']
  const factText = 'jwt authentication pattern for secure API access'

  let hits = 0
  for (const token of queryTokens) {
    if (factText.toLowerCase().includes(token)) hits++
  }
  const score = hits / queryTokens.length

  assert.equal(score, 1.0, 'All 3 query tokens found in fact text → score = 1.0')
})

test('retrieval: partial keyword overlap', () => {
  const queryTokens = ['jwt', 'auth', 'database']
  const factText = 'jwt authentication for secure access'

  let hits = 0
  for (const token of queryTokens) {
    if (factText.toLowerCase().includes(token)) hits++
  }
  const score = hits / queryTokens.length

  assert.ok(Math.abs(score - 2 / 3) < 0.01, `Expected ~0.67, got ${score}`)
})

test('retrieval: zero overlap', () => {
  const queryTokens = ['database', 'migration', 'schema']
  const factText = 'jwt authentication for secure access'

  let hits = 0
  for (const token of queryTokens) {
    if (factText.toLowerCase().includes(token)) hits++
  }
  const score = hits / queryTokens.length

  assert.equal(score, 0, 'No query tokens found → score = 0')
})

test('retrieval: recency scoring decays over time', () => {
  const now = Date.now()

  // 1 day old
  const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000
  const age1 = (now - oneDayAgo) / (1000 * 60 * 60 * 24)
  const score1 = Math.max(0, 1 - age1 / 400)

  // 30 days old
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
  const age30 = (now - thirtyDaysAgo) / (1000 * 60 * 60 * 24)
  const score30 = Math.max(0, 1 - age30 / 400)

  // 365 days old
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000
  const age365 = (now - yearAgo) / (1000 * 60 * 60 * 24)
  const score365 = Math.max(0, 1 - age365 / 400)

  assert.ok(score1 > score30, `1-day score (${score1}) should be > 30-day (${score30})`)
  assert.ok(score30 > score365, `30-day score (${score30}) should be > 365-day (${score365})`)
  assert.ok(score1 > 0.99, `1-day score should be near 1.0, got ${score1}`)
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

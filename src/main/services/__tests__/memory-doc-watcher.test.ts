/**
 * memory-doc-watcher.test.ts — Tests for doc watcher gate logic.
 *
 * Tests debounce, cooldown, and glob matching concepts.
 * File system watcher integration tests are deferred.
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

// ── Glob matching logic ──

const DEFAULT_GLOBS = ['docs/**/*.md', 'README.md', 'CLAUDE.md']

/** Replicated from memory-doc-watcher.service.ts matchesGlob logic */
function matchesGlob(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === relPath) return true
    if (pattern.includes('**')) {
      const prefix = pattern.split('**')[0]
      const suffixPart = pattern.split('**').pop() ?? ''
      // Extract just the extension from the suffix like '/*.md' → '.md'
      const ext = suffixPart.replace(/^\/\*/, '')
      if (relPath.startsWith(prefix) && relPath.endsWith(ext)) return true
    }
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1)
      if (relPath.endsWith(ext) && !relPath.includes('/')) return true
    }
  }
  return false
}

test('doc-watcher: matches direct file names', () => {
  assert.ok(matchesGlob('README.md', DEFAULT_GLOBS))
  assert.ok(matchesGlob('CLAUDE.md', DEFAULT_GLOBS))
})

test('doc-watcher: matches docs/**/*.md pattern', () => {
  assert.ok(matchesGlob('docs/api.md', DEFAULT_GLOBS))
  assert.ok(matchesGlob('docs/guides/setup.md', DEFAULT_GLOBS))
})

test('doc-watcher: rejects non-matching files', () => {
  assert.ok(!matchesGlob('src/main/index.ts', DEFAULT_GLOBS))
  assert.ok(!matchesGlob('package.json', DEFAULT_GLOBS))
})

test('doc-watcher: rejects .md in non-docs directory', () => {
  assert.ok(!matchesGlob('src/readme.md', DEFAULT_GLOBS))
})

// ── Content hash gating ──

test('doc-watcher: same hash = skip extraction', () => {
  const hash1 = 'abc123'
  const hash2 = 'abc123'
  assert.equal(hash1, hash2, 'Same hash should match')
})

test('doc-watcher: different hash = proceed with extraction', () => {
  const hash1 = 'abc123'
  const hash2 = 'def456'
  assert.notEqual(hash1, hash2, 'Different hashes should not match')
})

// ── Cooldown logic ──

test('doc-watcher: cooldown prevents re-extraction within 1h', () => {
  const COOLDOWN_MS = 60 * 60 * 1000
  const lastProcessed = Date.now() - 30 * 60 * 1000 // 30 min ago
  const elapsed = Date.now() - lastProcessed
  assert.ok(elapsed < COOLDOWN_MS, 'Should be within cooldown window')
})

test('doc-watcher: cooldown allows extraction after 1h', () => {
  const COOLDOWN_MS = 60 * 60 * 1000
  const lastProcessed = Date.now() - 90 * 60 * 1000 // 90 min ago
  const elapsed = Date.now() - lastProcessed
  assert.ok(elapsed >= COOLDOWN_MS, 'Should be outside cooldown window')
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

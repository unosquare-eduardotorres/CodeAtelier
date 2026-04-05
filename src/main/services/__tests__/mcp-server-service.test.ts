/**
 * Unit tests for parseRepomapFiles and enrichFilesDiscussed pure functions.
 * Tests parsing of repomap output and multi-source file merging.
 */
import assert from 'node:assert/strict'
import { parseRepomapFiles, enrichFilesDiscussed } from '../mcp-server.service'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── parseRepomapFiles ──────────────────────────────────────

describe('parseRepomapFiles', () => {
  test('parses standard repomap output with file paths', () => {
    const mapText = `src/main/services/generalist.service.ts:
(Rank value: 0.42)
│   class GeneralistService
│   method start
│   method send

src/shared/constants.ts:
(Rank value: 0.31)
│   IPC_CHANNELS
│   AGENT_IDS`

    const files = parseRepomapFiles(mapText)
    assert.deepEqual(files, [
      'src/main/services/generalist.service.ts',
      'src/shared/constants.ts'
    ])
  })

  test('filters out non-file lines (no / or .)', () => {
    const mapText = `src/index.ts:
(Rank value: 0.5)

SomeRandomLabel:
(Rank value: 0.1)`

    const files = parseRepomapFiles(mapText)
    assert.deepEqual(files, ['src/index.ts'])
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(parseRepomapFiles(''), [])
  })

  test('returns empty array for input with no file patterns', () => {
    const mapText = `No files found in this repository.`
    assert.deepEqual(parseRepomapFiles(mapText), [])
  })

  test('handles file paths with dots but no slashes', () => {
    const mapText = `package.json:
(Rank value: 0.8)

tsconfig.json:
(Rank value: 0.6)`

    const files = parseRepomapFiles(mapText)
    assert.deepEqual(files, ['package.json', 'tsconfig.json'])
  })

  test('handles deeply nested paths', () => {
    const mapText = `src/renderer/src/components/workspace/RepositorySettingsTab.tsx:
(Rank value: 0.25)`

    const files = parseRepomapFiles(mapText)
    assert.deepEqual(files, [
      'src/renderer/src/components/workspace/RepositorySettingsTab.tsx'
    ])
  })
})

// ── enrichFilesDiscussed ──────────────────────────────────────

describe('enrichFilesDiscussed', () => {
  test('merges sources by priority order', () => {
    const { files } = enrichFilesDiscussed([
      { source: 'repomap', files: ['b.ts', 'c.ts'], priority: 1 },
      { source: 'generalist', files: ['a.ts', 'b.ts'], priority: 0 }
    ])
    // generalist (priority 0) files come first, then repomap adds c.ts (b.ts deduped)
    assert.deepEqual(files, ['a.ts', 'b.ts', 'c.ts'])
  })

  test('deduplicates case-insensitively', () => {
    const { files } = enrichFilesDiscussed([
      { source: 'generalist', files: ['src/Index.ts'], priority: 0 },
      { source: 'repomap', files: ['src/index.ts', 'src/other.ts'], priority: 1 }
    ])
    // src/index.ts is a case-insensitive duplicate of src/Index.ts
    assert.deepEqual(files, ['src/Index.ts', 'src/other.ts'])
  })

  test('caps at maxFiles (default 15)', () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `file-${i}.ts`)
    const { files } = enrichFilesDiscussed([
      { source: 'generalist', files: manyFiles, priority: 0 }
    ])
    assert.equal(files.length, 15)
  })

  test('caps at custom maxFiles', () => {
    const manyFiles = Array.from({ length: 10 }, (_, i) => `file-${i}.ts`)
    const { files } = enrichFilesDiscussed(
      [{ source: 'generalist', files: manyFiles, priority: 0 }],
      5
    )
    assert.equal(files.length, 5)
  })

  test('tracks contributions per source', () => {
    const { contributions } = enrichFilesDiscussed([
      { source: 'generalist', files: ['a.ts', 'b.ts'], priority: 0 },
      { source: 'repomap', files: ['b.ts', 'c.ts', 'd.ts'], priority: 1 }
    ])
    assert.equal(contributions.generalist, 2)
    assert.equal(contributions.repomap, 2) // b.ts deduped, c.ts + d.ts added
  })

  test('handles empty sources gracefully', () => {
    const { files, contributions } = enrichFilesDiscussed([
      { source: 'generalist', files: [], priority: 0 },
      { source: 'repomap', files: ['a.ts'], priority: 1 }
    ])
    assert.deepEqual(files, ['a.ts'])
    assert.equal(contributions.generalist, 0)
    assert.equal(contributions.repomap, 1)
  })

  test('handles no sources', () => {
    const { files, contributions } = enrichFilesDiscussed([])
    assert.deepEqual(files, [])
    assert.deepEqual(contributions, {})
  })

  test('3-source merge (forward-compat for Phase 2 semantic)', () => {
    const { files, contributions } = enrichFilesDiscussed([
      { source: 'generalist', files: ['a.ts', 'b.ts'], priority: 0 },
      { source: 'repomap', files: ['c.ts', 'd.ts'], priority: 1 },
      { source: 'semantic', files: ['e.ts', 'a.ts'], priority: 2 }
    ])
    assert.deepEqual(files, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
    assert.equal(contributions.generalist, 2)
    assert.equal(contributions.repomap, 2)
    assert.equal(contributions.semantic, 1) // a.ts deduped, only e.ts added
  })

  test('priority order is respected regardless of input order', () => {
    const { files } = enrichFilesDiscussed([
      { source: 'semantic', files: ['z.ts'], priority: 2 },
      { source: 'generalist', files: ['a.ts'], priority: 0 },
      { source: 'repomap', files: ['m.ts'], priority: 1 }
    ])
    // Should be ordered by priority: generalist first, then repomap, then semantic
    assert.deepEqual(files, ['a.ts', 'm.ts', 'z.ts'])
  })
})

console.log(`\n─── mcp-server-service.test.ts: ${passed} passed, ${failed} failed ───`)
if (failed > 0) process.exit(1)

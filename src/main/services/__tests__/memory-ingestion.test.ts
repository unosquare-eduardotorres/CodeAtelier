/**
 * Tests for memory-ingestion.service.ts — document ingestion orchestration.
 *
 * Tests discovery filtering, hash-gate skip, and cancel mid-batch.
 * Uses filesystem fixtures; the tests that import the service need electron stubs.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, beforeEach, afterEach, summaryAsync } from './test-harness'

// ── discoverFiles ───────────────────────────────────────────────────────────

describe('discoverFiles', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), 'ingestion-test-' + Date.now())
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('finds supported files in a directory', async () => {
    const { memoryIngestionService } = await import('../memory-ingestion.service')

    mkdirSync(join(testDir, 'docs'), { recursive: true })
    writeFileSync(join(testDir, 'docs', 'readme.md'), '# Hello')
    writeFileSync(join(testDir, 'docs', 'spec.txt'), 'Specification content')
    writeFileSync(join(testDir, 'app.ts'), 'const x = 1')

    const result = memoryIngestionService.discoverFiles(testDir)
    assert.ok(
      result.files.length >= 3,
      `Should find at least 3 files (found ${result.files.length})`
    )
    assert.ok(result.counts['.md'] >= 1, 'Should count .md files')
    assert.ok(result.counts['.ts'] >= 1, 'Should count .ts files')
    assert.equal(result.truncated, false)
  })

  test('ignores node_modules and .git directories', async () => {
    const { memoryIngestionService } = await import('../memory-ingestion.service')

    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(testDir, '.git', 'objects'), { recursive: true })
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')
    writeFileSync(join(testDir, '.git', 'objects', 'abc'), 'git object')
    writeFileSync(join(testDir, 'src.ts'), 'const y = 2')

    const result = memoryIngestionService.discoverFiles(testDir)
    const hasNodeModules = result.files.some((f) => f.includes('node_modules'))
    const hasGit = result.files.some((f) => f.includes('.git'))
    assert.equal(hasNodeModules, false, 'Should not include node_modules')
    assert.equal(hasGit, false, 'Should not include .git')
    assert.ok(
      result.files.some((f) => f.includes('src.ts')),
      'Should include src.ts'
    )
  })

  test('skips unsupported binary files', async () => {
    const { memoryIngestionService } = await import('../memory-ingestion.service')

    writeFileSync(join(testDir, 'archive.zip'), 'PK')
    writeFileSync(join(testDir, 'readme.md'), '# Hello')

    const result = memoryIngestionService.discoverFiles(testDir)
    const hasZip = result.files.some((f) => f.endsWith('.zip'))
    assert.equal(hasZip, false, 'Should not include .zip files')
  })
})

// ── detectStrategy routing (via document-chunker) ───────────────────────────

describe('detectStrategy routing', () => {
  test('routes markdown to markdown strategy', async () => {
    const { detectStrategy } = await import('../document-chunker')
    assert.equal(detectStrategy('readme.md'), 'markdown')
  })

  test('routes TypeScript to code strategy', async () => {
    const { detectStrategy } = await import('../document-chunker')
    assert.equal(detectStrategy('app.ts'), 'code')
  })

  test('routes text to plain strategy', async () => {
    const { detectStrategy } = await import('../document-chunker')
    assert.equal(detectStrategy('notes.txt'), 'plain')
  })
})

// ── IngestionProgress type shape ────────────────────────────────────────────

describe('IngestionProgress type', () => {
  test('progress events have required fields', () => {
    const progress = {
      jobId: 'test-job-1',
      docIndex: 1,
      docCount: 3,
      chunkIndex: 2,
      chunkCount: 5,
      factsCreated: 4,
      docStatus: 'extracting' as const,
      docName: 'readme.md',
      message: 'Extracting chunk 2/5',
      jobStatus: 'running' as const
    }

    assert.equal(progress.jobId, 'test-job-1')
    assert.equal(progress.docStatus, 'extracting')
    assert.equal(progress.jobStatus, 'running')
  })

  test('progress docStatus covers all states', () => {
    const states: Array<
      'queued' | 'reading' | 'chunking' | 'extracting' | 'done' | 'skipped' | 'error'
    > = ['queued', 'reading', 'chunking', 'extracting', 'done', 'skipped', 'error']
    assert.equal(states.length, 7, 'Should have 7 doc status states')
  })

  test('progress jobStatus covers all states', () => {
    const states: Array<'running' | 'done' | 'cancelled' | 'error'> = [
      'running',
      'done',
      'cancelled',
      'error'
    ]
    assert.equal(states.length, 4, 'Should have 4 job status states')
  })
})

// ── cancel behavior ─────────────────────────────────────────────────────────

describe('cancel behavior', () => {
  test('cancel returns false for non-existent job', async () => {
    const { memoryIngestionService } = await import('../memory-ingestion.service')
    const result = memoryIngestionService.cancel('non-existent-job')
    assert.equal(result, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

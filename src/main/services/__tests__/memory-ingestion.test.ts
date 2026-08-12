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
import { test, describe, beforeEach, afterEach, summaryAsync, runExclusive } from './test-harness'

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

// ── cancel signal reaches the extractor ──────────────────────────────────────

/**
 * `ingestSingleFile` checks `signal.aborted` between chunks but used to drop the
 * signal on the floor when calling the extractor, so a cancelled job kept
 * sleeping through ~14s of retry backoff — and kept spawning summarizers — per
 * in-flight chunk. Under the old code `captured.opts.signal` was `undefined`
 * and `captured.onProgress` was `undefined`.
 *
 * The extractor stub is installed for the duration of the case only, and
 * delegates for any source ref it does not own, so the other files in the
 * shared runner that stub the same singleton are unaffected.
 */
describe('ingestSingleFile — cancellation wiring', () => {
  const DOC_NAME = 'ingest-signal-fixture.md'
  const DOC_BODY = [
    '# Ingestion fixture',
    '',
    'Prose with enough substance to clear the extractor minimum length. '.repeat(8),
    '',
    '## Details',
    '',
    'More prose so the chunker has something to work with in this section. '.repeat(8)
  ].join('\n')

  interface Captured {
    calls: number
    opts?: any
    onProgress?: unknown
  }

  /**
   * Run `fn` with the repository hash gate and the extractor stubbed out, then
   * restore both. Serialized against other singleton-patching suites.
   */
  async function withStubs(
    fn: (svc: any, captured: Captured, filePath: string) => Promise<void>
  ): Promise<void> {
    await runExclusive(async () => {
      // The service is imported first on purpose: it pulls in db/index and the
      // fact repository transitively, so the repository import below resolves
      // from cache instead of cold-loading into the `BaseRepository` TDZ cycle.
      const { memoryIngestionService } = await import('../memory-ingestion.service')
      const { memoryExtractionService } = await import('../memory-extraction.service')
      const { memoryFactRepository } = await import('../../db/repositories/memory-fact.repository')

      const dir = join(tmpdir(), `ingest-signal-${process.pid}-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, DOC_NAME)
      writeFileSync(filePath, DOC_BODY, 'utf-8')

      const repo = memoryFactRepository as any
      const ext = memoryExtractionService as any
      const prevGet = repo.getDocState
      const prevUpsert = repo.upsertDocState
      const prevExtract = ext.extractFromContent
      const captured: Captured = { calls: 0 }

      repo.getDocState = (ws: string, p: string) =>
        p === filePath ? undefined : prevGet.call(repo, ws, p)
      repo.upsertDocState = (ws: string, p: string, hash: string) =>
        p === filePath ? undefined : prevUpsert.call(repo, ws, p, hash)
      ext.extractFromContent = async (...args: any[]) => {
        if (args[2] !== DOC_NAME) return prevExtract.apply(ext, args)
        captured.calls++
        captured.onProgress = args[4]
        captured.opts = args[5]
        return 2
      }

      try {
        await fn(memoryIngestionService, captured, filePath)
      } finally {
        repo.getDocState = prevGet
        repo.upsertDocState = prevUpsert
        ext.extractFromContent = prevExtract
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('forwards the job signal and a progress callback to the extractor', async () => {
    await withStubs(async (svc, captured, filePath) => {
      const controller = new AbortController()
      const messages: string[] = []

      const facts = await svc.ingestSingleFile(
        filePath,
        'ws-test',
        join(filePath, '..'),
        DOC_NAME,
        0,
        1,
        'job-1',
        controller.signal,
        (p: any) => messages.push(p.message ?? '')
      )

      assert.ok(captured.calls > 0, 'the fixture must actually reach the extractor')
      assert.equal(facts, 2 * captured.calls, 'facts are summed across chunks')
      assert.equal(captured.opts?.signal, controller.signal, 'the job signal must be forwarded')
      assert.equal(captured.opts?.sourceType, 'document')
      assert.equal(
        typeof captured.onProgress,
        'function',
        'extractor status must surface so a backoff does not look like a freeze'
      )

      // The forwarded callback feeds the same emit the panel renders.
      ;(captured.onProgress as (p: any) => void)({ message: 'Rate limited — retrying in 4s…' })
      assert.ok(
        messages.includes('Rate limited — retrying in 4s…'),
        'extractor status reaches the ingestion progress stream'
      )
    })
  })

  test('an already-cancelled job never reaches the extractor', async () => {
    await withStubs(async (svc, captured, filePath) => {
      const controller = new AbortController()
      controller.abort()

      const facts = await svc.ingestSingleFile(
        filePath,
        'ws-test',
        join(filePath, '..'),
        DOC_NAME,
        0,
        1,
        'job-2',
        controller.signal,
        () => {}
      )

      assert.equal(facts, 0)
      assert.equal(captured.calls, 0, 'a cancelled job must not spend a single extraction')
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

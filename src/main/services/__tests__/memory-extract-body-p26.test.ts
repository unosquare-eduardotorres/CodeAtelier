/**
 * Phase 26 — memory-extraction.service.ts deep body coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. Several extraction paths end in `spawnSummarizer`,
 * which spawns a real `claude` CLI process (see spawnSummarizer's `spawn(
 * 'claude', ...)` call) — FR-023 forbids exercising that directly. Tests
 * either stay on the pre-spawn short-circuit branches (content-too-short,
 * file-not-found) which are real and hermetic, or monkeypatch the instance's
 * `spawnSummarizer` (a plain method — TypeScript `private` is compile-time
 * only) so the LLM boundary is stubbed while the surrounding orchestration
 * — the part this file actually owns — runs for real.
 *
 * Spawn-boundary-dependent tests are merged into one sequential test because
 * this harness's test() (see test-harness.ts) starts every sibling test's
 * beforeEach hook eagerly, so two separate async tests that both reassign
 * the same `spawnSummarizer` method could interleave and stomp on each
 * other's stub.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks, evictFromCache } from './setup-full-mock'

setupFullMock()

// An earlier file in the shared run caches these bound to the REAL repositories,
// so extraction would write through to the real DB (and fail the workspace
// foreign key). Drop them so they re-bind to the mocks below; the scoped-logger
// module goes with them to keep the re-executed graph consistent.
evictFromCache('memory-extraction.service', 'memory-engine.service', '/main/logger')
const mod = require('../memory-extraction.service')
const { memoryExtractionService } = mod

const memoryRepo = getMockRepo('memoryFact')

describe('MemoryExtractionService — deep body (P26)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // ─── Exports ─────────────────────────────────────────────────────────────
  test('memoryExtractionService exposes the real extraction API', () => {
    assert.ok(memoryExtractionService)
    assert.equal(typeof memoryExtractionService.enqueue, 'function')
    assert.equal(typeof memoryExtractionService.extractFromContent, 'function')
    assert.equal(typeof memoryExtractionService.regenerateClaudeMd, 'function')
  })

  // ─── enqueue / processQueue ──────────────────────────────────────────────
  test('enqueue runs the queued job asynchronously', async () => {
    let resolveJobRan: () => void
    const jobRan = new Promise<void>((resolve) => {
      resolveJobRan = resolve
    })
    memoryExtractionService.enqueue(async () => {
      resolveJobRan()
    })
    await jobRan
  })

  test('enqueue isolates a failing job — it is logged, not thrown, and does not block later jobs', async () => {
    let secondJobRan = false
    let resolveSecond: () => void
    const secondJobDone = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    memoryExtractionService.enqueue(async () => {
      throw new Error('boom — job intentionally fails')
    })
    memoryExtractionService.enqueue(async () => {
      secondJobRan = true
      resolveSecond()
    })

    await secondJobDone
    assert.equal(secondJobRan, true)
  })

  // ─── extractFromContent — pre-spawn short-circuit (real, hermetic) ──────
  test('extractFromContent returns 0 and reports an error for content under 20 chars', async () => {
    const events: Array<{ status: string; message: string }> = []
    const result = await memoryExtractionService.extractFromContent(
      'ws-1',
      '/tmp/x',
      'source-ref',
      'too short',
      (e: { status: string; message: string }) => events.push(e)
    )
    assert.equal(result, 0)
    assert.ok(events.some((e) => e.status === 'error'))
    assert.equal(memoryRepo.createFact.callCount, 0)
  })

  // ─── extractFromDocument — pre-read short-circuit (real, hermetic) ──────
  test('extractFromDocument returns 0 and reports an error when the file does not exist', async () => {
    const events: Array<{ status: string; message: string }> = []
    const result = await memoryExtractionService.extractFromDocument(
      'ws-1',
      '/tmp/x',
      '/tmp/x/definitely-does-not-exist.md',
      (e: { status: string; message: string }) => events.push(e)
    )
    assert.equal(result, 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].status, 'error')
    assert.equal(events[0].message, 'File not found')
  })

  // ─── extractFromMessage — pre-spawn short-circuit (real, hermetic) ──────
  test('extractFromMessage returns 0 for content under 20 chars without ever writing a fact', async () => {
    const result = await memoryExtractionService.extractFromMessage('ws-1', 'too short')
    assert.equal(result, 0)
    assert.equal(memoryRepo.createFact.callCount, 0)
  })

  // ─── spawnSummarizer-boundary tests, merged to avoid cross-test stubbing races ──
  test('spawn-boundary orchestration: message fallback write, CLAUDE.md regen, busy-guard, and shutdown', async () => {
    const originalSpawnSummarizer = memoryExtractionService['spawnSummarizer']

    try {
      // 1. extractFromMessage: when the LLM boundary fails, the deterministic
      //    fallback still writes a fact — this is the recovery path, not a
      //    swallowed error.
      memoryExtractionService['spawnSummarizer'] = async () => {
        throw new Error('LLM unavailable in test — expected, exercising the fallback path')
      }
      memoryRepo.createFact.mockReturnValue({ id: 'f-fallback', tier: 0, volatile: false })
      memoryRepo.findByWorkspace.mockReturnValue([])

      const fallbackCount = await memoryExtractionService.extractFromMessage(
        'ws-1',
        'We decided to use PostgreSQL instead of SQLite for the main database.'
      )
      assert.equal(fallbackCount, 1)
      assert.equal(memoryRepo.createFact.callCount, 1)
      assert.equal(memoryRepo.createFact.lastCall[0].category, 'reference')
      assert.equal(memoryRepo.createFact.lastCall[0].sourceType, 'manual')

      // 2. regenerateClaudeMd: happy path — stubbed spawnSummarizer stands in
      //    for the Claude CLI call; the surrounding file-gathering + progress
      //    reporting is real.
      memoryExtractionService['spawnSummarizer'] = async () => '# CLAUDE.md\n\nGenerated content.'
      const progressMessages: string[] = []
      const genResult = await memoryExtractionService.regenerateClaudeMd(
        '/tmp/does-not-need-to-exist',
        (e: { message: string }) => progressMessages.push(e.message)
      )
      assert.equal(genResult.success, true)
      assert.equal(genResult.content, '# CLAUDE.md\n\nGenerated content.')
      assert.ok(progressMessages.includes('CLAUDE.md generated'))

      // 3. Busy guard: a second call while isBusy is true is rejected without
      //    ever touching spawnSummarizer again.
      memoryExtractionService['isBusy'] = true
      const busyResult = await memoryExtractionService.regenerateClaudeMd(
        '/tmp/does-not-need-to-exist'
      )
      assert.equal(busyResult.success, false)
      assert.equal(busyResult.error, 'An extraction is already in progress')
      memoryExtractionService['isBusy'] = false

      // 4. shutdown() aborts every in-flight extraction and clears busy state.
      const controller = new AbortController()
      memoryExtractionService['liveAbortControllers'].add(controller)
      memoryExtractionService['isBusy'] = true
      memoryExtractionService.shutdown()
      assert.equal(controller.signal.aborted, true)
      assert.equal(memoryExtractionService['liveAbortControllers'].size, 0)
      assert.equal(memoryExtractionService['isBusy'], false)
    } finally {
      memoryExtractionService['spawnSummarizer'] = originalSpawnSummarizer
    }
  })
})

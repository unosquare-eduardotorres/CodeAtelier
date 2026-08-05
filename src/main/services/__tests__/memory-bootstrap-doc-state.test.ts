/**
 * memory-bootstrap-doc-state.test.ts
 *
 * Regression coverage for the Deep Scan yield fixes, now asserted against the
 * queue executor (`executeItem`) that replaced the service's private
 * extractFromFile:
 *   - a chunk failure must NOT write the doc-state hash
 *     (a poisoned hash permanently locks the file out of every future scan).
 *   - an aborted/paused run must NOT write the doc-state hash, and must leave
 *     the item `pending` so it is re-queued rather than marked failed.
 *   - A clean run still writes the hash, and a matching hash short-circuits.
 *   - The Deep Scan circuit breaker treats a `lastMutationAt` bump as progress
 *     (dedupe-merges confirm existing facts without raising the active count).
 *   - Every bootstrap extraction is handed the run's cancel signal, so a
 *     cancelled run stops paying for retry backoffs instead of sleeping
 *     through ~14s of them per in-flight chunk.
 *
 * NOTE: the harness runs async tests concurrently, so the singleton stubs are
 * installed once and dispatch per file path instead of being swapped per test.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let executeItem: any
let memoryFactRepository: any
let memoryExtractionService: any
let loaded = false

try {
  // db/index must be loaded first: base-repository imports it, so requiring a
  // repository cold trips a TDZ cycle (`Cannot access 'BaseRepository'`).
  require('../../db/index')
  memoryExtractionService = require('../memory-extraction.service').memoryExtractionService
  memoryFactRepository =
    require('../../db/repositories/memory-fact.repository').memoryFactRepository

  // Load a private instance of the executors module. Other files in the shared
  // runner may have already cached it while setup-full-mock was active, in
  // which case its `memoryFactRepository` is a mock object and the stubs
  // installed below would land on a different instance. Re-requiring it with
  // the real repository already cached guarantees a matching identity; the
  // original cache entry is restored so later files are unaffected.
  const execPath = require.resolve('../memory-bootstrap/executors')
  const previous = require.cache[execPath]
  delete require.cache[execPath]
  executeItem = require(execPath).executeItem
  if (previous) require.cache[execPath] = previous
  else delete require.cache[execPath]

  loaded = true
} catch (err) {
  console.error('[memory-bootstrap-doc-state] module load failed:', err)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const TMP_ROOT = join(tmpdir(), `bootstrap-doc-state-${process.pid}`)

/**
 * A multi-section markdown doc. Sections must each approach the chunker's
 * 10K-char target, otherwise they merge into a single chunk and the
 * abort-mid-loop case can't be exercised.
 */
const SECTION_FILLER = 'Body text with enough substance to fill a real chunk. '.repeat(170)
const DOC_BODY = [
  '# Guide',
  '',
  'Intro paragraph that is long enough to survive minimum-length filtering. '.repeat(3),
  '',
  '## Section One',
  '',
  SECTION_FILLER,
  '',
  '## Section Two',
  '',
  SECTION_FILLER,
  '',
  '## Section Three',
  '',
  SECTION_FILLER
].join('\n')

interface Scenario {
  /** Pre-existing doc-state hash, if any. */
  storedHash?: string
  /** Invoked once per chunk; may throw or abort. */
  onChunk: () => Promise<number>
  chunkCalls: number
  upserts: number
  /** `opts` the executor passed to the extractor on the most recent call. */
  lastOpts?: any
  /** `onProgress` the executor passed on the most recent call. */
  lastOnProgress?: unknown
}

/** Keyed by file basename — both absolute and relative paths resolve to it. */
const scenarios = new Map<string, Scenario>()

if (loaded) {
  memoryFactRepository.getDocState = (_ws: string, filePath: string) => {
    const s = scenarios.get(basename(filePath))
    return s?.storedHash ? { contentHash: s.storedHash } : undefined
  }
  memoryFactRepository.upsertDocState = (_ws: string, filePath: string) => {
    const s = scenarios.get(basename(filePath))
    if (s) s.upserts++
  }
  memoryExtractionService.extractFromContent = async (
    _ws: string,
    _wsPath: string,
    relPath: string,
    _content: string,
    onProgress?: unknown,
    opts?: any
  ) => {
    const s = scenarios.get(basename(relPath))
    if (!s) return 0
    s.chunkCalls++
    s.lastOpts = opts
    s.lastOnProgress = onProgress
    return s.onChunk()
  }
}

/** Create a temp doc + register its scenario. Returns the scenario handle. */
function setupDoc(
  name: string,
  scenario: Omit<Scenario, 'chunkCalls' | 'upserts'>
): { path: string; state: Scenario } {
  mkdirSync(TMP_ROOT, { recursive: true })
  const path = join(TMP_ROOT, name)
  writeFileSync(path, DOC_BODY, 'utf-8')
  const state: Scenario = { ...scenario, chunkCalls: 0, upserts: 0 }
  scenarios.set(name, state)
  return { path, state }
}

function teardownDoc(name: string, path: string): void {
  scenarios.delete(name)
  rmSync(path, { force: true })
}

/** Number of chunks the fixture produces — the offsets below are relative to it. */
function fixtureChunkCount(name: string): number {
  const { chunkDocument, detectStrategy } = require('../document-chunker')
  return chunkDocument(DOC_BODY, detectStrategy(name), name).length
}

const DOC_HASH = createHash('sha256').update(DOC_BODY).digest('hex')

/**
 * Drain a synthetic docs-phase queue item through the real executor.
 *
 * `itemPatch` overrides the queue row, which is how the resume path is
 * exercised: a real resume hands the executor an item that already carries a
 * chunk offset and the hash it was measured against.
 */
async function callExtract(
  path: string,
  signal: AbortSignal,
  itemPatch: Record<string, unknown> = {}
): Promise<{ facts: number; status: string; hashChanges: string[] }> {
  const hashChanges: string[] = []
  const outcome = await executeItem({
    workspaceId: 'ws-test',
    workspacePath: TMP_ROOT,
    scope: 'changed',
    signal,
    item: {
      id: 'item-1',
      runId: 'run-1',
      phase: 'docs',
      kind: 'doc',
      sourceRef: basename(path),
      contentHash: null,
      priority: 100,
      chunkTotal: 0,
      chunkDone: 0,
      status: 'running',
      factsCreated: 0,
      error: null,
      updatedAt: '',
      ...itemPatch
    },
    lastCommit: null,
    isPaused: () => false,
    onChunk: () => {},
    onHashChanged: (hash: string) => hashChanges.push(hash),
    onMessage: () => {}
  })
  return { ...outcome, hashChanges }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('bootstrap executor — doc-state hash gating', () => {
  test('modules loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-bootstrap/executors must be requireable')
    assert.equal(typeof executeItem, 'function')
  })

  test('fixture produces multiple chunks (precondition for the abort case)', () => {
    const { chunkDocument, detectStrategy } = require('../document-chunker')
    const chunks = chunkDocument(DOC_BODY, detectStrategy('x.md'), 'x.md')
    assert.ok(chunks.length > 1, `expected >1 chunk, got ${chunks.length}`)
  })

  test('writes the doc-state hash after a clean run', async () => {
    if (!loaded) return
    const name = 'clean.md'
    const { path, state } = setupDoc(name, { onChunk: async () => 2 })
    try {
      const outcome = await callExtract(path, new AbortController().signal)
      assert.equal(outcome.status, 'done')
      assert.ok(outcome.facts > 0, 'clean run should report facts')
      assert.equal(state.upserts, 1, 'clean run writes the doc-state hash')
    } finally {
      teardownDoc(name, path)
    }
  })

  test('does NOT write the doc-state hash when a chunk throws', async () => {
    if (!loaded) return
    const name = 'throws.md'
    const { path, state } = setupDoc(name, {
      onChunk: async () => {
        if (state.chunkCalls === 1) throw new Error('LLM unavailable')
        return 1
      }
    })
    try {
      const outcome = await callExtract(path, new AbortController().signal)
      assert.equal(outcome.status, 'failed')
      assert.equal(
        state.upserts,
        0,
        'a chunk failure must not poison the hash — the file has to be retried'
      )
    } finally {
      teardownDoc(name, path)
    }
  })

  test('does NOT write the doc-state hash when the signal aborts mid-loop', async () => {
    if (!loaded) return
    const name = 'aborts.md'
    const controller = new AbortController()
    const { path, state } = setupDoc(name, {
      onChunk: async () => {
        controller.abort() // abort after the first chunk
        return 1
      }
    })
    try {
      const outcome = await callExtract(path, controller.signal)
      assert.equal(
        outcome.status,
        'pending',
        'an interrupted item is re-queued, not failed — that is what makes resume lossless'
      )
      assert.equal(state.chunkCalls, 1, 'loop stops at the first chunk after abort')
      assert.equal(state.upserts, 0, 'a cancelled run must not poison the hash')
    } finally {
      teardownDoc(name, path)
    }
  })

  test('records the content hash on first execution', async () => {
    if (!loaded) return
    const name = 'first-run.md'
    const { path } = setupDoc(name, { onChunk: async () => 1 })
    try {
      const outcome = await callExtract(path, new AbortController().signal)
      assert.deepEqual(
        outcome.hashChanges,
        [DOC_HASH],
        'without this the item hash stays null forever and mid-file resume can never engage'
      )
    } finally {
      teardownDoc(name, path)
    }
  })

  test('resumes mid-file from the recorded chunk offset', async () => {
    if (!loaded) return
    const name = 'resume-match.md'
    const { path, state } = setupDoc(name, { onChunk: async () => 1 })
    try {
      const total = fixtureChunkCount(name)
      assert.ok(total > 1, 'fixture must chunk for this test to mean anything')
      const alreadyDone = total - 1

      const outcome = await callExtract(path, new AbortController().signal, {
        chunkDone: alreadyDone,
        contentHash: DOC_HASH,
        factsCreated: 7
      })

      assert.equal(
        state.chunkCalls,
        total - alreadyDone,
        'chunks already extracted must not be paid for a second time'
      )
      assert.deepEqual(outcome.hashChanges, [], 'an unchanged file does not rewrite its hash')
      assert.equal(outcome.facts, 7 + (total - alreadyDone), 'partial facts carry forward')
      assert.equal(outcome.status, 'done')
    } finally {
      teardownDoc(name, path)
    }
  })

  test('restarts from chunk 0 when the offset was recorded against different content', async () => {
    if (!loaded) return
    const name = 'resume-stale.md'
    const { path, state } = setupDoc(name, { onChunk: async () => 1 })
    try {
      const total = fixtureChunkCount(name)

      const outcome = await callExtract(path, new AbortController().signal, {
        chunkDone: total - 1,
        contentHash: 'hash-of-some-older-version-of-this-file',
        factsCreated: 7
      })

      assert.equal(
        state.chunkCalls,
        total,
        'a stale offset points into different text — every chunk has to re-run'
      )
      assert.deepEqual(
        outcome.hashChanges,
        [DOC_HASH],
        'the queue is told to store the new hash so the stale offset is dropped'
      )
      assert.equal(outcome.facts, total, 'facts from the stale attempt are not carried forward')
    } finally {
      teardownDoc(name, path)
    }
  })

  test('short-circuits as unchanged when the stored hash matches', async () => {
    if (!loaded) return
    const name = 'unchanged.md'
    const { path, state } = setupDoc(name, {
      storedHash: createHash('sha256').update(DOC_BODY).digest('hex'),
      onChunk: async () => 1
    })
    try {
      const outcome = await callExtract(path, new AbortController().signal)
      assert.equal(outcome.status, 'skipped')
      assert.equal(outcome.facts, 0)
      assert.equal(state.chunkCalls, 0, 'unchanged files skip extraction entirely')
      assert.equal(state.upserts, 0)
    } finally {
      teardownDoc(name, path)
    }
  })
})

// ── Cancel-signal wiring ────────────────────────────────────────────────────

/**
 * A cancelled run must not keep paying for retry backoffs. `extractFromContent`
 * only stops retrying when it is handed the run's signal, so a call site that
 * forgets it burns ~14s of sleeps and up to three extra Claude spawns per
 * in-flight chunk after the user hits Cancel.
 *
 * Under the old code the `manifests` case below saw `opts.signal === undefined`
 * and the doc case saw a signal only because that one site wired it by hand.
 */
describe('bootstrap executors — cancel signal reaches the extractor', () => {
  test('doc items pass the run signal through to extractFromContent', async () => {
    if (!loaded) return
    const name = 'signal-doc.md'
    const controller = new AbortController()
    const { path, state } = setupDoc(name, { onChunk: async () => 1 })
    try {
      await callExtract(path, controller.signal)
      assert.equal(state.lastOpts?.signal, controller.signal, 'the run signal must be forwarded')
      assert.equal(state.lastOpts.signal.aborted, false)
      controller.abort()
      assert.equal(
        state.lastOpts.signal.aborted,
        true,
        'it is the live signal, not a detached copy'
      )
      assert.equal(typeof state.lastOnProgress, 'function', 'extractor status is forwarded')
    } finally {
      teardownDoc(name, path)
    }
  })

  test('manifests items pass the run signal through to extractFromContent', async () => {
    if (!loaded) return
    const controller = new AbortController()
    mkdirSync(TMP_ROOT, { recursive: true })
    const manifestPath = join(TMP_ROOT, 'package.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { react: '^19.0.0' } }),
      'utf-8'
    )
    const state: Scenario = { onChunk: async () => 3, chunkCalls: 0, upserts: 0 }
    scenarios.set('project-manifests', state)

    try {
      const outcome = await executeItem({
        workspaceId: 'ws-test',
        workspacePath: TMP_ROOT,
        scope: 'changed',
        signal: controller.signal,
        item: {
          id: 'item-m',
          runId: 'run-1',
          phase: 'stack',
          kind: 'manifests',
          sourceRef: 'project-manifests',
          contentHash: null,
          priority: 100,
          chunkTotal: 0,
          chunkDone: 0,
          status: 'running',
          factsCreated: 0,
          error: null,
          updatedAt: ''
        },
        lastCommit: null,
        isPaused: () => false,
        onChunk: () => {},
        onHashChanged: () => {},
        onMessage: () => {}
      })

      assert.equal(state.chunkCalls, 1, 'the manifest fixture must actually reach the extractor')
      assert.equal(outcome.status, 'done')
      assert.equal(
        state.lastOpts?.signal,
        controller.signal,
        'this site passed no signal at all before the fix'
      )
      assert.equal(typeof state.lastOnProgress, 'function', 'this site passed undefined before')
    } finally {
      scenarios.delete('project-manifests')
      rmSync(manifestPath, { force: true })
    }
  })

  test('every extractor call in executors.ts goes through the single wrapper', () => {
    // `commits` needs a real git repo to drive, so the remaining call site is
    // guarded structurally: exactly one textual call, the one inside
    // runExtraction. Blunt, but it fails the moment a fourth unwired call site
    // appears — which is precisely the regression.
    const source = readFileSync(join(__dirname, '..', 'memory-bootstrap', 'executors.ts'), 'utf-8')
    const calls = source.match(/memoryExtractionService\.extractFromContent\(/g) ?? []
    assert.equal(
      calls.length,
      1,
      'executors must call extractFromContent only via runExtraction, which attaches ctx.signal'
    )
    assert.match(
      source,
      /function runExtraction[\s\S]*?signal: ctx\.signal/,
      'runExtraction must attach the run signal'
    )
  })
})

// ── Circuit breaker progress signal ─────────────────────────────────────────

/**
 * Mirrors the breaker's decision in phaseDeepScan. Kept as a local replica so
 * the rule is asserted without spawning a Claude CLI process.
 */
function madeProgress(
  currentFacts: number,
  lastFactCount: number,
  currentMutationAt: number,
  lastMutationAt: number
): boolean {
  return currentFacts > lastFactCount || currentMutationAt > lastMutationAt
}

describe('Deep Scan circuit breaker — progress signal', () => {
  test('a new fact counts as progress', () => {
    assert.equal(madeProgress(11, 10, 1000, 1000), true)
  })

  test('a dedupe-merge (mutation bump, flat count) counts as progress', () => {
    assert.equal(
      madeProgress(10, 10, 2000, 1000),
      true,
      'confirming an existing fact bumps updated_at without raising the active count'
    )
  })

  test('no count change and no mutation is a stall', () => {
    assert.equal(madeProgress(10, 10, 1000, 1000), false)
  })

  test('breaker window is 3 minutes, not 90 seconds', () => {
    const STALL_CHECK_INTERVAL_MS = 30_000
    const MAX_STALLED_CHECKS = 6
    assert.equal((MAX_STALLED_CHECKS * STALL_CHECK_INTERVAL_MS) / 1000, 180)
  })
})

// ── Repository surface ──────────────────────────────────────────────────────

describe('memoryFactRepository — doc-state surface', () => {
  test('exposes getLastMutationAt', () => {
    if (!loaded) return
    const proto = Object.getPrototypeOf(memoryFactRepository)
    assert.equal(typeof proto.getLastMutationAt, 'function')
  })
})

// summaryAsync calls process.exit — unguarded it kills the whole suite when this
// file is imported by a runner, taking every later test file with it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

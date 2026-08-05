/**
 * memory-bootstrap-doc-state.test.ts
 *
 * Regression coverage for the Deep Scan yield fixes:
 *   - extractFromFile must NOT write the doc-state hash when a chunk throws
 *     (a poisoned hash permanently locks the file out of every future scan).
 *   - extractFromFile must NOT write the doc-state hash when the run aborts.
 *   - A clean run still writes the hash, and a matching hash short-circuits.
 *   - The Deep Scan circuit breaker treats a `lastMutationAt` bump as progress
 *     (dedupe-merges confirm existing facts without raising the active count).
 *
 * NOTE: the harness runs async tests concurrently, so the singleton stubs are
 * installed once and dispatch per file path instead of being swapped per test.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let memoryBootstrapService: any
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

  // Load a private instance of the service. Other files in the shared runner
  // may have already cached memory-bootstrap.service while setup-full-mock was
  // active, in which case its `memoryFactRepository` is a mock object and the
  // stubs installed below would land on a different instance. Re-requiring it
  // with the real repository already cached guarantees a matching identity;
  // the original cache entry is restored so later files are unaffected.
  const svcPath = require.resolve('../memory-bootstrap.service')
  const previous = require.cache[svcPath]
  delete require.cache[svcPath]
  memoryBootstrapService = require(svcPath).memoryBootstrapService
  if (previous) require.cache[svcPath] = previous
  else delete require.cache[svcPath]

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
    relPath: string
  ) => {
    const s = scenarios.get(basename(relPath))
    if (!s) return 0
    s.chunkCalls++
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

/** Invoke the private extractFromFile with a docs-phase config. */
function callExtract(
  path: string,
  signal: AbortSignal
): Promise<{ facts: number; status: string }> {
  return (memoryBootstrapService as any).extractFromFile(
    'ws-test',
    TMP_ROOT,
    path,
    signal,
    { sourceType: 'bootstrap', tags: ['bootstrap', 'docs'] }
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('extractFromFile — doc-state hash gating', () => {
  test('modules loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-bootstrap.service must be requireable')
    assert.equal(typeof memoryBootstrapService?.startBootstrap, 'function')
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
      assert.equal(outcome.status, 'extracted')
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
      assert.equal(outcome.status, 'failed')
      assert.equal(state.chunkCalls, 1, 'loop stops at the first chunk after abort')
      assert.equal(state.upserts, 0, 'a cancelled run must not poison the hash')
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
      assert.equal(outcome.status, 'unchanged')
      assert.equal(outcome.facts, 0)
      assert.equal(state.chunkCalls, 0, 'unchanged files skip extraction entirely')
      assert.equal(state.upserts, 0)
    } finally {
      teardownDoc(name, path)
    }
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

describe('memoryFactRepository — doc-state escape hatch', () => {
  test('exposes clearDocStates and getLastMutationAt', () => {
    if (!loaded) return
    const proto = Object.getPrototypeOf(memoryFactRepository)
    assert.equal(typeof proto.clearDocStates, 'function')
    assert.equal(typeof proto.getLastMutationAt, 'function')
  })
})

void summaryAsync()

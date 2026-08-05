/**
 * memory-scope-activation.test.ts
 *
 * Retrieval used to see only the user's message, and `computeScopeBoost`
 * required that message to literally contain a scope path — so opening
 * `src/billing/Invoice.java` and saying "fix this bug" injected no billing
 * facts at all. These tests pin the path-activation behaviour that replaced it,
 * plus the path-token extraction and active-path sourcing that feed it.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact } from '../../../shared/types'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let memoryRetrievalService: any
let extractPathTokens: any
let memoryFactRepository: any
let activePaths: any
let loaded = false

try {
  // db/index must be loaded first: base-repository imports it, so requiring a
  // repository cold trips a TDZ cycle.
  require('../../db/index')
  const retrieval = require('../memory-retrieval.service')
  memoryRetrievalService = retrieval.memoryRetrievalService
  extractPathTokens = retrieval.extractPathTokens
  memoryFactRepository =
    require('../../db/repositories/memory-fact.repository').memoryFactRepository
  activePaths = require('../active-paths')
  loaded = true
} catch (err) {
  console.error('[memory-scope-activation] module load failed:', err)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeFact(id: string, scopePaths: string[]): MemoryFact {
  return {
    id,
    workspaceId: 'ws-scope',
    category: 'convention',
    title: `Fact ${id}`,
    content: `Content for ${id}`,
    tags: [],
    scopePaths,
    tier: 0,
    confidence: 0.9,
    confirmationCount: 0,
    lastConfirmedAt: null,
    status: 'active',
    supersededBy: null,
    mergedInto: null,
    volatile: false,
    sourceType: 'bootstrap',
    sourceRef: null,
    embeddingPending: false,
    lastAccessedAt: null,
    createdAt: '2020-01-01 00:00:00',
    updatedAt: '2020-01-01 00:00:00'
  }
}

/** Facts the stubbed keyword search returns, keyed by workspace id. */
const stubFacts = new Map<string, MemoryFact[]>()

if (loaded) {
  const originalSearch = memoryFactRepository.search.bind(memoryFactRepository)
  memoryFactRepository.search = (ws: string, query: string, limit: number): MemoryFact[] => {
    const stubbed = stubFacts.get(ws)
    return stubbed ?? originalSearch(ws, query, limit)
  }

  const originalFind = memoryFactRepository.findWithEmbeddings.bind(memoryFactRepository)
  memoryFactRepository.findWithEmbeddings = (ws: string): unknown[] =>
    stubFacts.has(ws) ? [] : originalFind(ws)

  const originalTouch = memoryFactRepository.touchFacts.bind(memoryFactRepository)
  memoryFactRepository.touchFacts = (ids: string[]): void => {
    const real = ids.filter((id) => !id.startsWith('scope-'))
    if (real.length > 0) originalTouch(real)
  }
}

// ── Path token extraction ───────────────────────────────────────────────────

describe('extractPathTokens', () => {
  test('module loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-retrieval.service must be requireable')
    assert.equal(typeof extractPathTokens, 'function')
  })

  test('finds paths with separators', () => {
    if (!loaded) return
    const tokens = extractPathTokens('why does src/db/index.ts open the DB twice?')
    assert.ok(tokens.includes('src/db/index.ts'))
  })

  test('finds bare filenames with source extensions', () => {
    if (!loaded) return
    const tokens = extractPathTokens('Invoice.java is throwing on save')
    assert.ok(tokens.includes('Invoice.java'))
  })

  test('ignores ordinary prose and decimals', () => {
    if (!loaded) return
    assert.deepEqual(extractPathTokens('fix this bug please'), [])
    assert.deepEqual(extractPathTokens('the timeout is 1.5 seconds'), [])
  })

  test('strips trailing punctuation', () => {
    if (!loaded) return
    const tokens = extractPathTokens('look at src/api/users.ts, then stop.')
    assert.ok(tokens.includes('src/api/users.ts'))
  })
})

// ── Scope activation ────────────────────────────────────────────────────────

describe('retrieve — path-scoped activation', () => {
  test('a scoped fact is retrieved when an active path falls under its scope', async () => {
    if (!loaded) return
    const ws = 'ws-scope-active'
    stubFacts.set(ws, [
      makeFact('scope-billing', ['src/billing']),
      makeFact('scope-ui', ['src/ui'])
    ])
    try {
      const results = await memoryRetrievalService.retrieve(ws, 'fix this bug', 10, undefined, [
        'src/billing/Invoice.java'
      ])
      const ids = results.map((r: { fact: MemoryFact }) => r.fact.id)

      assert.ok(ids.includes('scope-billing'), 'billing fact activates on the open file')
      assert.ok(!ids.includes('scope-ui'), 'unrelated scope stays out')
    } finally {
      stubFacts.delete(ws)
    }
  })

  test('the same query without active paths retrieves nothing', async () => {
    if (!loaded) return
    const ws = 'ws-scope-inactive'
    stubFacts.set(ws, [makeFact('scope-billing2', ['src/billing'])])
    try {
      const results = await memoryRetrievalService.retrieve(ws, 'fix this bug', 10)
      assert.equal(results.length, 0, 'without a path signal the message alone is not enough')
    } finally {
      stubFacts.delete(ws)
    }
  })

  test('a path named in the message activates without an explicit active path', async () => {
    if (!loaded) return
    const ws = 'ws-scope-message'
    stubFacts.set(ws, [makeFact('scope-billing3', ['src/billing'])])
    try {
      const results = await memoryRetrievalService.retrieve(
        ws,
        'fix the rounding in src/billing/Invoice.java'
      )
      const ids = results.map((r: { fact: MemoryFact }) => r.fact.id)
      assert.ok(ids.includes('scope-billing3'))
    } finally {
      stubFacts.delete(ws)
    }
  })

  test('an activated fact outranks a non-activated one', async () => {
    if (!loaded) return
    const ws = 'ws-scope-rank'
    stubFacts.set(ws, [
      makeFact('scope-other', ['src/ui']),
      makeFact('scope-target', ['src/billing'])
    ])
    try {
      const results = await memoryRetrievalService.retrieve(ws, 'Fact scope', 10, undefined, [
        'src/billing/Invoice.java'
      ])
      assert.ok(results.length > 0)
      assert.equal(results[0].fact.id, 'scope-target', 'activation lifts the scoped fact to the top')
    } finally {
      stubFacts.delete(ws)
    }
  })

  test('glob scopes activate as well as directory scopes', async () => {
    if (!loaded) return
    const ws = 'ws-scope-glob'
    stubFacts.set(ws, [makeFact('scope-glob', ['src/**/*.java'])])
    try {
      const results = await memoryRetrievalService.retrieve(ws, 'fix this bug', 10, undefined, [
        'src/billing/Invoice.java'
      ])
      assert.equal(results.length, 1)
      assert.equal(results[0].fact.id, 'scope-glob')
    } finally {
      stubFacts.delete(ws)
    }
  })
})

// ── Active path sourcing ────────────────────────────────────────────────────

describe('active-paths', () => {
  test('parses porcelain status lines', () => {
    if (!loaded) return
    const parsed = activePaths.parsePorcelain(
      ' M src/a.ts\n?? src/new.ts\nA  src/added.ts\n'
    )
    assert.deepEqual(parsed, ['src/a.ts', 'src/new.ts', 'src/added.ts'])
  })

  test('takes the destination path of a rename', () => {
    if (!loaded) return
    const parsed = activePaths.parsePorcelain('R  src/old.ts -> src/new.ts\n')
    assert.deepEqual(parsed, ['src/new.ts'])
  })

  test('unquotes and unescapes quoted paths', () => {
    if (!loaded) return
    const parsed = activePaths.parsePorcelain(' M "src/a b.ts"\n')
    assert.deepEqual(parsed, ['src/a b.ts'])
  })

  test('deduplicates repeated paths', () => {
    if (!loaded) return
    const parsed = activePaths.parsePorcelain('MM src/a.ts\n M src/a.ts\n')
    assert.deepEqual(parsed, ['src/a.ts'])
  })

  test('makes absolute paths workspace-relative', () => {
    if (!loaded) return
    assert.equal(
      activePaths.toWorkspaceRelative('/repo', '/repo/src/a.ts'),
      'src/a.ts'
    )
  })

  test('rejects absolute paths outside the workspace', () => {
    if (!loaded) return
    assert.equal(activePaths.toWorkspaceRelative('/repo', '/etc/passwd'), null)
  })

  test('leaves relative paths alone', () => {
    if (!loaded) return
    assert.equal(activePaths.toWorkspaceRelative('/repo', './src/a.ts'), 'src/a.ts')
  })

  test('returns nothing when the workspace is unknown', () => {
    if (!loaded) return
    assert.deepEqual(activePaths.resolveActivePaths(null, ['src/a.ts']), [])
  })

  test('explored files come before working-tree noise', () => {
    if (!loaded) return
    activePaths.clearActivePathsCache()
    // A non-existent directory makes `git status` fail, isolating the
    // tool-activity half of the merge.
    const resolved = activePaths.resolveActivePaths('/nonexistent-workspace-xyz', [
      'src/explored.ts'
    ])
    assert.deepEqual(resolved, ['src/explored.ts'])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

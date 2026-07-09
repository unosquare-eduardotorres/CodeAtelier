/**
 * DB integration tests for code graph repositories.
 * Uses in-memory SQLite via test-helpers — no Electron runtime needed.
 *
 * NOTE: These tests require better-sqlite3 to be compiled for the current Node.js version.
 * In Electron projects, the native module is typically compiled for Electron's Node.
 * If the native module can't load, all tests are skipped gracefully.
 */
import assert from 'node:assert/strict'

// Set NODE_ENV so _setDatabaseForTesting allows the override
process.env.NODE_ENV = 'test'

let passed = 0
let failed = 0
let skipped = 0

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

function skip(name: string): void {
  console.log(`  ⊘ ${name} (skipped)`)
  skipped++
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── Try to load native deps — skip all if unavailable ──

let dbAvailable = false
let createTestDb: typeof import('../../db/test-helpers').createTestDb
let seedWorkspace: typeof import('../../db/test-helpers').seedWorkspace
let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
let CodeGraphTagRepository: typeof import('../../db/repositories/code-graph-tag.repository').CodeGraphTagRepository
let CodeGraphEdgeRepository: typeof import('../../db/repositories/code-graph-edge.repository').CodeGraphEdgeRepository
let CodeGraphRankRepository: typeof import('../../db/repositories/code-graph-rank.repository').CodeGraphRankRepository

try {
  const helpers = require('../../db/test-helpers')
  createTestDb = helpers.createTestDb
  seedWorkspace = helpers.seedWorkspace
  _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
  CodeGraphTagRepository =
    require('../../db/repositories/code-graph-tag.repository').CodeGraphTagRepository
  CodeGraphEdgeRepository =
    require('../../db/repositories/code-graph-edge.repository').CodeGraphEdgeRepository
  CodeGraphRankRepository =
    require('../../db/repositories/code-graph-rank.repository').CodeGraphRankRepository

  // Verify we can actually create a DB
  const testDb = createTestDb()
  testDb.close()
  dbAvailable = true
} catch (err) {
  console.log(
    `\n⚠ better-sqlite3 native module not compatible with current Node.js — DB tests will be skipped.`
  )
  console.log(`  (${(err as Error).message.split('\n')[0]})`)
}

function setupTestDb(): { wsId: string } {
  const db = createTestDb()
  _setDatabaseForTesting(db)
  const wsId = seedWorkspace(db)
  return { wsId }
}

type RepomapTag = import('../../db/repositories/code-graph-tag.repository').RepomapTag
type CodeGraphEdge = import('../../db/repositories/code-graph-edge.repository').CodeGraphEdge

// ── CodeGraphTagRepository ──

describe('CodeGraphTagRepository.upsertTags + findAllByWorkspace', () => {
  if (!dbAvailable) {
    skip('upsertTags persists and findAllByWorkspace retrieves')
    skip('findDefsByWorkspace returns only definitions')
    skip('countByWorkspace returns correct count')
    return
  }

  const tagRepo = new CodeGraphTagRepository()

  test('upsertTags persists and findAllByWorkspace retrieves', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = [
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'Foo', kind: 'def' },
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 5, name: 'Foo', kind: 'ref' },
      { relFname: 'src/b.ts', fname: '/abs/src/b.ts', line: 10, name: 'Bar', kind: 'def' }
    ]
    const mtimes = new Map([
      ['src/a.ts', 1000],
      ['src/b.ts', 2000]
    ])

    tagRepo.upsertTags(wsId, tags, mtimes)
    const all = tagRepo.findAllByWorkspace(wsId)
    assert.equal(all.length, 3)
  })

  test('findDefsByWorkspace returns only definitions', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = [
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'Foo', kind: 'def' },
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 5, name: 'Foo', kind: 'ref' }
    ]
    tagRepo.upsertTags(wsId, tags, new Map([['src/a.ts', 1000]]))
    const defs = tagRepo.findDefsByWorkspace(wsId)
    assert.equal(defs.length, 1)
    assert.equal(defs[0].kind, 'def')
  })

  test('countByWorkspace returns correct count', () => {
    const { wsId } = setupTestDb()
    assert.equal(tagRepo.countByWorkspace(wsId), 0)
    const tags: RepomapTag[] = [
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'X', kind: 'def' }
    ]
    tagRepo.upsertTags(wsId, tags, new Map([['src/a.ts', 1000]]))
    assert.equal(tagRepo.countByWorkspace(wsId), 1)
  })
})

describe('CodeGraphTagRepository.searchByName', () => {
  if (!dbAvailable) {
    skip('finds tags by substring match (case-insensitive)')
    skip('respects includeDefinitions/includeReferences filters')
    skip('respects maxResults limit')
    skip('returns empty for non-matching query')
    return
  }

  const tagRepo = new CodeGraphTagRepository()

  test('finds tags by substring match (case-insensitive)', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = [
      {
        relFname: 'src/auth.ts',
        fname: '/abs/src/auth.ts',
        line: 1,
        name: 'validateJwt',
        kind: 'def'
      },
      {
        relFname: 'src/utils.ts',
        fname: '/abs/src/utils.ts',
        line: 1,
        name: 'formatDate',
        kind: 'def'
      }
    ]
    tagRepo.upsertTags(
      wsId,
      tags,
      new Map([
        ['src/auth.ts', 1000],
        ['src/utils.ts', 1000]
      ])
    )

    const results = tagRepo.searchByName(wsId, 'jwt')
    assert.equal(results.length, 1)
    assert.equal(results[0].name, 'validateJwt')
  })

  test('respects includeDefinitions/includeReferences filters', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = [
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'MyClass', kind: 'def' },
      { relFname: 'src/b.ts', fname: '/abs/src/b.ts', line: 5, name: 'MyClass', kind: 'ref' }
    ]
    tagRepo.upsertTags(
      wsId,
      tags,
      new Map([
        ['src/a.ts', 1000],
        ['src/b.ts', 1000]
      ])
    )

    const defsOnly = tagRepo.searchByName(wsId, 'MyClass', {
      includeDefinitions: true,
      includeReferences: false
    })
    assert.equal(defsOnly.length, 1)
    assert.equal(defsOnly[0].kind, 'def')

    const refsOnly = tagRepo.searchByName(wsId, 'MyClass', {
      includeDefinitions: false,
      includeReferences: true
    })
    assert.equal(refsOnly.length, 1)
    assert.equal(refsOnly[0].kind, 'ref')
  })

  test('respects maxResults limit', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = []
    for (let i = 0; i < 10; i++) {
      tags.push({
        relFname: `src/file${i}.ts`,
        fname: `/abs/src/file${i}.ts`,
        line: 1,
        name: `handler${i}`,
        kind: 'def'
      })
    }
    const mtimes = new Map(tags.map((t) => [t.relFname, 1000] as [string, number]))
    tagRepo.upsertTags(wsId, tags, mtimes)

    const results = tagRepo.searchByName(wsId, 'handler', { maxResults: 3 })
    assert.equal(results.length, 3)
  })

  test('returns empty for non-matching query', () => {
    const { wsId } = setupTestDb()
    const tags: RepomapTag[] = [
      { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'Foo', kind: 'def' }
    ]
    tagRepo.upsertTags(wsId, tags, new Map([['src/a.ts', 1000]]))

    const results = tagRepo.searchByName(wsId, 'zzz_nonexistent')
    assert.equal(results.length, 0)
  })
})

// ── CodeGraphRankRepository ──

describe('CodeGraphRankRepository', () => {
  if (!dbAvailable) {
    skip('upsertRanks persists and findByWorkspace retrieves')
    skip('getTopRanked returns ranked order')
    skip('getRank returns specific file rank')
    skip('getRank returns 0 for unknown file')
    skip('countByWorkspace returns correct count')
    return
  }

  const rankRepo = new CodeGraphRankRepository()

  test('upsertRanks persists and findByWorkspace retrieves', () => {
    const { wsId } = setupTestDb()
    const ranks = new Map([
      ['src/a.ts', 0.8],
      ['src/b.ts', 0.3]
    ])
    rankRepo.upsertRanks(wsId, ranks)

    const loaded = rankRepo.findByWorkspace(wsId)
    assert.equal(loaded.size, 2)
    assert.ok(Math.abs(loaded.get('src/a.ts')! - 0.8) < 1e-10)
    assert.ok(Math.abs(loaded.get('src/b.ts')! - 0.3) < 1e-10)
  })

  test('getTopRanked returns ranked order', () => {
    const { wsId } = setupTestDb()
    const ranks = new Map([
      ['src/low.ts', 0.1],
      ['src/high.ts', 0.9],
      ['src/mid.ts', 0.5]
    ])
    rankRepo.upsertRanks(wsId, ranks)

    const top = rankRepo.getTopRanked(wsId, 2)
    assert.equal(top.length, 2)
    assert.equal(top[0], 'src/high.ts')
    assert.equal(top[1], 'src/mid.ts')
  })

  test('getRank returns specific file rank', () => {
    const { wsId } = setupTestDb()
    const ranks = new Map([['src/target.ts', 0.42]])
    rankRepo.upsertRanks(wsId, ranks)

    const rank = rankRepo.getRank(wsId, 'src/target.ts')
    assert.ok(Math.abs(rank - 0.42) < 1e-10)
  })

  test('getRank returns 0 for unknown file', () => {
    const { wsId } = setupTestDb()
    const rank = rankRepo.getRank(wsId, 'src/nonexistent.ts')
    assert.equal(rank, 0)
  })

  test('countByWorkspace returns correct count', () => {
    const { wsId } = setupTestDb()
    assert.equal(rankRepo.countByWorkspace(wsId), 0)
    rankRepo.upsertRanks(wsId, new Map([['a.ts', 0.5]]))
    assert.equal(rankRepo.countByWorkspace(wsId), 1)
  })
})

// ── CodeGraphEdgeRepository ──

describe('CodeGraphEdgeRepository', () => {
  if (!dbAvailable) {
    skip('upsertEdges persists and findByWorkspace retrieves')
    skip('findCallersOf returns edges targeting a symbol')
    skip('findCalleesOf returns edges from a source symbol')
    skip('countByWorkspace returns correct count')
    skip('deleteByWorkspace removes all edges')
    return
  }

  const edgeRepo = new CodeGraphEdgeRepository()

  test('upsertEdges persists and findByWorkspace retrieves', () => {
    const { wsId } = setupTestDb()
    const edges: CodeGraphEdge[] = [
      {
        workspaceId: wsId,
        sourceFile: 'src/consumer.ts',
        sourceSymbol: 'MyClass',
        targetFile: 'src/myclass.ts',
        targetSymbol: 'MyClass',
        edgeType: 'references',
        pageRank: 0.5
      }
    ]
    edgeRepo.upsertEdges(wsId, edges)

    const loaded = edgeRepo.findByWorkspace(wsId)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].sourceFile, 'src/consumer.ts')
    assert.equal(loaded[0].targetFile, 'src/myclass.ts')
  })

  test('findCallersOf returns edges targeting a symbol', () => {
    const { wsId } = setupTestDb()
    const edges: CodeGraphEdge[] = [
      {
        workspaceId: wsId,
        sourceFile: 'src/a.ts',
        sourceSymbol: 'Foo',
        targetFile: 'src/foo.ts',
        targetSymbol: 'Foo',
        edgeType: 'references',
        pageRank: 0.3
      },
      {
        workspaceId: wsId,
        sourceFile: 'src/b.ts',
        sourceSymbol: 'Bar',
        targetFile: 'src/bar.ts',
        targetSymbol: 'Bar',
        edgeType: 'references',
        pageRank: 0.2
      }
    ]
    edgeRepo.upsertEdges(wsId, edges)

    const callers = edgeRepo.findCallersOf(wsId, 'Foo')
    assert.equal(callers.length, 1)
    assert.equal(callers[0].sourceFile, 'src/a.ts')
  })

  test('findCalleesOf returns edges from a source symbol', () => {
    const { wsId } = setupTestDb()
    const edges: CodeGraphEdge[] = [
      {
        workspaceId: wsId,
        sourceFile: 'src/main.ts',
        sourceSymbol: 'init',
        targetFile: 'src/db.ts',
        targetSymbol: 'connect',
        edgeType: 'calls',
        pageRank: 0.7
      }
    ]
    edgeRepo.upsertEdges(wsId, edges)

    const callees = edgeRepo.findCalleesOf(wsId, 'init')
    assert.equal(callees.length, 1)
    assert.equal(callees[0].targetFile, 'src/db.ts')
  })

  test('countByWorkspace returns correct count', () => {
    const { wsId } = setupTestDb()
    assert.equal(edgeRepo.countByWorkspace(wsId), 0)
    edgeRepo.upsertEdges(wsId, [
      {
        workspaceId: wsId,
        sourceFile: 'a.ts',
        sourceSymbol: 'X',
        targetFile: 'b.ts',
        targetSymbol: 'X',
        edgeType: 'references',
        pageRank: 0
      }
    ])
    assert.equal(edgeRepo.countByWorkspace(wsId), 1)
  })

  test('deleteByWorkspace removes all edges', () => {
    const { wsId } = setupTestDb()
    edgeRepo.upsertEdges(wsId, [
      {
        workspaceId: wsId,
        sourceFile: 'a.ts',
        sourceSymbol: 'X',
        targetFile: 'b.ts',
        targetSymbol: 'X',
        edgeType: 'references',
        pageRank: 0
      }
    ])
    assert.equal(edgeRepo.countByWorkspace(wsId), 1)
    edgeRepo.deleteByWorkspace(wsId)
    assert.equal(edgeRepo.countByWorkspace(wsId), 0)
  })
})

// ── CodeGraphService.getIndexingState DB fallback ──

describe('CodeGraphService.getIndexingState (DB fallback)', () => {
  if (!dbAvailable) {
    skip('returns idle when no in-memory state and no DB data')
    skip('returns complete with DB counts when persisted data exists')
    skip('returns in-memory state when available (no DB lookup)')
    return
  }

  // Import service singleton — its private indexingStates map is empty on cold start,
  // which mirrors the post-restart scenario we're testing.
  let codeGraphService: typeof import('../code-graph.service').codeGraphService

  try {
    codeGraphService = require('../code-graph.service').codeGraphService
  } catch (err) {
    console.log(`  ⚠ Could not load CodeGraphService: ${(err as Error).message.split('\n')[0]}`)
    skip('returns idle when no in-memory state and no DB data')
    skip('returns complete with DB counts when persisted data exists')
    return
  }

  test('returns idle when no in-memory state and no DB data', () => {
    const { wsId } = setupTestDb()
    const state = codeGraphService.getIndexingState(wsId)
    assert.equal(state.status, 'idle')
    assert.equal(state.totalTags, 0)
    assert.equal(state.totalEdges, 0)
    assert.equal(state.totalFiles, 0)
  })

  test('returns complete with DB counts when persisted data exists', () => {
    const { wsId } = setupTestDb()
    const tagRepo = new CodeGraphTagRepository()
    const edgeRepo = new CodeGraphEdgeRepository()
    const rankRepo = new CodeGraphRankRepository()

    // Seed tags across two files (only files with symbols)
    tagRepo.upsertTags(
      wsId,
      [
        { relFname: 'src/a.ts', fname: '/abs/src/a.ts', line: 1, name: 'Foo', kind: 'def' },
        { relFname: 'src/b.ts', fname: '/abs/src/b.ts', line: 5, name: 'Bar', kind: 'def' }
      ],
      new Map([
        ['src/a.ts', 1000],
        ['src/b.ts', 2000]
      ])
    )

    // Seed edges
    edgeRepo.upsertEdges(wsId, [
      {
        workspaceId: wsId,
        sourceFile: 'src/a.ts',
        sourceSymbol: 'Foo',
        targetFile: 'src/b.ts',
        targetSymbol: 'Bar',
        edgeType: 'references',
        pageRank: 0
      }
    ])

    // Seed ranks — PageRank covers ALL discovered files (including ones
    // without tags), so rank count should be used for totalFiles
    rankRepo.upsertRanks(
      wsId,
      new Map([
        ['src/a.ts', 0.5],
        ['src/b.ts', 0.3],
        ['src/c.ts', 0.1],
        ['src/d.ts', 0.1]
      ])
    )

    // Service has no in-memory state for this workspace — should fall back to DB
    const state = codeGraphService.getIndexingState(wsId)
    assert.equal(state.status, 'complete')
    assert.equal(state.totalTags, 2)
    assert.equal(state.totalEdges, 1)
    // totalFiles comes from rank count (4), not tag file count (2)
    assert.equal(state.totalFiles, 4)
  })
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(
  `code-graph-db: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`
)
if (failed > 0) process.exitCode = 1

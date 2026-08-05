/**
 * Tests for memory-projection.service.ts — the markdown view of the fact DB.
 *
 * Covers index ranking and budget pruning, near-duplicate collapsing, topic
 * grouping and folding, frontmatter round-trip metadata, and the files actually
 * written to disk.
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact } from '../../../shared/types'

// The service statically imports memoryFactRepository, which pulls in db/index
// and its `schema.sql?raw` import — only loadable through the stub's hooks.
// `import` is hoisted above this call, so the module is required below instead.
setupElectronStub()

// db/index must load first: base-repository imports it, so requiring a
// repository cold trips a TDZ cycle (`Cannot access 'BaseRepository'`).
require('../../db/index')

const {
  memoryProjectionService,
  selectForIndex,
  groupByTopic,
  renderIndex,
  renderIndexLine,
  renderTopicFile,
  parseFactIds,
  slugify,
  MAX_INDEX_LINES,
  MEMORY_DIR,
  INDEX_FILENAME
} = require('../memory-projection.service') as typeof import('../memory-projection.service')

// ── Fixtures ────────────────────────────────────────────────────────────────

function fact(overrides: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    workspaceId: 'ws-1',
    category: 'convention',
    title: `Title ${overrides.id}`,
    content: `Content ${overrides.id}`,
    tags: [],
    scopePaths: [],
    tier: 0,
    confidence: 0.8,
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
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    validFrom: '2026-01-01 00:00:00',
    validTo: null,
    observedAt: '2026-01-01 00:00:00',
    recordedAt: '2026-01-01 00:00:00',
    ...overrides
  }
}

function withRepo(body: (root: string) => void): void {
  const root = join(tmpdir(), `mem-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  try {
    body(root)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ── Index selection ─────────────────────────────────────────────────────────

describe('selectForIndex', () => {
  test('ranks higher tiers first', () => {
    const { kept } = selectForIndex([
      fact({ id: 'a', tier: 0 }),
      fact({ id: 'b', tier: 3 }),
      fact({ id: 'c', tier: 1 })
    ])
    assert.deepEqual(kept.map((f) => f.id), ['b', 'c', 'a'])
  })

  test('breaks tier ties by confidence', () => {
    const { kept } = selectForIndex([
      fact({ id: 'low', tier: 2, confidence: 0.5 }),
      fact({ id: 'high', tier: 2, confidence: 0.95 })
    ])
    assert.equal(kept[0].id, 'high')
  })

  test('collapses near-duplicate titles to the best-ranked one', () => {
    const { kept, pruned } = selectForIndex([
      fact({ id: 'weak', title: 'Use Result types', tier: 0 }),
      fact({ id: 'strong', title: 'use  RESULT  types!', tier: 3 })
    ])
    assert.deepEqual(kept.map((f) => f.id), ['strong'])
    assert.equal(pruned, 1)
  })

  test('enforces the line budget and reports what it dropped', () => {
    const many = Array.from({ length: MAX_INDEX_LINES + 25 }, (_, i) =>
      fact({ id: `f${i}`, title: `Distinct title ${i}` })
    )
    const { kept, pruned } = selectForIndex(many)

    assert.equal(kept.length, MAX_INDEX_LINES)
    assert.equal(pruned, 25)
  })

  test('an empty database projects nothing and prunes nothing', () => {
    const { kept, pruned } = selectForIndex([])
    assert.deepEqual(kept, [])
    assert.equal(pruned, 0)
  })
})

// ── Topic grouping ──────────────────────────────────────────────────────────

describe('groupByTopic', () => {
  test('groups by the first subject tag, ignoring provenance tags', () => {
    const facts = Array.from({ length: 3 }, (_, i) =>
      fact({ id: `b${i}`, tags: ['bootstrap', 'docs', 'billing'] })
    )
    const topics = groupByTopic(facts)
    assert.ok(topics.has('billing'), 'provenance tags do not name the topic')
  })

  test('falls back to the category when there is no subject tag', () => {
    const facts = Array.from({ length: 3 }, (_, i) =>
      fact({ id: `g${i}`, tags: ['bootstrap'], category: 'gotcha' })
    )
    assert.ok(groupByTopic(facts).has('gotcha'))
  })

  test('folds thin topics into general', () => {
    const topics = groupByTopic([
      fact({ id: 'x', tags: ['rare-topic'] }),
      ...Array.from({ length: 3 }, (_, i) => fact({ id: `c${i}`, tags: ['caching'] }))
    ])

    assert.ok(!topics.has('rare-topic'), 'a one-fact topic does not earn its own file')
    assert.ok(topics.has('caching'))
    assert.deepEqual(topics.get('general')?.map((f) => f.id), ['x'])
  })

  test('returns topics in a stable alphabetical order', () => {
    const topics = groupByTopic([
      ...Array.from({ length: 3 }, (_, i) => fact({ id: `z${i}`, tags: ['zebra'] })),
      ...Array.from({ length: 3 }, (_, i) => fact({ id: `a${i}`, tags: ['alpha'] }))
    ])
    assert.deepEqual([...topics.keys()], ['alpha', 'zebra'])
  })
})

describe('slugify', () => {
  test('makes a filesystem-safe slug', () => {
    assert.equal(slugify('API / Billing!'), 'api-billing')
  })

  test('falls back to general for an unusable value', () => {
    assert.equal(slugify('///'), 'general')
  })
})

// ── Rendering ───────────────────────────────────────────────────────────────

describe('renderIndexLine', () => {
  test('emits exactly one line even for multi-line content', () => {
    const line = renderIndexLine(fact({ id: 'm', content: 'first\nsecond\nthird' }))
    assert.equal(line.split('\n').length, 2, 'one line plus its terminator')
    assert.ok(line.includes('first second third'))
  })

  test('includes tier, category, scope and id', () => {
    const line = renderIndexLine(
      fact({ id: 'abc123', tier: 2, category: 'gotcha', scopePaths: ['src/api'] })
    )
    assert.ok(line.includes('[T2/gotcha]'))
    assert.ok(line.includes('src/api'))
    assert.ok(line.includes('`abc123`'))
  })
})

describe('renderIndex', () => {
  test('writes frontmatter with a modified date and the fact ids', () => {
    const out = renderIndex([fact({ id: 'one' })], ['billing'], '2026-08-05T00:00:00.000Z')
    assert.ok(out.startsWith('---\n'))
    assert.ok(out.includes('modified: 2026-08-05T00:00:00.000Z'))
    assert.ok(out.includes('factIds: [one]'))
  })

  test('sections facts by tier, highest first', () => {
    const out = renderIndex(
      [fact({ id: 'w', tier: 3 }), fact({ id: 'o', tier: 0 })],
      [],
      '2026-08-05T00:00:00.000Z'
    )
    assert.ok(out.indexOf('## Wisdom (T3)') < out.indexOf('## Observed (T0)'))
  })

  test('links the topic files', () => {
    const out = renderIndex([fact({ id: 'a' })], ['billing'], '2026-08-05T00:00:00.000Z')
    assert.ok(out.includes('[`billing.md`](./billing.md)'))
  })

  test('says so explicitly when there is nothing to show', () => {
    const out = renderIndex([], [], '2026-08-05T00:00:00.000Z')
    assert.ok(out.includes('_No facts recorded yet._'))
  })
})

describe('renderTopicFile', () => {
  test('carries topic, modified date and fact ids in frontmatter', () => {
    const out = renderTopicFile('billing', [fact({ id: 'b1' })], '2026-08-05T00:00:00.000Z')
    assert.ok(out.includes('topic: billing'))
    assert.ok(out.includes('factIds: [b1]'))
  })

  test('renders full content rather than a one-line summary', () => {
    const out = renderTopicFile(
      'billing',
      [fact({ id: 'b1', content: 'line one\nline two' })],
      '2026-08-05T00:00:00.000Z'
    )
    assert.ok(out.includes('line one\nline two'))
  })
})

describe('parseFactIds', () => {
  test('reads ids back out of frontmatter', () => {
    const raw = renderIndex(
      [fact({ id: 'x1' }), fact({ id: 'x2' })],
      [],
      '2026-08-05T00:00:00.000Z'
    )
    assert.deepEqual(parseFactIds(raw), ['x1', 'x2'])
  })

  test('returns nothing for a file with no frontmatter', () => {
    assert.deepEqual(parseFactIds('# Hand written\n\nprose'), [])
  })
})

// ── Disk projection ─────────────────────────────────────────────────────────

describe('projectFacts', () => {
  test('writes the index and one file per topic', () => {
    withRepo((root) => {
      const facts = [
        ...Array.from({ length: 3 }, (_, i) => fact({ id: `bi${i}`, tags: ['billing'] })),
        ...Array.from({ length: 3 }, (_, i) => fact({ id: `ca${i}`, tags: ['caching'] }))
      ]
      const result = memoryProjectionService.projectFacts(facts, root)

      assert.ok(existsSync(join(root, MEMORY_DIR, INDEX_FILENAME)))
      assert.ok(existsSync(join(root, MEMORY_DIR, 'billing.md')))
      assert.ok(existsSync(join(root, MEMORY_DIR, 'caching.md')))
      assert.equal(result.factsProjected, 6)
      assert.equal(result.factsPruned, 0)
      assert.deepEqual(result.warnings, [])
    })
  })

  test('warns rather than silently truncating when the budget binds', () => {
    withRepo((root) => {
      const many = Array.from({ length: MAX_INDEX_LINES + 5 }, (_, i) =>
        fact({ id: `f${i}`, title: `Distinct title ${i}` })
      )
      const result = memoryProjectionService.projectFacts(many, root)

      assert.equal(result.factsPruned, 5)
      assert.equal(result.warnings.length, 1)
      assert.ok(result.warnings[0].includes('5 fact(s) omitted'))
    })
  })

  test('regenerating replaces the previous content instead of appending', () => {
    withRepo((root) => {
      memoryProjectionService.projectFacts([fact({ id: 'first' })], root)
      memoryProjectionService.projectFacts([fact({ id: 'second' })], root)

      const index = readFileSync(join(root, MEMORY_DIR, INDEX_FILENAME), 'utf-8')
      assert.ok(index.includes('second'))
      assert.ok(!index.includes('`first`'))
    })
  })

  test('creates the memory directory when it does not exist', () => {
    withRepo((root) => {
      assert.ok(!existsSync(join(root, MEMORY_DIR)))
      memoryProjectionService.projectFacts([fact({ id: 'a' })], root)
      assert.ok(existsSync(join(root, MEMORY_DIR)))
    })
  })

  test('readProjectedIds reports the ids each file was generated from', () => {
    withRepo((root) => {
      const facts = Array.from({ length: 3 }, (_, i) => fact({ id: `bi${i}`, tags: ['billing'] }))
      memoryProjectionService.projectFacts(facts, root)

      const projected = memoryProjectionService.readProjectedIds(root)
      assert.deepEqual(projected.get('billing.md'), ['bi0', 'bi1', 'bi2'])
    })
  })

  test('readProjectedIds tolerates a hand-written file with no frontmatter', () => {
    withRepo((root) => {
      memoryProjectionService.projectFacts([fact({ id: 'a' })], root)
      writeFileSync(join(root, MEMORY_DIR, 'notes.md'), '# my notes\n', 'utf-8')

      const projected = memoryProjectionService.readProjectedIds(root)
      assert.deepEqual(projected.get('notes.md'), [])
    })
  })

  test('readProjectedIds returns empty when nothing has been projected', () => {
    withRepo((root) => {
      assert.equal(memoryProjectionService.readProjectedIds(root).size, 0)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Tests for the Feed Brain planner — the PLAN half of plan-then-drain.
 *
 * The planner is what makes progress honest: it must emit one row per unit of
 * work up front, ranked so the highest-signal documents drain first, with
 * worthless files dropped before they cost an LLM call.
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, beforeEach, afterEach } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { PlannedItem } from '../../db/repositories/memory-bootstrap.repository'

setupElectronStub()

const { planRun, shouldHonourHashGate } = require('../memory-bootstrap/planner')
const {
  PHASE_BASE_PRIORITY,
  DOC_PRIORITY_TOP,
  DOC_PRIORITY_SCATTERED,
  MIN_DOC_CHARS
} = require('../memory-bootstrap/constants')

/** Body long enough to survive the planner's prose threshold. */
const BODY = 'x'.repeat(MIN_DOC_CHARS + 100)

const baseCtx = (workspacePath: string): Record<string, unknown> => ({
  workspaceId: 'ws-test',
  workspacePath,
  mode: 'full',
  scope: 'changed',
  hasIndex: false, // keeps the planner off codeGraphService
  lastCommit: null,
  headSha: null
})

const byKind = (items: PlannedItem[], kind: string): PlannedItem[] =>
  items.filter((i) => i.kind === kind)

const find = (items: PlannedItem[], ref: string): PlannedItem | undefined =>
  items.find((i) => i.sourceRef === ref)

describe('bootstrap planner — item set', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `bootstrap-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('emits one item per surviving document', async () => {
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)
    writeFileSync(join(dir, 'ARCHITECTURE.md'), `# Arch\n${BODY}`)
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'guide.md'), `# Guide\n${BODY}`)

    const { items } = await planRun(baseCtx(dir))
    const docs = byKind(items, 'doc').map((i) => i.sourceRef)

    assert.ok(docs.includes('README.md'), 'README is planned')
    assert.ok(docs.includes('ARCHITECTURE.md'), 'ARCHITECTURE is planned')
    assert.ok(
      docs.some((d) => d.endsWith('guide.md')),
      'docs/guide.md is planned'
    )
  })

  test('always plans the deterministic analysis items', async () => {
    const { items } = (await planRun(baseCtx(dir))) as { items: PlannedItem[] }
    const kinds = items.map((i) => i.kind)

    assert.ok(kinds.includes('manifests'), 'stack phase is one manifests item')
    assert.ok(kinds.includes('cochange'), 'history includes co-change')
    assert.ok(kinds.includes('commits'), 'history includes commit mining')
    assert.ok(kinds.includes('cycles'), 'Feed Brain includes the structure phase')
    assert.ok(!kinds.includes('agent'), 'Feed Brain does not spawn an agent')
  })

  test('deep-scan swaps the structure phase for an agent item', async () => {
    const { items } = (await planRun({ ...baseCtx(dir), mode: 'deep-scan' })) as {
      items: PlannedItem[]
    }
    const kinds = items.map((i) => i.kind)

    assert.ok(kinds.includes('agent'), 'deep-scan plans the exploration agent')
    assert.ok(!kinds.includes('cycles'), 'deep-scan drops the structure phase')
    assert.equal(byKind(items, 'agent').length, 1, 'exactly one agent item')
  })

  test('hotspots are only planned when a code-graph index exists', async () => {
    const without = await planRun(baseCtx(dir))
    assert.equal(byKind(without.items, 'hotspots').length, 0)

    // hasIndex also unlocks the architecture phase, which needs codeGraphService;
    // that path is exercised in the service integration tests.
  })

  test('source refs are workspace-relative, not absolute', async () => {
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)

    const { items } = await planRun(baseCtx(dir))
    const readme = find(items, 'README.md')

    assert.ok(readme, 'README planned under a relative ref')
    assert.ok(
      !byKind(items, 'doc').some((i) => i.sourceRef.startsWith('/')),
      'no absolute paths leak into the queue'
    )
  })
})

describe('bootstrap planner — prefiltering', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `bootstrap-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('drops documents below the prose threshold', async () => {
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)
    writeFileSync(join(dir, 'STUB.md'), '# tiny')

    const { items, prefiltered } = await planRun(baseCtx(dir))

    assert.equal(find(items, 'STUB.md'), undefined, 'a stub never reaches the queue')
    assert.ok(prefiltered.tooSmall >= 1, 'the drop is counted')
  })

  test('drops LICENSE and other generated documents', async () => {
    writeFileSync(join(dir, 'LICENSE.md'), `MIT License\n${BODY}`)
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)

    const { items, prefiltered } = await planRun(baseCtx(dir))

    assert.equal(find(items, 'LICENSE.md'), undefined, 'boilerplate is not worth an LLM call')
    assert.ok(prefiltered.generated >= 1)
    assert.ok(find(items, 'README.md'), 'real docs still get through')
  })

  test('drops a vendored copy with the same name and size', async () => {
    const body = `# Guide\n${BODY}`
    mkdirSync(join(dir, 'docs'), { recursive: true })
    mkdirSync(join(dir, 'guides'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'guide.md'), body)
    writeFileSync(join(dir, 'guides', 'guide.md'), body)

    const { items, prefiltered } = await planRun(baseCtx(dir))
    const guides = byKind(items, 'doc').filter((i) => i.sourceRef.endsWith('guide.md'))

    assert.equal(guides.length, 1, 'identical copies extract to identical facts')
    assert.ok(prefiltered.duplicate >= 1)
  })
})

describe('bootstrap planner — priority ordering', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `bootstrap-prio-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('the manifests item drains before any document', async () => {
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)

    const { items } = await planRun(baseCtx(dir))
    const manifests = find(items, 'project-manifests')!
    const readme = find(items, 'README.md')!

    assert.ok(manifests.priority! < readme.priority!, 'cheap stack analysis goes first')
  })

  test('README outranks a scattered note', async () => {
    writeFileSync(join(dir, 'README.md'), `# Readme\n${BODY}`)
    mkdirSync(join(dir, 'src', 'feature'), { recursive: true })
    writeFileSync(join(dir, 'src', 'feature', 'notes.md'), `# Notes\n${BODY}`)

    const { items } = await planRun(baseCtx(dir))
    const readme = find(items, 'README.md')!
    const scattered = byKind(items, 'doc').find((i) => i.sourceRef.endsWith('notes.md'))!

    assert.equal(readme.priority, PHASE_BASE_PRIORITY.docs + DOC_PRIORITY_TOP)
    assert.equal(scattered.priority, PHASE_BASE_PRIORITY.docs + DOC_PRIORITY_SCATTERED)
    assert.ok(readme.priority! < scattered.priority!, 'high-signal docs land in the first minute')
  })

  test('phases are ordered by their priority bases', async () => {
    const { items } = await planRun({ ...baseCtx(dir), mode: 'deep-scan' })
    const agent = find(items, 'agent:deep-scan')!
    const commits = find(items, 'git:recent-commits')!
    const manifests = find(items, 'project-manifests')!

    assert.ok(manifests.priority! < commits.priority!, 'stack before history')
    assert.ok(commits.priority! < agent.priority!, 'the agent sees history already recorded')
  })
})

describe('bootstrap scope → hash gate', () => {
  test("'changed' honours the hash gate everywhere", () => {
    assert.equal(shouldHonourHashGate('changed', 'docs'), true)
    assert.equal(shouldHonourHashGate('changed', 'architecture'), true)
  })

  test("'docs' re-reads documentation but keeps other phases gated", () => {
    assert.equal(shouldHonourHashGate('docs', 'docs'), false)
    assert.equal(
      shouldHonourHashGate('docs', 'architecture'),
      true,
      're-ingesting docs must not cost the architecture phase its memory'
    )
  })

  test("'deep-scan' re-reads central source files only", () => {
    assert.equal(shouldHonourHashGate('deep-scan', 'architecture'), false)
    assert.equal(shouldHonourHashGate('deep-scan', 'docs'), true)
  })

  test("'full' ignores the gate everywhere", () => {
    assert.equal(shouldHonourHashGate('full', 'docs'), false)
    assert.equal(shouldHonourHashGate('full', 'architecture'), false)
  })
})

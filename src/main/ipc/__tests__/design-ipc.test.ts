/**
 * design.ipc.ts — trust boundary + handler surface.
 *
 * `parseDesignRunConfig` is the gate between an untrusted renderer payload and
 * P3's file enumeration / `impeccable detect <targets>` spawn, both of which run
 * with `cwd = workspacePath`. These tests pin the properties that make that
 * gate safe — path containment, bounded input, catalogue membership, and the
 * incompatibility matrix — before any consumer exists, because validation added
 * after the consumer is validation that arrives too late.
 *
 * Also covers the DESIGN_DELETE_RUN kind guard: design and Workspace Health
 * share `audit_runs`, so deleting by id alone would let the design page remove
 * a health run.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getMockRepo,
  evictFromCache
} from '../../services/__tests__/setup-full-mock'
import {
  getHandlers,
  mockMainWindow,
  mockEvent,
  tryInvokeHandler
} from '../../services/__tests__/electron-stub'
import { IPC_CHANNELS } from '../../../shared/constants'
import type { DesignRunConfig } from '../../../shared/types'

// Install the full mock BEFORE design.ipc (and its repository imports) load.
setupFullMock()
evictFromCache('ipc/design.ipc')

const designIpc = require('../design.ipc') as {
  parseDesignRunConfig: (args: unknown, channel: string) => DesignRunConfig
  normalizeScopePath: (raw: string, channel: string) => string
  registerDesignIpc: (win: unknown) => void
  MAX_BRIEF_CHARS: number
  MAX_SCOPE_PATHS: number
}

const { parseDesignRunConfig, normalizeScopePath, MAX_BRIEF_CHARS, MAX_SCOPE_PATHS } = designIpc

// Register at module scope, not inside a test: the harness runs the tests in a
// describe concurrently, so a handler registered by one test would not reliably
// exist when a sibling invokes it. The handler map is process-global and shared
// with every other IPC test file, so it must never be cleared here.
designIpc.registerDesignIpc(mockMainWindow)

const CH = 'design:test'

/** Parse with a minimal valid command selection unless overridden. */
function parse(partial: Record<string, unknown>): DesignRunConfig {
  return parseDesignRunConfig({ commandIds: ['audit'], ...partial }, CH)
}

// ── §1: Command id validation ────────────────────────────────────────────────

describe('parseDesignRunConfig — command ids', () => {
  test('rejects a missing or empty commandIds array', () => {
    assert.throws(() => parseDesignRunConfig({}, CH), /non-empty array/)
    assert.throws(() => parseDesignRunConfig({ commandIds: [] }, CH), /non-empty array/)
    assert.throws(() => parseDesignRunConfig({ commandIds: 'audit' }, CH), /non-empty array/)
  })

  test('rejects an id that is not in the catalogue', () => {
    assert.throws(() => parseDesignRunConfig({ commandIds: ['audit', 'shape'] }, CH), /unknown/)
    // `overdrive` is a real engine command deliberately excluded from the cards.
    assert.throws(() => parseDesignRunConfig({ commandIds: ['overdrive'] }, CH), /unknown/)
    assert.throws(() => parseDesignRunConfig({ commandIds: [42] }, CH), /unknown/)
  })

  test('de-duplicates rather than rejecting a repeated id', () => {
    const cfg = parseDesignRunConfig({ commandIds: ['audit', 'critique', 'audit'] }, CH)
    assert.deepEqual(cfg.commandIds, ['audit', 'critique'])
  })

  test('enforces the incompatibility matrix, not just the wizard', () => {
    assert.throws(
      () => parseDesignRunConfig({ commandIds: ['bolder', 'quieter'] }, CH),
      /incompatible/
    )
    assert.throws(
      () => parseDesignRunConfig({ commandIds: ['distill', 'animate'] }, CH),
      /incompatible/
    )
  })

  test('accepts a compatible multi-command selection', () => {
    const cfg = parseDesignRunConfig({ commandIds: ['audit', 'critique', 'polish'] }, CH)
    assert.deepEqual(cfg.commandIds, ['audit', 'critique', 'polish'])
  })
})

// ── §2: Scope path containment ───────────────────────────────────────────────

describe('normalizeScopePath — containment', () => {
  test('rejects absolute POSIX paths', () => {
    assert.throws(() => normalizeScopePath('/etc/passwd', CH), /absolute/)
    assert.throws(() => normalizeScopePath('/', CH), /absolute/)
  })

  test('rejects Windows drive and UNC paths regardless of host platform', () => {
    assert.throws(() => normalizeScopePath('C:\\Windows\\System32', CH), /absolute/)
    assert.throws(() => normalizeScopePath('c:/Windows', CH), /absolute/)
    assert.throws(() => normalizeScopePath('\\\\server\\share', CH), /absolute/)
  })

  test('rejects paths that climb out of the workspace', () => {
    assert.throws(() => normalizeScopePath('..', CH), /escapes/)
    assert.throws(() => normalizeScopePath('../../../../etc', CH), /escapes/)
    // Interior climbs are resolved first, so this one is caught too.
    assert.throws(() => normalizeScopePath('src/../../etc/passwd', CH), /escapes/)
  })

  test('rejects NUL bytes and empty entries', () => {
    assert.throws(() => normalizeScopePath('src/App\0.tsx', CH), /NUL/)
    assert.throws(() => normalizeScopePath('   ', CH), /empty/)
    assert.throws(() => normalizeScopePath('.', CH), /must name a file or directory/)
  })

  test('normalises relative forms to a single canonical string', () => {
    assert.equal(normalizeScopePath('./src/App.tsx', CH), 'src/App.tsx')
    assert.equal(normalizeScopePath('src/', CH), 'src')
    assert.equal(normalizeScopePath('src//components', CH), 'src/components')
    // An interior climb that stays inside the workspace is legal.
    assert.equal(normalizeScopePath('src/components/../App.tsx', CH), 'src/App.tsx')
  })
})

describe('parseDesignRunConfig — scope', () => {
  test('defaults to whole-project scope when scope is omitted', () => {
    const cfg = parse({})
    assert.equal(cfg.scope.mode, 'project')
    assert.deepEqual(cfg.scope.paths, [])
  })

  test("drops paths when mode is 'project'", () => {
    const cfg = parse({ scope: { mode: 'project', paths: ['src/App.tsx'] } })
    assert.deepEqual(cfg.scope.paths, [])
  })

  test("requires at least one path when mode is 'paths'", () => {
    assert.throws(() => parse({ scope: { mode: 'paths', paths: [] } }), /at least one path/)
  })

  test('rejects a non-array or non-string paths payload', () => {
    assert.throws(() => parse({ scope: { mode: 'paths', paths: 'src' } }), /must be an array/)
    assert.throws(() => parse({ scope: { mode: 'paths', paths: [7] } }), /must be strings/)
  })

  test('propagates traversal rejection from the path normaliser', () => {
    assert.throws(
      () => parse({ scope: { mode: 'paths', paths: ['src/App.tsx', '../../../../etc'] } }),
      /escapes/
    )
    assert.throws(() => parse({ scope: { mode: 'paths', paths: ['/etc/passwd'] } }), /absolute/)
  })

  test('de-duplicates paths after normalisation', () => {
    const cfg = parse({
      scope: { mode: 'paths', paths: ['src/App.tsx', './src/App.tsx', 'src//App.tsx'] }
    })
    assert.deepEqual(cfg.scope.paths, ['src/App.tsx'])
  })

  test('caps the number of paths', () => {
    const tooMany = Array.from({ length: MAX_SCOPE_PATHS + 1 }, (_, i) => `src/f${i}.tsx`)
    assert.throws(() => parse({ scope: { mode: 'paths', paths: tooMany } }), /max/)
    const atLimit = Array.from({ length: MAX_SCOPE_PATHS }, (_, i) => `src/f${i}.tsx`)
    assert.equal(
      parse({ scope: { mode: 'paths', paths: atLimit } }).scope.paths.length,
      MAX_SCOPE_PATHS
    )
  })
})

// ── §3: Brief bounds ─────────────────────────────────────────────────────────

describe('parseDesignRunConfig — brief', () => {
  test('caps the brief length', () => {
    assert.throws(() => parse({ brief: 'x'.repeat(MAX_BRIEF_CHARS + 1) }), /max/)
    assert.equal(parse({ brief: 'x'.repeat(MAX_BRIEF_CHARS) }).brief.length, MAX_BRIEF_CHARS)
  })

  test('trims, and treats a non-string brief as absent', () => {
    assert.equal(parse({ brief: '  animate the profile page  ' }).brief, 'animate the profile page')
    assert.equal(parse({ brief: 12 }).brief, '')
    assert.equal(parse({}).brief, '')
  })

  test('passes llmProvider through only when it is a string', () => {
    assert.equal(parse({ llmProvider: 'local-llm' }).llmProvider, 'local-llm')
    assert.equal(parse({ llmProvider: 3 }).llmProvider, undefined)
  })
})

// ── §4: Handler surface ──────────────────────────────────────────────────────

describe('design IPC — handlers', () => {
  test('registers every design channel', () => {
    const expected = [
      IPC_CHANNELS.DESIGN_START,
      IPC_CHANNELS.DESIGN_CANCEL,
      IPC_CHANNELS.DESIGN_ROUTE,
      IPC_CHANNELS.DESIGN_CONTEXT_STATUS,
      IPC_CHANNELS.DESIGN_GENERATE_REPORT,
      IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT,
      IPC_CHANNELS.DESIGN_GET_LATEST,
      IPC_CHANNELS.DESIGN_GET_HISTORY,
      IPC_CHANNELS.DESIGN_DELETE_RUN
    ]
    for (const ch of expected) {
      assert.ok(getHandlers().has(ch), `missing handler for ${ch}`)
    }
  })

  // DESIGN_START / DESIGN_CANCEL became real in P3.5. The channels that are
  // still stubs must keep degrading structurally rather than throwing.
  test('still-unimplemented handlers report a structured failure, never throw', async () => {
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_CONTEXT_STATUS, {
      workspaceId: 'ws-1'
    })
    assert.ok(res.ok, 'DESIGN_CONTEXT_STATUS should resolve rather than throw')
    assert.deepEqual((res.result as { ok: boolean }).ok, false)
    assert.match((res.result as { reason: string }).reason, /not implemented/)
  })

  test('DESIGN_START rejects an incompatible selection before doing any work', async () => {
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_START, {
      workspaceId: 'ws-1',
      commandIds: ['bolder', 'quieter']
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error.message, /incompatible/)
  })

  test('DESIGN_START requires a workspaceId', async () => {
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_START, { commandIds: ['audit'] })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error.message, /workspaceId/)
  })

  test('DESIGN_START refuses a workspace that does not exist', async () => {
    const repo = getMockRepo('workspace')
    repo.findById.mockReset().mockReturnValue(null)

    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_START, {
      workspaceId: 'ws-missing',
      commandIds: ['audit'],
      brief: 'audit the dashboard'
    })
    assert.ok(res.ok, 'a missing workspace is an expected outcome, not an exception')
    assert.deepEqual((res.result as { ok: boolean }).ok, false)
    assert.match((res.result as { reason: string }).reason, /not found/)
  })

  test('DESIGN_ROUTE bounds the brief it forwards to the LLM', async () => {
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_ROUTE, {
      brief: 'x'.repeat(MAX_BRIEF_CHARS + 1)
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error.message, /max/)
  })

  // The harness runs tests within a describe concurrently, and every handler in
  // this block shares one repository spy — so each scenario that inspects call
  // counts is asserted sequentially inside a single test rather than split.

  test('read handlers return the shared envelope, scoped to design runs', async () => {
    const repo = getMockRepo('audit')
    repo.getLatestForWorkspace.mockReset().mockReturnValue(null)
    repo.getHistoryForWorkspace.mockReset().mockReturnValue([])

    const latest = await tryInvokeHandler(IPC_CHANNELS.DESIGN_GET_LATEST, { workspaceId: 'ws-1' })
    assert.ok(latest.ok)
    assert.deepEqual(latest.result, { ok: true, data: null })
    assert.equal(repo.getLatestForWorkspace.lastCall?.[1], 'design')

    const history = await tryInvokeHandler(IPC_CHANNELS.DESIGN_GET_HISTORY, { workspaceId: 'ws-1' })
    assert.ok(history.ok)
    assert.deepEqual(history.result, { ok: true, data: [] })
    assert.equal(repo.getHistoryForWorkspace.lastCall?.[2], 'design')
  })

  test('DESIGN_DELETE_RUN enforces the kind guard', async () => {
    const repo = getMockRepo('audit')

    // 1. A Workspace Health run must not be deletable through the design page.
    repo.findRunById.mockReset().mockReturnValue({ id: 'run-1', kind: 'code' })
    repo.deleteRun.mockReset().mockReturnValue(true)
    const health = await tryInvokeHandler(IPC_CHANNELS.DESIGN_DELETE_RUN, { runId: 'run-1' })
    assert.ok(health.ok)
    assert.deepEqual(health.result, { ok: false, reason: 'not a design run' })
    assert.equal(repo.deleteRun.callCount, 0, 'deleteRun must not be reached')

    // 2. A missing run reports, rather than throwing across IPC.
    repo.findRunById.mockReset().mockImplementation(() => undefined)
    repo.deleteRun.mockReset()
    const missing = await tryInvokeHandler(IPC_CHANNELS.DESIGN_DELETE_RUN, { runId: 'nope' })
    assert.ok(missing.ok)
    assert.deepEqual(missing.result, { ok: false, reason: 'run not found' })
    assert.equal(repo.deleteRun.callCount, 0)

    // 3. A design run deletes and reports through the same envelope.
    repo.findRunById.mockReset().mockReturnValue({ id: 'run-2', kind: 'design' })
    repo.deleteRun.mockReset().mockReturnValue(true)
    const design = await tryInvokeHandler(IPC_CHANNELS.DESIGN_DELETE_RUN, { runId: 'run-2' })
    assert.ok(design.ok)
    assert.deepEqual(design.result, { ok: true, data: null })
    assert.equal(repo.deleteRun.callCount, 1)
    assert.equal(repo.deleteRun.lastCall?.[0], 'run-2')
  })

  test('mock event passes validateSender', () => {
    assert.ok(mockEvent.senderFrame?.url.startsWith('file://'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

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
import { test, describe, runExclusive, summaryAsync } from '../../services/__tests__/test-harness'
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
  reconcileStaleDesignRun: (run: unknown, workspaceId: string) => unknown
  rollupScopeDirs: (filePaths: readonly string[]) => Map<string, number>
  pickSuggestedDir: (counts: ReadonlyMap<string, number>, totalFiles: number) => string | null
  sanitizeScopeHint: (hint: string | null) => string | null
  MAX_BRIEF_CHARS: number
  MAX_SCOPE_PATHS: number
  MAX_SCOPE_TREE_DIRS: number
}

const {
  parseDesignRunConfig,
  normalizeScopePath,
  reconcileStaleDesignRun,
  rollupScopeDirs,
  pickSuggestedDir,
  sanitizeScopeHint,
  MAX_BRIEF_CHARS,
  MAX_SCOPE_PATHS,
  MAX_SCOPE_TREE_DIRS
} = designIpc

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
      IPC_CHANNELS.DESIGN_SCOPE_TREE,
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

  // Both scenarios below drive the SAME workspace spy, so they are asserted
  // sequentially in one test rather than split into two concurrent ones.
  test('DESIGN_START and DESIGN_SCOPE_TREE refuse an unusable workspace', async () => {
    const repo = getMockRepo('workspace')

    repo.findById.mockReset().mockReturnValue(null)
    const missing = await tryInvokeHandler(IPC_CHANNELS.DESIGN_START, {
      workspaceId: 'ws-missing',
      commandIds: ['audit'],
      brief: 'audit the dashboard'
    })
    assert.ok(missing.ok, 'a missing workspace is an expected outcome, not an exception')
    assert.deepEqual((missing.result as { ok: boolean }).ok, false)
    assert.match((missing.result as { reason: string }).reason, /not found/)

    // The scope tree walks the filesystem at `repoPath`, so a workspace without
    // one must be refused before any walk is attempted.
    repo.findById.mockReset().mockReturnValue({ id: 'ws-1', repoPath: null })
    const noPath = await tryInvokeHandler(IPC_CHANNELS.DESIGN_SCOPE_TREE, { workspaceId: 'ws-1' })
    assert.ok(noPath.ok, 'a missing repo path is an expected outcome, not an exception')
    assert.deepEqual((noPath.result as { ok: boolean }).ok, false)
    assert.match((noPath.result as { reason: string }).reason, /repo path/)
  })

  test('DESIGN_ROUTE bounds the brief it forwards to the LLM', async () => {
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_ROUTE, {
      workspaceId: 'ws-1',
      brief: 'x'.repeat(MAX_BRIEF_CHARS + 1)
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error.message, /max/)
  })

  test('DESIGN_ROUTE requires a workspaceId', async () => {
    // The route call resolves a per-workspace model and provider, so it cannot
    // proceed without one.
    const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_ROUTE, { brief: 'make it bolder' })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error.message, /workspaceId/)
  })

  // The harness runs tests within a describe concurrently, and every handler in
  // this block shares one repository spy — so each scenario that inspects call
  // counts is asserted sequentially inside a single test rather than split.

  // `runExclusive` on both tests below: they drive the SAME
  // `getLatestForWorkspace` spy, and the harness runs a describe's tests
  // concurrently, so without the lock one would answer the other's call.
  test('read handlers return the shared envelope, scoped to design runs', () =>
    runExclusive(async () => {
      const repo = getMockRepo('audit')
      repo.getLatestForWorkspace.mockReset().mockReturnValue(null)
      repo.getHistoryForWorkspace.mockReset().mockReturnValue([])

      const latest = await tryInvokeHandler(IPC_CHANNELS.DESIGN_GET_LATEST, { workspaceId: 'ws-1' })
      assert.ok(latest.ok)
      assert.deepEqual(latest.result, { ok: true, data: null })
      assert.equal(repo.getLatestForWorkspace.lastCall?.[1], 'design')

      const history = await tryInvokeHandler(IPC_CHANNELS.DESIGN_GET_HISTORY, {
        workspaceId: 'ws-1'
      })
      assert.ok(history.ok)
      assert.deepEqual(history.result, { ok: true, data: [] })
      assert.equal(repo.getHistoryForWorkspace.lastCall?.[2], 'design')
    }))

  test('REGRESSION: DESIGN_GET_LATEST reconciles a run left running by a crash', () =>
    runExclusive(async () => {
      // Without this, quitting mid-run dead-ends the Design tab for that
      // workspace forever: the row stays 'running', the store derives
      // `isRunning: true` from it, the page pins itself to the run view, and
      // Cancel is a no-op because the service lost its in-memory state.
      const repo = getMockRepo('audit')
      const stale = {
        id: 'run-stale',
        workspaceId: 'ws-1',
        kind: 'design',
        status: 'running',
        results: [
          { id: 'res-a', trackId: 'design:critique', status: 'running' },
          { id: 'res-b', trackId: 'design:audit', status: 'pending' }
        ]
      }
      repo.getLatestForWorkspace.mockReset().mockReturnValue(stale)
      repo.updateResult.mockReset()
      repo.updateRun
        .mockReset()
        .mockImplementation((_id: string, patch: Record<string, unknown>) => ({
          ...stale,
          ...patch
        }))

      const res = await tryInvokeHandler(IPC_CHANNELS.DESIGN_GET_LATEST, { workspaceId: 'ws-1' })
      assert.ok(res.ok)
      const run = (res.result as { ok: true; data: { status: string } }).data

      // No pass completed, so the whole run is cancelled — not 'partial'.
      assert.equal(run.status, 'cancelled')
      assert.equal(repo.updateRun.lastCall?.[1]?.status, 'cancelled')

      // Both incomplete passes are flipped, so the UI stops showing spinners.
      assert.equal(repo.updateResult.callCount, 2)
      assert.deepEqual(
        repo.updateResult.calls.map((c: unknown[]) => c[0]),
        ['res-a', 'res-b']
      )

      repo.getLatestForWorkspace.mockReset().mockReturnValue(null)
      repo.updateRun.mockReset()
      repo.updateResult.mockReset()
    }))

  test('reconcileStaleDesignRun leaves terminal runs alone and reports partial', () =>
    runExclusive(async () => {
      // Also exclusive: the 'partial' branch writes through the same repository
      // spies the test above counts calls on.
      const repo = getMockRepo('audit')
      repo.updateRun.mockReset()
      repo.updateResult.mockReset()

      const terminal = { id: 'r', status: 'completed', results: [] }
      assert.equal(reconcileStaleDesignRun(terminal, 'ws-x'), terminal, 'returned untouched')
      assert.equal(reconcileStaleDesignRun(null, 'ws-x'), null)
      assert.equal(repo.updateRun.callCount, 0, 'a terminal run must not be written')

      // A run that got a pass through is 'partial' — its findings are still
      // worth reading, so reporting it as 'cancelled' would hide them.
      const partial = {
        id: 'r2',
        status: 'running',
        results: [
          { id: 'a', status: 'completed' },
          { id: 'b', status: 'running' }
        ]
      }
      const out = reconcileStaleDesignRun(partial, 'ws-x') as { status: string }
      assert.equal(out.status, 'partial')
      // Only the incomplete pass is touched; the completed one keeps its result.
      assert.equal(repo.updateResult.callCount, 1)
      assert.equal(repo.updateResult.lastCall?.[0], 'b')

      repo.updateRun.mockReset()
      repo.updateResult.mockReset()
    }))

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

// ── §5: scope tree rollup (P4.0) ─────────────────────────────────────────────

describe('rollupScopeDirs', () => {
  test('counts every ancestor, so a directory reports what selecting it reviews', () => {
    const counts = rollupScopeDirs([
      'src/renderer/a.tsx',
      'src/renderer/deep/b.tsx',
      'src/main/c.css'
    ])
    assert.equal(counts.get('src'), 3)
    assert.equal(counts.get('src/renderer'), 2)
    assert.equal(counts.get('src/renderer/deep'), 1)
    assert.equal(counts.get('src/main'), 1)
  })

  test('a file at the workspace root contributes no directory', () => {
    const counts = rollupScopeDirs(['eslint.config.mjs'])
    assert.equal(counts.size, 0)
  })
})

describe('pickSuggestedDir', () => {
  test('descends past the top level instead of answering "the whole project"', () => {
    // The degeneracy this guards: cumulative counts make every ancestor score at
    // least as high as its children, so a plain max would always return `src` —
    // i.e. the whole-project scan P3.7.9 measured at 37.8s and exists to avoid.
    const paths = [
      ...Array.from({ length: 20 }, (_, i) => `src/renderer/components/c${i}.tsx`),
      'src/main/one.css'
    ]
    const suggested = pickSuggestedDir(rollupScopeDirs(paths), paths.length)
    assert.equal(suggested, 'src/renderer/components')
  })

  test('stops descending once a child would lose most of the surface', () => {
    // An even split between two children: neither holds 80%, so the parent wins.
    const paths = [
      ...Array.from({ length: 5 }, (_, i) => `src/a/x${i}.tsx`),
      ...Array.from({ length: 5 }, (_, i) => `src/b/y${i}.tsx`)
    ]
    assert.equal(pickSuggestedDir(rollupScopeDirs(paths), paths.length), 'src')
  })

  test('returns null for an empty workspace and for root-only files', () => {
    assert.equal(pickSuggestedDir(new Map(), 0), null)
    assert.equal(pickSuggestedDir(rollupScopeDirs(['index.html']), 1), null)
  })

  test('the directory list is capped', () => {
    // The cap is what keeps a monorepo rollup from shipping thousands of rows
    // across IPC into a list a human is expected to read.
    assert.equal(MAX_SCOPE_TREE_DIRS, 200)
  })
})

// ── §6: route scope hint containment (P4.3) ──────────────────────────────────

describe('sanitizeScopeHint', () => {
  test('passes a workspace-relative path through, normalised', () => {
    assert.equal(sanitizeScopeHint('src/renderer'), 'src/renderer')
    assert.equal(sanitizeScopeHint('./src/renderer/'), 'src/renderer')
  })

  test('drops anything that escapes the workspace instead of throwing', () => {
    // The hint is an assist. A bad one costs the user a dropdown click; a throw
    // here would fail the whole route call and lose the command preselect too.
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows', '..']) {
      assert.equal(sanitizeScopeHint(bad), null, `${bad} must be dropped`)
    }
  })

  test('null in, null out', () => {
    assert.equal(sanitizeScopeHint(null), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

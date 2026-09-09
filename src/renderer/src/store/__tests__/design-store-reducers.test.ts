/**
 * design-store-utils — the reducers behind design.store's IPC handlers.
 *
 * The property under test is G2, and it is the reason this file exists at all:
 * `sendWorkspaceEvent` broadcasts every design event to the renderer with only
 * a workspaceId *tag* — it does not filter. Design runs are permitted to run
 * concurrently across workspaces (DESIGN_START guards per workspace, not
 * globally), so a page bound to workspace A genuinely receives workspace B's
 * events. Copying audit.store verbatim would have let B's findings overwrite
 * A's run row in the renderer, which is exactly the bug P3.7.3 fixed in main.
 *
 * Run: tsx src/renderer/src/store/__tests__/design-store-reducers.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  applyDesignIntermediate,
  applyDesignProgress,
  applyDesignResult,
  isEventForWorkspace,
  type DesignReducerState
} from '../design-store-utils'
import type {
  AuditCoverageStats,
  AuditFinding,
  AuditResult,
  AuditRun,
  DesignResultEvent
} from '../../../../shared/types'

const WS_A = 'ws-a'
const WS_B = 'ws-b'
const TRACK = 'design:critique' as const

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    id: 'res-1',
    auditRunId: 'run-1',
    trackId: TRACK,
    score: null,
    status: 'pending',
    findings: [],
    summary: '',
    skillsUsed: [],
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

function run(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    id: 'run-1',
    workspaceId: WS_A,
    mode: 'deep',
    status: 'running',
    overallScore: null,
    selectedTracks: [TRACK],
    detectedTechs: [],
    kind: 'design',
    results: [result()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function state(overrides: Partial<DesignReducerState> = {}): DesignReducerState {
  return { workspaceId: WS_A, currentRun: run(), liveStreamText: {}, ...overrides }
}

const coverage: AuditCoverageStats = {
  filesInspected: ['src/a.tsx'],
  fileCount: 1,
  toolCallCount: 3,
  readToolCount: 1
}

const finding: AuditFinding = {
  id: 'f-1',
  severity: 'medium',
  title: 'Monotonous grid',
  description: 'Every card is the same size.'
}

// ── §1: the workspace filter (G2) ────────────────────────────────────────────

describe('isEventForWorkspace', () => {
  test('accepts only the bound workspace', () => {
    assert.equal(isEventForWorkspace({ workspaceId: WS_A }, WS_A), true)
    assert.equal(isEventForWorkspace({ workspaceId: WS_A }, WS_B), false)
  })

  test('an unbound store accepts nothing', () => {
    // Before loadLatest there is no run to merge into and no way to tell whose
    // event this is — accepting it would attribute a background run to nobody.
    assert.equal(isEventForWorkspace({ workspaceId: null }, WS_A), false)
  })
})

describe('G2 — an event from another workspace never mutates state', () => {
  test('progress from another workspace is refused', () => {
    const patch = applyDesignProgress(state(), {
      workspaceId: WS_B,
      trackId: TRACK,
      status: 'running',
      streamChunk: 'reviewing…'
    })
    assert.equal(patch, null, 'workspace B progress must not touch workspace A state')
  })

  test('a result from another workspace is refused', () => {
    const patch = applyDesignResult(state(), {
      ...result({ status: 'completed', score: 71, findings: [finding] }),
      workspaceId: WS_B
    })
    assert.equal(patch, null, 'B findings must not be written into A’s run')
  })

  test('intermediate findings from another workspace are refused', () => {
    const patch = applyDesignIntermediate(state(), {
      workspaceId: WS_B,
      trackId: TRACK,
      findings: [finding],
      coverageStats: coverage,
      roundNumber: 1,
      totalRounds: 3,
      totalFiles: 10,
      batchSize: 4
    })
    assert.equal(patch, null)
  })
})

// ── §2: progress ─────────────────────────────────────────────────────────────

describe('applyDesignProgress', () => {
  test('appends stream text and advances the matching result status', () => {
    const patch = applyDesignProgress(state(), {
      workspaceId: WS_A,
      trackId: TRACK,
      status: 'running',
      streamChunk: 'hello '
    })
    assert.ok(patch)
    assert.equal(patch.liveStreamText?.[TRACK], 'hello ')
    assert.equal(patch.currentRun?.results[0].status, 'running')
  })

  test('accumulates successive chunks rather than replacing them', () => {
    const first = applyDesignProgress(state(), {
      workspaceId: WS_A,
      trackId: TRACK,
      status: 'running',
      streamChunk: 'a'
    })
    const second = applyDesignProgress(state({ liveStreamText: first!.liveStreamText! }), {
      workspaceId: WS_A,
      trackId: TRACK,
      status: 'running',
      streamChunk: 'b'
    })
    assert.equal(second?.liveStreamText?.[TRACK], 'ab')
  })

  test('still buffers stream text when no run is loaded yet', () => {
    // The row arrives from DESIGN_START asynchronously; text that lands first
    // must not be dropped on the floor.
    const patch = applyDesignProgress(state({ currentRun: null }), {
      workspaceId: WS_A,
      trackId: TRACK,
      status: 'running',
      streamChunk: 'early'
    })
    assert.ok(patch)
    assert.equal(patch.liveStreamText?.[TRACK], 'early')
    assert.equal(patch.currentRun, undefined, 'no run to patch')
  })

  test('leaves other tracks untouched', () => {
    const other = result({ id: 'res-2', trackId: 'design:audit', status: 'pending' })
    const patch = applyDesignProgress(state({ currentRun: run({ results: [result(), other] }) }), {
      workspaceId: WS_A,
      trackId: TRACK,
      status: 'completed'
    })
    assert.equal(patch?.currentRun?.results[1].status, 'pending')
  })
})

// ── §3: result ───────────────────────────────────────────────────────────────

describe('applyDesignResult', () => {
  test('replaces the row and strips the workspaceId tag', () => {
    const event: DesignResultEvent = {
      ...result({ status: 'completed', score: 82, findings: [finding], summary: 'done' }),
      workspaceId: WS_A
    }
    const patch = applyDesignResult(state(), event)
    assert.ok(patch)
    const stored = patch.currentRun?.results[0] as AuditResult & { workspaceId?: string }
    assert.equal(stored.score, 82)
    assert.equal(stored.findings.length, 1)
    assert.equal(
      stored.workspaceId,
      undefined,
      'the transport tag must not leak into the persisted AuditResult shape'
    )
  })

  test('clears the live stream buffer for that track only', () => {
    const patch = applyDesignResult(
      state({ liveStreamText: { [TRACK]: 'partial', 'design:audit': 'keep' } }),
      { ...result({ status: 'completed' }), workspaceId: WS_A }
    )
    assert.equal(patch?.liveStreamText?.[TRACK], undefined)
    assert.equal(patch?.liveStreamText?.['design:audit'], 'keep')
  })

  test('is a no-op when no run is loaded', () => {
    const patch = applyDesignResult(state({ currentRun: null }), {
      ...result(),
      workspaceId: WS_A
    })
    assert.equal(patch, null)
  })
})

// ── §4: intermediate findings ────────────────────────────────────────────────

describe('applyDesignIntermediate', () => {
  test('merges round findings and coverage into the running track', () => {
    const patch = applyDesignIntermediate(state(), {
      workspaceId: WS_A,
      trackId: TRACK,
      findings: [finding],
      coverageStats: coverage,
      roundNumber: 2,
      totalRounds: 3,
      totalFiles: 12,
      batchSize: 4
    })
    assert.ok(patch)
    const row = patch.currentRun?.results[0]
    assert.equal(row?.findings.length, 1)
    assert.equal(row?.coverageStats?.fileCount, 1)
    assert.equal(row?.roundProgress?.roundNumber, 2)
    assert.match(row?.summary ?? '', /Round 2\/3/)
  })

  test('is a no-op when no run is loaded', () => {
    const patch = applyDesignIntermediate(state({ currentRun: null }), {
      workspaceId: WS_A,
      trackId: TRACK,
      findings: [],
      coverageStats: coverage,
      roundNumber: 1,
      totalRounds: 1,
      totalFiles: 1,
      batchSize: 1
    })
    assert.equal(patch, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

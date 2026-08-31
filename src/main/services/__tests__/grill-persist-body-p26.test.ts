/**
 * Phase 26 Wave 3 — grill-persistence.controller.ts deep body coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. The previous version also guessed at an API that
 * doesn't exist (createSession/terminateStale/handleStreamChunk with a
 * single-object argument) — GrillPersistenceController has no such methods;
 * its real public surface is startTracking/handleStreamChunk(chunkData,
 * workspaceId, router)/handleComplete/getStatusForWorkspace/getSessionState/
 * clearTracking, exercised below against their real signatures.
 *
 * NOTE ON TEST ISOLATION: this harness's `test()` (see test-harness.ts)
 * starts every sibling test's beforeEach hook eagerly during the describe()
 * pass and only defers each test's *body* behind a microtask, so two
 * separate `test()` blocks that both `await` a method touching the same
 * mock repo spy can interleave their calls. Anything that shares
 * create/updateStatus/updateTrackId/appendMessages spies is therefore kept
 * in a single sequential test below rather than split across several.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  createSpy,
  resetAllMocks,
  evictFromCache
} from './setup-full-mock'
import { IPC_CHANNELS } from '../../../shared/constants'
setupFullMock()

// restoreFullMock()'s cache purge (see setup-full-mock.ts) evicts the
// mock-bound controller copy cached by earlier full-mock files; an
// intermediate file can then re-cache it bound to the REAL repositories,
// and the require below would hand back that copy — getMockRepo() would then
// configure an object the controller never reads (green standalone, red
// in-suite). Evict so this require re-binds to the mock installed above.
evictFromCache('grill-persistence.controller')
const mod = require('../grill-persistence.controller')
const { grillPersistenceController: controller } = mod
const grillRepo = getMockRepo('grillSession')

/** Minimal SessionEventRouter stub — handleStreamChunk/handleComplete only need sendWorkspaceEvent. */
function fakeRouter(): { sendWorkspaceEvent: any } {
  return { sendWorkspaceEvent: createSpy() }
}

describe('GrillPersistenceController (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('controller singleton exposes the real tracking API', () => {
    assert.ok(controller)
    assert.equal(typeof controller.startTracking, 'function')
    assert.equal(typeof controller.handleStreamChunk, 'function')
    assert.equal(typeof controller.handleComplete, 'function')
  })

  // ─── getStatusForWorkspace (isolated — only touches getActiveForWorkspace) ─
  test('getStatusForWorkspace maps the active session or returns null', () => {
    grillRepo.getActiveForWorkspace.mockReturnValue([])
    assert.equal(controller.getStatusForWorkspace('ws-none'), null)

    grillRepo.getActiveForWorkspace.mockReturnValue([
      { status: 'evaluating', ideaId: 'idea-1', trackId: 'problem', currentScore: null }
    ])
    assert.deepEqual(controller.getStatusForWorkspace('ws-1'), {
      status: 'evaluating',
      ideaId: 'idea-1',
      trackId: 'problem',
      score: null
    })
  })

  // ─── handleStreamChunk / handleComplete for an untracked workspace ───────
  // (only touches a per-test router spy — no shared grillRepo mutation spies)
  test('handleStreamChunk forwards a tool_activity chunk to the router immediately', () => {
    const router = fakeRouter()
    controller.handleStreamChunk(
      { type: 'tool_activity', toolActivity: { id: 't-1', name: 'Read' } },
      'ws-chunk-untracked',
      router
    )

    assert.equal(router.sendWorkspaceEvent.callCount, 1)
    assert.deepEqual(router.sendWorkspaceEvent.lastCall[0], IPC_CHANNELS.GRILL_STREAM_CHUNK)
    assert.equal(router.sendWorkspaceEvent.lastCall[1], 'ws-chunk-untracked')
  })

  test('handleComplete sends the stream-complete event even with nothing tracked', () => {
    const router = fakeRouter()
    controller.handleComplete('ws-complete-untracked', router)

    assert.equal(router.sendWorkspaceEvent.callCount, 1)
    assert.deepEqual(router.sendWorkspaceEvent.lastCall, [
      IPC_CHANNELS.GRILL_STREAM_COMPLETE,
      'ws-complete-untracked',
      {}
    ])
  })

  // ─── Full session lifecycle — merged into one sequential test because it's
  // the only test in this file that mutates create/updateStatus/updateTrackId/
  // appendMessages, avoiding any cross-test interleaving on those spies. ────
  test('startTracking → handleStreamChunk → handleComplete session lifecycle, and the reuse + no-op paths', async () => {
    // clearTracking on an untracked workspace must not touch the repo.
    const updateStatusBefore = grillRepo.updateStatus.callCount
    controller.clearTracking('ws-lifecycle-never-tracked')
    assert.equal(grillRepo.updateStatus.callCount, updateStatusBefore)

    // getSessionState delegates straight through to findByIdeaId.
    const existingState = { id: 'gs-state', ideaId: 'idea-state' }
    grillRepo.findByIdeaId.mockReturnValue(existingState)
    assert.equal(controller.getSessionState('idea-state'), existingState)

    // startTracking: no existing session → creates one and marks it evaluating.
    grillRepo.findByIdeaId.mockReturnValue(null)
    grillRepo.create.mockReturnValue({ id: 'gs-lifecycle' })
    const sessionId = await controller.startTracking('idea-lifecycle', 'ws-lifecycle', 'problem')
    assert.equal(sessionId, 'gs-lifecycle')
    assert.deepEqual(grillRepo.create.lastCall, ['idea-lifecycle', 'ws-lifecycle', 'problem'])
    assert.deepEqual(grillRepo.updateStatus.lastCall, ['gs-lifecycle', 'evaluating'])

    // Buffer an agent text chunk, then flush it to DB on stream complete.
    const router = fakeRouter()
    controller.handleStreamChunk(
      { type: 'text', content: 'hello from the agent' },
      'ws-lifecycle',
      router
    )
    controller.handleComplete('ws-lifecycle', router)
    assert.equal(grillRepo.appendMessages.callCount, 1)
    assert.equal(grillRepo.appendMessages.lastCall[0], 'gs-lifecycle')
    assert.equal(grillRepo.appendMessages.lastCall[1][0].content, 'hello from the agent')

    // handleComplete() must have cleared the workspace's tracking state.
    assert.equal(controller.getTrackingForWorkspace('ws-lifecycle'), null)

    // startTracking: an existing session for the idea is re-used, not re-created.
    grillRepo.findByIdeaId.mockReturnValue({ id: 'gs-existing' })
    const reusedId = await controller.startTracking('idea-reuse', 'ws-reuse', 'market')
    assert.equal(reusedId, 'gs-existing')
    assert.equal(grillRepo.create.callCount, 1) // unchanged from the earlier create — no second create
    assert.deepEqual(grillRepo.updateTrackId.lastCall, ['gs-existing', 'market'])
  })
})

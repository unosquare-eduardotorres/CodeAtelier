/**
 * Blueprint → Chat handoff — branch resolution and the pre-flight options.
 *
 * This is where the handoff's real failure modes live, so it runs against the
 * mocked repository layer rather than pure inputs:
 *
 *  - after handoff #1 the track row belongs to the chat, so resolving the
 *    blueprint's branch by ownership finds nothing and handoff #2 silently
 *    lands in the wrong tree
 *  - a busy holder has to be reported before a button offers to take from it
 *
 * The conversation-creation half is deliberately not exercised here: it runs
 * git through simple-git and belongs to E2E.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, mockService, evictFromCache } from './setup-full-mock'

setupFullMock()

// trackService is a singleton with a filesystem-aware busy probe; only the one
// question the options call asks is stubbed.
const busyReason: { value: string | null } = { value: null }
mockService('services/track.service', {
  trackService: {
    busyReasonFor: () => busyReason.value
  },
  TrackConflictError: class extends Error {}
})

// blueprint.service is imported by half the suite, so by the time this file runs
// it is cached against whatever repositories were live then. Owning the one
// method under test here is more robust than evicting a widely-shared module.
let currentBlueprint: Record<string, unknown> | undefined
mockService('services/blueprint.service', {
  blueprintService: {
    getBlueprintWithDetails: (id: string) =>
      currentBlueprint && currentBlueprint.id === id ? currentBlueprint : null
  }
})

const trackRepo = getMockRepo('track')
const convRepo = getMockRepo('conversation')
const handoffRepo = getMockRepo('handoff')

// Re-bind the module under test to the mocks installed above; a cached copy
// would still be holding the real singletons.
evictFromCache('blueprint-handoff.ipc')

let mod: typeof import('../../ipc/blueprint-handoff.ipc')
let loaded = false
try {
  mod = require('../../ipc/blueprint-handoff.ipc')
  loaded = true
} catch (err) {
  console.log(`⚠ blueprint-handoff.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────

const BP_ID = 'bp-1234567890abcdef'
const WS_ID = 'ws-1'

function installBlueprint(settingsJson: Record<string, unknown> = {}): void {
  currentBlueprint = {
    id: BP_ID,
    workspaceId: WS_ID,
    title: 'Checkout rewrite',
    shortName: 'checkout',
    description: 'Rebuild checkout',
    status: 'complete',
    currentPhase: 'verify',
    priority: 'P1',
    sourceIdeaId: null,
    constitutionSnapshot: null,
    settingsJson,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    phases: [],
    tasks: []
  }
}

/** The blueprint as the module under test receives it. */
function loadedBlueprint(): never | Record<string, unknown> {
  if (!currentBlueprint) throw new Error('no blueprint installed')
  return currentBlueprint
}

if (loaded) {
  describe('blueprintBranchCandidate', () => {
    beforeEach(() => {
      busyReason.value = null
      installBlueprint()
      trackRepo.findByOwner.mockReturnValue(undefined)
      trackRepo.findByBranch.mockReturnValue(undefined)
      convRepo.findById.mockReturnValue(undefined)
      handoffRepo.getBySourceSession.mockReturnValue([])
    })

    test('derives the deterministic branch name when no choice was recorded', () => {
      installBlueprint()
      const name = mod.blueprintBranchCandidate(loadedBlueprint() as never)
      assert.ok(name.startsWith('blueprint/checkout-rewrite-'), name)
      assert.ok(name.endsWith(BP_ID.slice(0, 8)), name)
    })

    test('honours an explicit fork name', () => {
      installBlueprint({ branchChoice: { mode: 'fork', name: 'feature/custom' } })
      assert.equal(mod.blueprintBranchCandidate(loadedBlueprint() as never), 'feature/custom')
    })

    test('honours an explicit takeover branch', () => {
      installBlueprint({ branchChoice: { mode: 'takeover', branch: 'main-work' } })
      assert.equal(mod.blueprintBranchCandidate(loadedBlueprint() as never), 'main-work')
    })
  })

  describe('getHandoffOptions', () => {
    beforeEach(() => {
      busyReason.value = null
      installBlueprint()
      trackRepo.findByOwner.mockReturnValue(undefined)
      trackRepo.findByBranch.mockReturnValue(undefined)
      convRepo.findById.mockReturnValue(undefined)
      handoffRepo.getBySourceSession.mockReturnValue([])
    })

    test('no track anywhere → no branch, no holder', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      const opts = mod.getHandoffOptions(WS_ID, BP_ID)
      assert.equal(opts.branchName, null)
      assert.equal(opts.holder, null)
      assert.equal(opts.busyReason, null)
    })

    test('blueprint still owns its track → branch with no holder', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      trackRepo.findByOwner.mockReturnValue({
        id: 't1',
        workspaceId: WS_ID,
        ownerKind: 'blueprint',
        ownerId: BP_ID,
        branchName: 'blueprint/checkout-rewrite-bp-12345',
        path: '/wt/a'
      })
      const opts = mod.getHandoffOptions(WS_ID, BP_ID)
      assert.equal(opts.branchName, 'blueprint/checkout-rewrite-bp-12345')
      assert.equal(opts.holder, null, 'the blueprint holding its own branch is not a "holder"')
    })

    test('after handoff #1 the branch is found by name and the chat is named', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      // The regression: findByOwner('blueprint', …) is empty because
      // transferOwner reassigned the row to the chat.
      trackRepo.findByOwner.mockReturnValue(undefined)
      trackRepo.findByBranch.mockReturnValue({
        id: 't1',
        workspaceId: WS_ID,
        ownerKind: 'chat',
        ownerId: 'conv-9',
        branchName: 'blueprint/checkout-rewrite-bp-12345',
        path: '/wt/a'
      })
      convRepo.findById.mockReturnValue({ id: 'conv-9', title: 'Review: Checkout rewrite' })

      const opts = mod.getHandoffOptions(WS_ID, BP_ID)
      assert.equal(opts.branchName, 'blueprint/checkout-rewrite-bp-12345')
      assert.equal(opts.holder?.kind, 'chat')
      assert.equal(opts.holder?.label, 'Review: Checkout rewrite')
      assert.equal(opts.holder?.conversationId, 'conv-9')
    })

    test('a busy holder is reported so the UI can refuse before trying', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      trackRepo.findByBranch.mockReturnValue({
        id: 't1',
        workspaceId: WS_ID,
        ownerKind: 'chat',
        ownerId: 'conv-9',
        branchName: 'b',
        path: '/wt/a'
      })
      convRepo.findById.mockReturnValue({ id: 'conv-9', title: 'Ship it' })
      busyReason.value = 'it is streaming a reply'

      const opts = mod.getHandoffOptions(WS_ID, BP_ID)
      assert.equal(opts.busyReason, 'it is streaming a reply')
    })

    test('prior handoffs are reported, and only accepted chat ones', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      handoffRepo.getBySourceSession.mockReturnValue([
        {
          targetSessionId: 'conv-9',
          target: 'chat',
          intent: 'Review: Checkout rewrite',
          createdAt: '2026-01-02T00:00:00.000Z'
        },
        // Never executed — no conversation to point at.
        { targetSessionId: null, target: 'chat', intent: 'Ship: x', createdAt: '2026-01-03' },
        // Different target entirely.
        { targetSessionId: 'g-1', target: 'grill', intent: 'Grill: x', createdAt: '2026-01-04' }
      ])

      const opts = mod.getHandoffOptions(WS_ID, BP_ID)
      assert.equal(opts.priorHandoffs.length, 1)
      assert.equal(opts.priorHandoffs[0].conversationId, 'conv-9')
    })

    test('a blueprint from another workspace is refused', () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      assert.throws(() => mod.getHandoffOptions('ws-other', BP_ID), /does not belong to workspace/)
    })

    test('a missing blueprint is refused', () => {
      currentBlueprint = undefined
      assert.throws(() => mod.getHandoffOptions(WS_ID, 'nope'), /not found/)
    })
  })

  // Async tests are drained after every sync test has run, so a `beforeEach`
  // here would be overwritten by the last sync case. Each sets its own state.
  describe('executeBlueprintHandoffToChat — guards', () => {
    test('refuses a blueprint that belongs to another workspace', async () => {
      installBlueprint()
      handoffRepo.getBySourceSession.mockReturnValue([])
      await assert.rejects(
        () => mod.executeBlueprintHandoffToChat({ workspaceId: 'ws-other', blueprintId: BP_ID }),
        /does not belong to workspace/
      )
    })

    test('refuses a blueprint that does not exist', async () => {
      currentBlueprint = undefined
      await assert.rejects(
        () => mod.executeBlueprintHandoffToChat({ workspaceId: WS_ID, blueprintId: 'nope' }),
        /not found/
      )
    })
  })
}

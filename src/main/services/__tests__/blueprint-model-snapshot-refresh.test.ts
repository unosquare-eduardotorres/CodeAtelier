/**
 * MODEL-SNAPSHOT-REFRESH — per-phase refresh of the frozen modelSnapshot at
 * phase (re)start.
 *
 * The snapshot is frozen once at blueprint.service.create() and survived
 * cancel() untouched, so a blueprint created with a GLM build binding kept
 * running GLM forever after the workspace was rebound to Claude. The fix:
 * BlueprintService.refreshModelSnapshotForPhase() re-resolves the phase's
 * entries against the CURRENT workspace binding as the first statement of
 * every start*Phase, replacing WHOLE entries (provider + modelId together —
 * the agreement pinned by blueprint-provider-model-attribution.test.ts).
 *
 * Properties pinned here:
 *   1. the user scenario — GLM-frozen build, live rebind to Claude, refresh,
 *      then blueprintSnapshotAssignment agrees on provider AND model
 *   2. completed phases stay frozen (what ran stays recorded)
 *   3. build refresh also refreshes the escalation ladder (leadReview +
 *      peerReview) so rungs stay in agreement with the rung they escalate from
 *   4. no-change is a no-op — no DB write, no refreshHistory spam
 *   5. refreshHistory accumulates across refreshes; lastRefreshAt is set
 *   6. a legacy row with no modelSnapshot gets the full 10-key snapshot
 *   7. the journal gets a system event (event: 'modelSnapshotRefresh')
 *   8. missing blueprint / unknown phase → null, never a throw
 *
 * Run: tsx src/main/services/__tests__/blueprint-model-snapshot-refresh.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupFullMock, getMockRepo, evictFromCache, mockService, unmockService } from './setup-full-mock'

setupFullMock()

// Control the model-resolution layer directly via mockService() instead of
// relying on cache eviction of model-config.service: in a shared run that
// module may be cached as an ESM binding from an earlier file, and evicting
// the CJS entry re-requires it into a broken interop shape (buildResolveOpts
// not a function). Intercepting the module during this file's require window
// is deterministic regardless of loader-cache state.
const liveBindings: { modelRoles: Record<string, { provider: string; modelId: string }> } = {
  modelRoles: {}
}
const mockModelConfig = {
  resolveAssignment: (opts: { action: string; modelRoles?: Record<string, { provider: string; modelId: string }> }) => {
    const role = opts?.modelRoles?.[opts.action]
    if (role) return { provider: role.provider, modelId: role.modelId, source: 'roles' }
    return { provider: 'claude', modelId: 'claude-default-fallback', source: 'default' }
  },
  buildResolveOpts: () => ({
    modelRoles: liveBindings.modelRoles,
    modelOverrides: undefined,
    workspaceProvider: 'claude',
    workspaceBackend: undefined
  }),
  modelConfigService: { getModel: () => 'claude-default-fallback' }
}
mockService('model-config.service', mockModelConfig)

// Re-bind the service under test and the resolution-layer reader to the mocks
// — an earlier file in the shared run may have cached them against pre-mock
// repositories.
evictFromCache('blueprint.service')
evictFromCache('snapshot-model-resolver')
const { blueprintService } = require('../blueprint.service')
const { blueprintSnapshotAssignment } = require('../snapshot-model-resolver')
// serviceMocks is process-global and survives restoreFullMock() — unregister
// so this stub cannot hijack a later file's model-config imports.
unmockService('model-config.service')

const bpRepo = getMockRepo('blueprint')
const phaseRepo = getMockRepo('blueprintPhase')
const eventRepo = getMockRepo('blueprintEvent')

const BP_ID = '1f2e3d4c5b6a798801122334455667788' // 32 hex chars
const WS_ID = 'ws-refresh-1'

// ── Fixtures ─────────────────────────────────────────────────────────────────

type Entry = { provider: string; modelId: string; source: string; disabled?: boolean }

const glm = (modelId = 'glm-5.3'): Entry => ({ provider: 'glm', modelId, source: 'roles' })
const claude = (modelId = 'claude-opus-4-7'): Entry => ({
  provider: 'claude',
  modelId,
  source: 'roles'
})

/** A frozen-at-create() snapshot: 10 keys, all on one provider. */
function frozenSnapshot(withOverrides: Record<string, Entry> = {}): Record<string, unknown> {
  const base: Record<string, Entry> = {
    specify: glm(),
    clarify: glm(),
    plan: glm(),
    tasks: glm(),
    review: glm(),
    build: glm(),
    codeReview: { provider: 'claude', modelId: 'claude-sonnet-4-6', source: 'roles' },
    leadReview: glm(),
    peerReview: glm(),
    verify: glm()
  }
  return { ...base, ...withOverrides, snapshotAt: '2026-09-01T00:00:00.000Z' }
}

/**
 * Stateful store: what update() writes becomes what findById() returns —
 * the same round-trip the real better-sqlite3 row would take.
 */
function installStatefulBlueprint(initialSettings: Record<string, unknown>): void {
  const store = new Map<string, Record<string, unknown>>([
    [BP_ID, { id: BP_ID, workspaceId: WS_ID, title: 'T', status: 'building', settingsJson: initialSettings }]
  ])
  bpRepo.findById.mockImplementation((id: string) => store.get(id))
  bpRepo.update.mockImplementation((id: string, data: { settingsJson?: Record<string, unknown> }) => {
    const row = store.get(id)
    if (!row) return undefined
    if (data.settingsJson) row.settingsJson = data.settingsJson
    return row
  })
}

/** Point the live workspace binding at a modelRoles map. */
function bindLive(roles: Record<string, { provider: string; modelId: string }>): void {
  liveBindings.modelRoles = roles
}

/** Phase rows for the complete-check. */
function installPhases(rows: Array<{ phase: string; status: string }>): void {
  phaseRepo.findByBlueprint.mockReturnValue(
    rows.map((r, i) => ({ id: `ph-${i}`, blueprintId: BP_ID, ...r }))
  )
}

function allPending(): Array<{ phase: string; status: string }> {
  return ['specify', 'clarify', 'plan', 'tasks', 'review', 'code-review', 'build', 'verify'].map(
    (phase) => ({ phase, status: 'pending' })
  )
}

/** The snapshot currently persisted for the blueprint (stateful store round-trip). */
function persistedSnapshot(): Record<string, any> {
  const row = bpRepo.findById(BP_ID) as { settingsJson?: Record<string, any> } | undefined
  return (row?.settingsJson ?? {}).modelSnapshot ?? {}
}

function resetSpies(): void {
  bpRepo.findById.mockReset()
  bpRepo.update.mockReset()
  phaseRepo.findByBlueprint.mockReset()
  eventRepo.append.mockReset()
  liveBindings.modelRoles = {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('refreshModelSnapshotForPhase', () => {
  test('1. USER SCENARIO: GLM-frozen build refreshes to the live Claude binding, provider AND model agreeing', () => {
    resetSpies()
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    installPhases(allPending())
    // Workspace rebound: everything runs on Claude now.
    bindLive({
      'blueprint:build': { provider: 'claude', modelId: 'claude-opus-4-7' }
    })

    const result = blueprintService.refreshModelSnapshotForPhase(BP_ID, 'build')

    assert.ok(result, 'refresh should return a result object')
    assert.deepEqual(result.changed.sort(), ['build', 'leadReview', 'peerReview'])

    // The resolution layer every dispatch uses must now return the live pair.
    const assignment = blueprintSnapshotAssignment(BP_ID, 'blueprint:build')
    assert.ok(assignment, 'blueprintSnapshotAssignment should resolve after refresh')
    assert.equal(assignment.provider, 'claude')
    assert.equal(assignment.modelId, 'claude-opus-4-7')
    // Both come from ONE refreshed entry — the agreement the attribution suite pins.
    assert.equal(assignment.provider, persistedSnapshot().build.provider)
    assert.equal(assignment.modelId, persistedSnapshot().build.modelId)
  })

  test('2. completed phases stay frozen — what ran stays recorded', () => {
    resetSpies()
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    installPhases(allPending().map((p) => (p.phase === 'verify' ? { ...p, status: 'complete' } : p)))
    bindLive({
      'blueprint:verify': { provider: 'claude', modelId: 'claude-opus-4-7' }
    })

    const result = blueprintService.refreshModelSnapshotForPhase(BP_ID, 'verify')

    assert.deepEqual(result, { refreshed: [], changed: [] })
    assert.equal(bpRepo.update.callCount, 0, 'no DB write for a complete phase')
    assert.equal(persistedSnapshot().verify.modelId, 'glm-5.3', 'verify entry stays frozen')
  })

  test('3. build refresh also refreshes the escalation ladder (leadReview + peerReview)', () => {
    resetSpies()
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    installPhases(allPending())
    bindLive({
      'blueprint:build': { provider: 'claude', modelId: 'claude-opus-4-7' },
      'blueprint:lead-review': { provider: 'claude', modelId: 'claude-opus-4-7' },
      'blueprint:peer-review': { provider: 'claude', modelId: 'claude-opus-4-7' }
    })

    blueprintService.refreshModelSnapshotForPhase(BP_ID, 'build')

    const snap = persistedSnapshot()
    for (const key of ['build', 'leadReview', 'peerReview']) {
      assert.equal(snap[key].provider, 'claude', `${key} provider should refresh`)
      assert.equal(snap[key].modelId, 'claude-opus-4-7', `${key} model should refresh`)
    }
    // A phase that was NOT part of this refresh stays frozen.
    assert.equal(snap.plan.modelId, 'glm-5.3', 'plan entry must stay frozen on a build refresh')
  })

  test('4. no-change is a no-op — no DB write, no history spam', () => {
    resetSpies()
    // Frozen build already equals the live binding.
    installStatefulBlueprint({
      modelSnapshot: frozenSnapshot({
        build: claude(),
        leadReview: claude(),
        peerReview: claude()
      })
    })
    installPhases(allPending())
    bindLive({
      'blueprint:build': { provider: 'claude', modelId: 'claude-opus-4-7' },
      'blueprint:lead-review': { provider: 'claude', modelId: 'claude-opus-4-7' },
      'blueprint:peer-review': { provider: 'claude', modelId: 'claude-opus-4-7' }
    })

    const result = blueprintService.refreshModelSnapshotForPhase(BP_ID, 'build')

    assert.deepEqual(result, { refreshed: [], changed: [] })
    assert.equal(bpRepo.update.callCount, 0, 'no write when nothing changed')
    assert.equal(persistedSnapshot().refreshHistory, undefined, 'no history entry for a no-op')
  })

  test('5. refreshHistory accumulates across two refreshes; lastRefreshAt is set', () => {
    resetSpies()
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    installPhases(allPending())

    // Use the single-key `plan` phase so exactly one history entry is written
    // per refresh (the build phase would also diff the ladder keys).
    bindLive({ 'blueprint:plan': { provider: 'claude', modelId: 'claude-opus-4-7' } })
    blueprintService.refreshModelSnapshotForPhase(BP_ID, 'plan')

    bindLive({ 'blueprint:plan': { provider: 'claude', modelId: 'claude-sonnet-4-6' } })
    blueprintService.refreshModelSnapshotForPhase(BP_ID, 'plan')

    const snap = persistedSnapshot()
    assert.ok(Array.isArray(snap.refreshHistory), 'refreshHistory should be an array')
    assert.equal(snap.refreshHistory.length, 2, 'history accumulates')
    assert.equal(snap.refreshHistory[0].key, 'plan')
    assert.equal(snap.refreshHistory[0].from.modelId, 'glm-5.3')
    assert.equal(snap.refreshHistory[0].from.provider, 'glm')
    assert.equal(snap.refreshHistory[0].to.modelId, 'claude-opus-4-7')
    assert.equal(snap.refreshHistory[1].from.modelId, 'claude-opus-4-7')
    assert.equal(snap.refreshHistory[1].to.modelId, 'claude-sonnet-4-6')
    assert.ok(snap.refreshHistory[1].at, 'each entry carries a timestamp')
    assert.ok(snap.lastRefreshAt, 'lastRefreshAt must be set')
  })

  test('6. legacy row without modelSnapshot gets the full 10-key snapshot on first refresh', () => {
    resetSpies()
    installStatefulBlueprint({ grillDecisions: [] }) // no modelSnapshot at all
    installPhases(allPending())
    bindLive({ 'blueprint:plan': { provider: 'claude', modelId: 'claude-opus-4-7' } })

    const result = blueprintService.refreshModelSnapshotForPhase(BP_ID, 'plan')

    // Healing alone is a write, even when the per-phase diff is empty.
    assert.ok(bpRepo.update.callCount >= 1, 'healed snapshot must be persisted')
    const snap = persistedSnapshot()
    const expectedKeys = [
      'specify',
      'clarify',
      'plan',
      'tasks',
      'review',
      'build',
      'codeReview',
      'leadReview',
      'peerReview',
      'verify'
    ]
    for (const key of expectedKeys) {
      assert.ok(snap[key], `healed snapshot must include ${key}`)
      assert.equal(snap[key].provider, 'claude', `${key} heals to the live provider`)
    }
    assert.ok(snap.snapshotAt, 'healed snapshot carries snapshotAt')
    assert.ok(result, 'refresh should succeed on a legacy row')
  })

  test('7. journal event appended with event: modelSnapshotRefresh', () => {
    resetSpies()
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    installPhases(allPending())
    bindLive({ 'blueprint:build': { provider: 'claude', modelId: 'claude-opus-4-7' } })

    blueprintService.refreshModelSnapshotForPhase(BP_ID, 'build')

    assert.ok(eventRepo.append.callCount >= 1, 'journal append must be attempted')
    const [id, type, payload] = eventRepo.append.calls[0]
    assert.equal(id, BP_ID)
    assert.equal(type, 'system')
    assert.equal(payload.event, 'modelSnapshotRefresh')
    assert.ok(
      String(payload.message).includes('build'),
      'message names the phase being refreshed'
    )
    assert.ok(
      String(payload.message).includes('glm-5.3'),
      'message shows the from-model'
    )
    assert.ok(
      String(payload.message).includes('claude-opus-4-7'),
      'message shows the to-model'
    )
  })

  test('8. missing blueprint / unknown phase → null, no throw', () => {
    resetSpies()
    // Missing blueprint: findById returns undefined by default after reset.
    assert.equal(blueprintService.refreshModelSnapshotForPhase('nope', 'build'), null)

    // Unknown phase: blueprint exists, phase name is garbage.
    installStatefulBlueprint({ modelSnapshot: frozenSnapshot() })
    assert.equal(blueprintService.refreshModelSnapshotForPhase(BP_ID, 'execute'), null)
    assert.equal(bpRepo.update.callCount, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

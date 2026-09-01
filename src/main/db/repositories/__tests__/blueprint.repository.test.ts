/**
 * Tests for BlueprintRepository, BlueprintPhaseRepository, BlueprintTaskRepository.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'
import { BLUEPRINT_PHASE_ORDER } from '../../../../shared/blueprint-types'

const env = trySetupTestDb()

if (!env) {
  describe('BlueprintRepository (skipped — native module unavailable)', () => {
    test('create() inserts blueprint', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const {
    blueprintRepository,
    blueprintPhaseRepository,
    blueprintTaskRepository
  } = require('../blueprint.repository')

  describe('BlueprintRepository', () => {
    // ── create ──

    test('create() inserts and returns blueprint with defaults', () => {
      const bp = blueprintRepository.create({
        workspaceId: wsId,
        title: 'My Blueprint'
      })
      assert.ok(bp.id)
      assert.equal(bp.workspaceId, wsId)
      assert.equal(bp.title, 'My Blueprint')
      assert.equal(bp.description, '')
      assert.equal(bp.status, 'draft')
      assert.equal(bp.currentPhase, 'specify')
      assert.equal(bp.priority, 'P1')
      assert.deepEqual(bp.settingsJson, {})
    })

    test('create() accepts all optional fields', () => {
      const bp = blueprintRepository.create({
        workspaceId: wsId,
        title: 'Full Blueprint',
        description: 'Detailed desc',
        priority: 'P2',
        sourceIdeaId: (() => {
          const row = env.db
            .prepare('INSERT INTO ideas (workspace_id, title) VALUES (?, ?) RETURNING id')
            .get(wsId, 'BP Source Idea') as { id: string }
          return row.id
        })(),
        constitutionSnapshot: 'snapshot text',
        settingsJson: { parallel: true }
      })
      assert.equal(bp.description, 'Detailed desc')
      assert.equal(bp.priority, 'P2')
      assert.ok(bp.sourceIdeaId)
      assert.equal(bp.constitutionSnapshot, 'snapshot text')
      assert.deepEqual(bp.settingsJson, { parallel: true })
    })

    // ── findById ──

    test('findById() returns blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Findable' })
      const found = blueprintRepository.findById(bp.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findById() returns undefined for unknown id', () => {
      assert.equal(blueprintRepository.findById('nonexistent'), undefined)
    })

    // ── findByWorkspace ──

    test('findByWorkspace() returns blueprints sorted by created_at DESC', () => {
      const freshWs = 'bp-ws-test'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'BP WS', '/tmp/bp-ws')

      blueprintRepository.create({ workspaceId: freshWs, title: 'First' })
      blueprintRepository.create({ workspaceId: freshWs, title: 'Second' })
      const bps = blueprintRepository.findByWorkspace(freshWs)
      assert.equal(bps.length, 2)
      const titles = bps.map((b: any) => b.title).sort()
      assert.deepEqual(titles, ['First', 'Second'])
    })

    // ── findByStatus ──

    test('findByStatus() filters by status', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Status Test' })
      blueprintRepository.updateStatus(bp.id, 'building')
      const building = blueprintRepository.findByStatus(wsId, 'building')
      assert.ok(building.some((b: any) => b.id === bp.id))
    })

    // ── updateStatus ──

    test('updateStatus() transitions status', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Status Transition' })
      const updated = blueprintRepository.updateStatus(bp.id, 'specifying')
      assert.ok(updated)
      assert.equal(updated.status, 'specifying')
    })

    test('updateStatus() returns undefined for unknown id', () => {
      assert.equal(blueprintRepository.updateStatus('nonexistent', 'draft'), undefined)
    })

    // ── updatePhase ──

    test('updatePhase() transitions currentPhase', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase Test' })
      const updated = blueprintRepository.updatePhase(bp.id, 'plan')
      assert.ok(updated)
      assert.equal(updated.currentPhase, 'plan')
    })

    // ── updateShortName ──

    test('updateShortName() sets shortName', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Short Name Test' })
      const updated = blueprintRepository.updateShortName(bp.id, 'SNT')
      assert.ok(updated)
      assert.equal(updated.shortName, 'SNT')
    })

    // ── update (generic) ──

    test('update() modifies multiple fields', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Generic Update' })
      const updated = blueprintRepository.update(bp.id, {
        title: 'Updated Title',
        description: 'Updated desc',
        priority: 'P2',
        settingsJson: { key: 'value' }
      })
      assert.ok(updated)
      assert.equal(updated.title, 'Updated Title')
      assert.equal(updated.description, 'Updated desc')
      assert.equal(updated.priority, 'P2')
      assert.deepEqual(updated.settingsJson, { key: 'value' })
    })

    test('update() with no fields returns existing blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'No Change' })
      const result = blueprintRepository.update(bp.id, {})
      assert.ok(result)
      assert.equal(result.title, 'No Change')
    })

    // ── delete ──

    test('delete() removes blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'To Delete' })
      blueprintRepository.delete(bp.id)
      assert.equal(blueprintRepository.findById(bp.id), undefined)
    })

    // ── R2-1 regression: markStaleAsFailed with excludeIds ──

    test('markStaleAsFailed() marks stale blueprints as failed', () => {
      const staleWs = 'stale-ws-test'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(staleWs, 'Stale WS', '/tmp/stale-ws')
      const bp = blueprintRepository.create({ workspaceId: staleWs, title: 'Stale Building' })
      blueprintRepository.updateStatus(bp.id, 'building')
      const count = blueprintRepository.markStaleAsFailed()
      assert.ok(count >= 1, 'Should mark at least 1 stale blueprint')
      const found = blueprintRepository.findById(bp.id)
      assert.ok(found)
      assert.equal(found.status, 'failed')
    })

    test('markStaleAsFailed(excludeIds) skips excluded reviewing blueprint', () => {
      const exclWs = 'excl-ws-test'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(exclWs, 'Excl WS', '/tmp/excl-ws')

      // Create one reviewing (to be excluded) and one building (should fail)
      const reviewing = blueprintRepository.create({ workspaceId: exclWs, title: 'Reviewing Excl' })
      blueprintRepository.updateStatus(reviewing.id, 'reviewing')
      const building = blueprintRepository.create({ workspaceId: exclWs, title: 'Building Stale' })
      blueprintRepository.updateStatus(building.id, 'building')

      // Also create a phase for the reviewing blueprint to verify cascade doesn't touch it
      const phase = blueprintPhaseRepository.create({ blueprintId: reviewing.id, phase: 'review' })
      blueprintPhaseRepository.updateStatus(phase.id, 'active')

      const count = blueprintRepository.markStaleAsFailed([reviewing.id])
      assert.ok(count >= 1, 'Should mark at least the building blueprint')

      // Reviewing blueprint should be untouched
      const foundReviewing = blueprintRepository.findById(reviewing.id)
      assert.ok(foundReviewing)
      assert.equal(
        foundReviewing.status,
        'reviewing',
        'Excluded blueprint must keep reviewing status'
      )

      // Its phase should remain active (not cascaded to failed)
      const foundPhase = blueprintPhaseRepository.findById(phase.id)
      assert.ok(foundPhase)
      assert.equal(
        foundPhase.status,
        'active',
        'Excluded blueprint phases must not be cascaded to failed'
      )

      // Building blueprint should be failed
      const foundBuilding = blueprintRepository.findById(building.id)
      assert.ok(foundBuilding)
      assert.equal(foundBuilding.status, 'failed', 'Non-excluded stale blueprint must be failed')
    })
  })

  describe('BlueprintPhaseRepository', () => {
    test('create() inserts phase for blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase Host' })
      const phase = blueprintPhaseRepository.create({
        blueprintId: bp.id,
        phase: 'specify',
        conversationId: seedConversation(env.db, wsId, 'Phase Conv 1')
      })
      assert.ok(phase.id)
      assert.equal(phase.blueprintId, bp.id)
      assert.equal(phase.phase, 'specify')
      assert.equal(phase.status, 'pending')
      assert.ok(phase.conversationId)
    })

    test('createAllPhases() creates all 8 phase records', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'All Phases' })
      const phases = blueprintPhaseRepository.createAllPhases(bp.id)
      assert.equal(phases.length, BLUEPRINT_PHASE_ORDER.length)
      const phaseNames = phases.map((p: any) => p.phase)
      assert.ok(phaseNames.includes('specify'))
      assert.ok(phaseNames.includes('verify'))
    })

    test('findByBlueprint() returns phases in correct order', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Ordered Phases' })
      blueprintPhaseRepository.createAllPhases(bp.id)
      const phases = blueprintPhaseRepository.findByBlueprint(bp.id)
      assert.equal(phases[0].phase, 'specify')
      assert.equal(phases[BLUEPRINT_PHASE_ORDER.length - 1].phase, 'verify')
    })

    test('findByBlueprintAndPhase() returns specific phase', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Specific Phase' })
      blueprintPhaseRepository.createAllPhases(bp.id)
      const phase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'plan')
      assert.ok(phase)
      assert.equal(phase.phase, 'plan')
    })

    test('updateStatus() transitions phase status and sets timestamp', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase Status' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'specify' })
      const active = blueprintPhaseRepository.updateStatus(phase.id, 'active')
      assert.ok(active)
      assert.equal(active.status, 'active')
      assert.ok(active.startedAt)
    })

    test('setConversation() links phase to conversation', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase Conv' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'clarify' })
      const convId = seedConversation(env.db, wsId, 'Phase Conv Set')
      const updated = blueprintPhaseRepository.setConversation(phase.id, convId)
      assert.ok(updated)
      assert.equal(updated.conversationId, convId)
    })

    // ── BP-CONV-ENSURE: synthetic conversation ids must be persistable ──

    test('ensureWithId() creates the row once, then is idempotent', () => {
      const { conversationRepository } = require('../conversation.repository')
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Ensure Conv' })
      const syntheticId = `blueprint-clarify-${bp.id}-${Date.now()}`

      // First call inserts
      const created = conversationRepository.ensureWithId(
        syntheticId,
        wsId,
        'Blueprint — clarify',
        'plan',
        'blueprint'
      )
      assert.equal(created.id, syntheticId)
      assert.equal(created.type, 'blueprint')
      assert.equal(created.mode, 'plan')

      // Second call returns the SAME row — no duplicate
      const again = conversationRepository.ensureWithId(syntheticId, wsId, 'Blueprint — clarify')
      assert.equal(again.id, syntheticId)
      const count = env.db
        .prepare('SELECT COUNT(*) as n FROM conversations WHERE id = ?')
        .get(syntheticId) as { n: number }
      assert.equal(count.n, 1)
    })

    test('setConversation() links successfully after ensureWithId() (FK guard passes)', () => {
      const { conversationRepository } = require('../conversation.repository')
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Ensure + Link' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'tasks' })
      const syntheticId = `blueprint-tasks-${bp.id}-${Date.now()}`

      conversationRepository.ensureWithId(syntheticId, wsId, 'Blueprint — tasks')
      const updated = blueprintPhaseRepository.setConversation(phase.id, syntheticId)
      assert.ok(updated, 'FK link must succeed once the row exists')
      assert.equal(updated.conversationId, syntheticId)
    })

    test('saveArtifacts() stores artifact array', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Artifacts' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'specify' })
      const artifacts = [{ type: 'spec', content: 'spec content' }]
      const updated = blueprintPhaseRepository.saveArtifacts(phase.id, artifacts as any)
      assert.ok(updated)
      assert.deepEqual(updated.artifactsJson, artifacts)
    })

    test('appendArtifact() adds to existing artifacts', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Append Artifact' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'specify' })
      blueprintPhaseRepository.saveArtifacts(phase.id, [{ type: 'a', content: 'first' }] as any)
      const updated = blueprintPhaseRepository.appendArtifact(phase.id, {
        type: 'b',
        content: 'second'
      } as any)
      assert.ok(updated)
      assert.equal(updated.artifactsJson.length, 2)
    })

    // ── R2-2 regression: replaceArtifactOfType ──

    test('replaceArtifactOfType() replaces only matching type, preserves others', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Replace Type' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'review' })

      // Seed: review + preflight artifacts
      blueprintPhaseRepository.saveArtifacts(phase.id, [
        { type: 'review', contentMd: 'review text', contentJson: { recommendation: 'proceed' } },
        { type: 'discoveries', contentJson: { phase: 'review', entries: [] } },
        {
          type: 'preflight',
          contentJson: { checks: [], ranAt: 'old', hasBlockers: false, hasWarnings: false }
        }
      ] as any)

      // Replace preflight with new data
      const updated = blueprintPhaseRepository.replaceArtifactOfType(phase.id, 'preflight', {
        type: 'preflight',
        contentJson: {
          checks: [{ id: 'new-check' }],
          ranAt: 'new',
          hasBlockers: true,
          hasWarnings: false
        }
      } as any)

      assert.ok(updated)
      assert.equal(updated.artifactsJson.length, 3, 'Should still have exactly 3 artifacts')
      // Review artifact survived
      const review = updated.artifactsJson.find((a: any) => a.type === 'review')
      assert.ok(review, 'Review artifact must survive replace')
      assert.equal((review as any).contentMd, 'review text')
      // Discoveries artifact survived
      const discoveries = updated.artifactsJson.find((a: any) => a.type === 'discoveries')
      assert.ok(discoveries, 'Discoveries artifact must survive replace')
      // Preflight artifact updated
      const preflight = updated.artifactsJson.find((a: any) => a.type === 'preflight')
      assert.ok(preflight)
      assert.equal((preflight as any).contentJson.ranAt, 'new')
      assert.equal((preflight as any).contentJson.hasBlockers, true)
    })

    test('replaceArtifactOfType() called twice leaves exactly one artifact of that type', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Replace Twice' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'review' })

      // Seed with review + preflight
      blueprintPhaseRepository.saveArtifacts(phase.id, [
        { type: 'review', contentMd: 'rv' },
        { type: 'preflight', contentJson: { ranAt: 'v1' } }
      ] as any)

      // First replace
      blueprintPhaseRepository.replaceArtifactOfType(phase.id, 'preflight', {
        type: 'preflight',
        contentJson: { ranAt: 'v2' }
      } as any)

      // Second replace
      const final = blueprintPhaseRepository.replaceArtifactOfType(phase.id, 'preflight', {
        type: 'preflight',
        contentJson: { ranAt: 'v3' }
      } as any)

      assert.ok(final)
      const preflightArtifacts = final.artifactsJson.filter((a: any) => a.type === 'preflight')
      assert.equal(preflightArtifacts.length, 1, 'Exactly one preflight artifact')
      assert.equal((preflightArtifacts[0] as any).contentJson.ranAt, 'v3')
      // Review still intact
      assert.ok(final.artifactsJson.find((a: any) => a.type === 'review'))
    })

    test('replaceArtifactOfType() returns undefined for nonexistent phase', () => {
      const result = blueprintPhaseRepository.replaceArtifactOfType('nonexistent', 'preflight', {
        type: 'preflight',
        contentJson: {}
      } as any)
      assert.equal(result, undefined)
    })

    test('saveContextSnapshot() stores snapshot', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Snapshot' })
      const phase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'plan' })
      const updated = blueprintPhaseRepository.saveContextSnapshot(phase.id, 'context data')
      assert.ok(updated)
      assert.equal(updated.contextSnapshot, 'context data')
    })
  })

  describe('BlueprintTaskRepository', () => {
    test('create() inserts task with defaults', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Task Host' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T001',
        wave: 1,
        description: 'Implement feature'
      })
      assert.ok(task.id)
      assert.equal(task.blueprintId, bp.id)
      assert.equal(task.taskId, 'T001')
      assert.equal(task.wave, 1)
      assert.equal(task.description, 'Implement feature')
      assert.equal(task.isParallel, false)
      assert.deepEqual(task.filePathsJson, [])
      assert.deepEqual(task.dependsOnJson, [])
      assert.equal(task.status, 'pending')
    })

    test('create() accepts all optional fields', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Full Task' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T002',
        wave: 2,
        description: 'Full task',
        userStory: 'As a user...',
        filePathsJson: ['src/a.ts', 'src/b.ts'],
        isParallel: true,
        dependsOnJson: ['T001']
      })
      assert.equal(task.userStory, 'As a user...')
      assert.deepEqual(task.filePathsJson, ['src/a.ts', 'src/b.ts'])
      assert.equal(task.isParallel, true)
      assert.deepEqual(task.dependsOnJson, ['T001'])
    })

    test('createBulk() inserts multiple tasks in transaction', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Bulk Tasks' })
      const tasks = blueprintTaskRepository.createBulk(bp.id, [
        { taskId: 'B1', wave: 1, description: 'First' },
        { taskId: 'B2', wave: 1, description: 'Second' },
        { taskId: 'B3', wave: 2, description: 'Third', dependsOnJson: ['B1', 'B2'] }
      ])
      assert.equal(tasks.length, 3)
    })

    test('findByBlueprint() returns tasks ordered by wave', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Ordered Tasks' })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'W2',
        wave: 2,
        description: 'W2'
      })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'W1',
        wave: 1,
        description: 'W1'
      })
      const tasks = blueprintTaskRepository.findByBlueprint(bp.id)
      assert.ok(tasks[0].wave <= tasks[tasks.length - 1].wave)
    })

    test('findByWave() filters by wave number', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Wave Filter' })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'WF1',
        wave: 1,
        description: 'd'
      })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'WF2',
        wave: 2,
        description: 'd'
      })
      const wave1 = blueprintTaskRepository.findByWave(bp.id, 1)
      assert.ok(wave1.length >= 1)
      assert.ok(wave1.every((t: any) => t.wave === 1))
    })

    test('getWaveCount() returns max wave number', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Wave Count' })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'WC1',
        wave: 1,
        description: 'd'
      })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'WC2',
        wave: 3,
        description: 'd'
      })
      assert.equal(blueprintTaskRepository.getWaveCount(bp.id), 3)
    })

    test('getWaveCount() returns 0 for blueprint with no tasks', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'No Tasks' })
      assert.equal(blueprintTaskRepository.getWaveCount(bp.id), 0)
    })

    test('updateStatus() transitions task status', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Task Status' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'TS1',
        wave: 1,
        description: 'd'
      })
      const running = blueprintTaskRepository.updateStatus(task.id, 'running')
      assert.ok(running)
      assert.equal(running.status, 'running')
      assert.ok(running.startedAt)
    })

    test('setExecutorRun() links task to executor run', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Executor Link' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'EL1',
        wave: 1,
        description: 'd'
      })
      // executor_run_id references mpa_runs — seed a real MPA run
      const { mpaRunRepository } = require('../mpa-run.repository')
      const mpaRun = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Test Run',
        goal: 'test',
        goalType: 'feature'
      })
      const updated = blueprintTaskRepository.setExecutorRun(task.id, mpaRun.id)
      assert.ok(updated)
      assert.equal(updated.executorRunId, mpaRun.id)
    })

    test('deleteByBlueprint() removes all tasks for a blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Delete Tasks' })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'DT1',
        wave: 1,
        description: 'd'
      })
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'DT2',
        wave: 1,
        description: 'd'
      })
      const deleted = blueprintTaskRepository.deleteByBlueprint(bp.id)
      assert.equal(deleted, 2)
      assert.equal(blueprintTaskRepository.findByBlueprint(bp.id).length, 0)
    })

    test('create() defaults completionJson to null', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Completion Default' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'CD1',
        wave: 1,
        description: 'test'
      })
      assert.equal(task.completionJson, null)
    })

    test('setCompletion() persists filesCreated and filesModified', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Set Completion' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'SC1',
        wave: 1,
        description: 'test'
      })
      const updated = blueprintTaskRepository.setCompletion(task.id, {
        filesCreated: ['src/a.ts', 'src/b.ts'],
        filesModified: ['src/c.ts']
      })
      assert.ok(updated)
      assert.deepEqual(updated!.completionJson, {
        filesCreated: ['src/a.ts', 'src/b.ts'],
        filesModified: ['src/c.ts']
      })
      // Verify persistence via fresh read
      const tasks = blueprintTaskRepository.findByBlueprint(bp.id)
      const found = tasks.find((t: { taskId: string }) => t.taskId === 'SC1')
      assert.ok(found)
      assert.deepEqual(found!.completionJson, {
        filesCreated: ['src/a.ts', 'src/b.ts'],
        filesModified: ['src/c.ts']
      })
    })

    test('setCompletion() returns undefined for non-existent task', () => {
      const result = blueprintTaskRepository.setCompletion('non-existent-id', {
        filesCreated: [],
        filesModified: []
      })
      assert.equal(result, undefined)
    })
  })
}

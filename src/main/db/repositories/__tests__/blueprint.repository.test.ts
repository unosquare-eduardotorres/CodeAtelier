/**
 * Tests for BlueprintRepository, BlueprintPhaseRepository, BlueprintTaskRepository.
 * Three classes in one file — all tested together.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('BlueprintRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const {
    blueprintRepository,
    blueprintPhaseRepository,
    blueprintTaskRepository
  } = require('../blueprint.repository')

  // ── BlueprintRepository ──

  describe('BlueprintRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const bp = blueprintRepository.create({
        workspaceId: wsId,
        title: 'Auth System'
      })
      assert.ok(bp.id)
      assert.equal(bp.workspaceId, wsId)
      assert.equal(bp.title, 'Auth System')
      assert.equal(bp.description, '')
      assert.equal(bp.status, 'draft')
      assert.equal(bp.currentPhase, 'specify')
      assert.equal(bp.priority, 'P1')
      assert.equal(bp.sourceIdeaId, null)
      assert.deepEqual(bp.settingsJson, {})
    })

    test('create() accepts all optional fields', () => {
      const bp = blueprintRepository.create({
        workspaceId: wsId,
        title: 'Full Blueprint',
        description: 'A description',
        priority: 'P0',
        constitutionSnapshot: 'snapshot text',
        settingsJson: { autoApprove: true }
      })
      assert.equal(bp.description, 'A description')
      assert.equal(bp.priority, 'P0')
      assert.equal(bp.constitutionSnapshot, 'snapshot text')
      assert.deepEqual(bp.settingsJson, { autoApprove: true })
    })

    test('findById() round-trip', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Findable' })
      const found = blueprintRepository.findById(bp.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findByWorkspace() returns blueprints newest first', () => {
      const ws2 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-BP', '/tmp/bp') as { id: string }
        return row.id
      })()
      blueprintRepository.create({ workspaceId: ws2, title: 'First' })
      blueprintRepository.create({ workspaceId: ws2, title: 'Second' })
      const bps = blueprintRepository.findByWorkspace(ws2)
      assert.equal(bps.length, 2)
      assert.equal(bps[0].title, 'Second')
    })

    test('findByStatus() filters by status', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Status Test' })
      blueprintRepository.updateStatus(bp.id, 'active')
      const active = blueprintRepository.findByStatus(wsId, 'active')
      assert.ok(active.some((b: any) => b.id === bp.id))
    })

    test('updateStatus() changes status', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Status' })
      const updated = blueprintRepository.updateStatus(bp.id, 'completed')
      assert.ok(updated)
      assert.equal(updated.status, 'completed')
    })

    test('updatePhase() changes current phase', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase' })
      const updated = blueprintRepository.updatePhase(bp.id, 'plan')
      assert.ok(updated)
      assert.equal(updated.currentPhase, 'plan')
    })

    test('updateShortName() changes short name', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'ShortName' })
      const updated = blueprintRepository.updateShortName(bp.id, 'AUTH')
      assert.ok(updated)
      assert.equal(updated.shortName, 'AUTH')
    })

    test('update() handles multiple field updates', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Multi' })
      const updated = blueprintRepository.update(bp.id, {
        title: 'Updated',
        description: 'New desc',
        priority: 'P2',
        settingsJson: { key: 'val' }
      })
      assert.ok(updated)
      assert.equal(updated.title, 'Updated')
      assert.equal(updated.description, 'New desc')
      assert.equal(updated.priority, 'P2')
      assert.deepEqual(updated.settingsJson, { key: 'val' })
    })

    test('update() with empty data returns existing', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'NoOp' })
      const result = blueprintRepository.update(bp.id, {})
      assert.ok(result)
      assert.equal(result.title, 'NoOp')
    })

    test('delete() removes blueprint', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Delete Me' })
      blueprintRepository.delete(bp.id)
      assert.equal(blueprintRepository.findById(bp.id), undefined)
    })

    test('markStaleAsFailed() marks active phases as failed', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Stale' })
      blueprintRepository.updateStatus(bp.id, 'building')
      const count = blueprintRepository.markStaleAsFailed()
      assert.ok(count >= 1)
      const found = blueprintRepository.findById(bp.id)
      assert.equal(found!.status, 'failed')
    })
  })

  // ── BlueprintPhaseRepository ──

  describe('BlueprintPhaseRepository', () => {
    let bpId: string

    // Create a blueprint for phase tests
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Phase Tests' })
    bpId = bp.id

    test('create() creates a single phase', () => {
      const phase = blueprintPhaseRepository.create({
        blueprintId: bpId, phase: 'specify'
      })
      assert.ok(phase.id)
      assert.equal(phase.blueprintId, bpId)
      assert.equal(phase.phase, 'specify')
      assert.equal(phase.status, 'pending')
      assert.deepEqual(phase.artifactsJson, [])
    })

    test('createAllPhases() creates all 7 phases', () => {
      const bp2 = blueprintRepository.create({ workspaceId: wsId, title: 'All Phases' })
      const phases = blueprintPhaseRepository.createAllPhases(bp2.id)
      assert.equal(phases.length, 7)
      const phaseNames = phases.map((p: any) => p.phase)
      assert.ok(phaseNames.includes('specify'))
      assert.ok(phaseNames.includes('clarify'))
      assert.ok(phaseNames.includes('plan'))
      assert.ok(phaseNames.includes('tasks'))
      assert.ok(phaseNames.includes('review'))
      assert.ok(phaseNames.includes('build'))
      assert.ok(phaseNames.includes('verify'))
    })

    test('findByBlueprint() returns phases in order', () => {
      const bp3 = blueprintRepository.create({ workspaceId: wsId, title: 'Ordered' })
      blueprintPhaseRepository.createAllPhases(bp3.id)
      const phases = blueprintPhaseRepository.findByBlueprint(bp3.id)
      assert.equal(phases.length, 7)
      assert.equal(phases[0].phase, 'specify')
      assert.equal(phases[6].phase, 'verify')
    })

    test('findByBlueprintAndPhase() finds specific phase', () => {
      const bp4 = blueprintRepository.create({ workspaceId: wsId, title: 'ByPhase' })
      blueprintPhaseRepository.createAllPhases(bp4.id)
      const phase = blueprintPhaseRepository.findByBlueprintAndPhase(bp4.id, 'plan')
      assert.ok(phase)
      assert.equal(phase.phase, 'plan')
    })

    test('updateStatus() sets status + timestamps', () => {
      const bp5 = blueprintRepository.create({ workspaceId: wsId, title: 'StatusPhase' })
      const [phase] = blueprintPhaseRepository.createAllPhases(bp5.id)

      const active = blueprintPhaseRepository.updateStatus(phase.id, 'active')
      assert.equal(active!.status, 'active')
      assert.ok(active!.startedAt)

      const complete = blueprintPhaseRepository.updateStatus(phase.id, 'complete')
      assert.equal(complete!.status, 'complete')
      assert.ok(complete!.completedAt)
    })

    test('saveArtifacts() persists artifacts JSON', () => {
      const bp6 = blueprintRepository.create({ workspaceId: wsId, title: 'Artifacts' })
      const [phase] = blueprintPhaseRepository.createAllPhases(bp6.id)

      const artifacts = [{ type: 'spec', content: 'Spec content' }]
      const updated = blueprintPhaseRepository.saveArtifacts(phase.id, artifacts as any)
      assert.ok(updated)
      assert.equal(updated.artifactsJson.length, 1)
    })

    test('appendArtifact() adds to existing', () => {
      const bp7 = blueprintRepository.create({ workspaceId: wsId, title: 'Append' })
      const [phase] = blueprintPhaseRepository.createAllPhases(bp7.id)

      blueprintPhaseRepository.saveArtifacts(phase.id, [{ type: 'spec', content: 'v1' }] as any)
      const updated = blueprintPhaseRepository.appendArtifact(phase.id, { type: 'plan', content: 'v2' } as any)
      assert.ok(updated)
      assert.equal(updated.artifactsJson.length, 2)
    })

    test('saveContextSnapshot() persists snapshot', () => {
      const bp8 = blueprintRepository.create({ workspaceId: wsId, title: 'Snapshot' })
      const [phase] = blueprintPhaseRepository.createAllPhases(bp8.id)
      const updated = blueprintPhaseRepository.saveContextSnapshot(phase.id, 'context snapshot text')
      assert.ok(updated)
      assert.equal(updated.contextSnapshot, 'context snapshot text')
    })
  })

  // ── BlueprintTaskRepository ──

  describe('BlueprintTaskRepository', () => {
    let bpId: string

    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Task Tests' })
    bpId = bp.id

    test('create() returns mapped task with defaults', () => {
      const task = blueprintTaskRepository.create({
        blueprintId: bpId, taskId: 'T-001', wave: 1,
        description: 'Implement auth'
      })
      assert.ok(task.id)
      assert.equal(task.blueprintId, bpId)
      assert.equal(task.taskId, 'T-001')
      assert.equal(task.wave, 1)
      assert.equal(task.description, 'Implement auth')
      assert.equal(task.isParallel, false)
      assert.deepEqual(task.filePathsJson, [])
      assert.deepEqual(task.dependsOnJson, [])
      assert.equal(task.status, 'pending')
    })

    test('create() accepts all optional fields', () => {
      const task = blueprintTaskRepository.create({
        blueprintId: bpId, taskId: 'T-002', wave: 2,
        description: 'Add tests',
        userStory: 'As a dev, I want tests',
        filePathsJson: ['src/auth.ts', 'src/auth.test.ts'],
        isParallel: true,
        dependsOnJson: ['T-001']
      })
      assert.equal(task.userStory, 'As a dev, I want tests')
      assert.deepEqual(task.filePathsJson, ['src/auth.ts', 'src/auth.test.ts'])
      assert.equal(task.isParallel, true)
      assert.deepEqual(task.dependsOnJson, ['T-001'])
    })

    test('createBulk() inserts multiple tasks in transaction', () => {
      const bp2 = blueprintRepository.create({ workspaceId: wsId, title: 'Bulk Tasks' })
      const tasks = blueprintTaskRepository.createBulk(bp2.id, [
        { taskId: 'B-001', wave: 1, description: 'First' },
        { taskId: 'B-002', wave: 1, description: 'Second', isParallel: true },
        { taskId: 'B-003', wave: 2, description: 'Third', dependsOnJson: ['B-001', 'B-002'] }
      ])
      assert.equal(tasks.length, 3)
      assert.equal(tasks[2].dependsOnJson.length, 2)
    })

    test('findByBlueprint() returns tasks ordered by wave', () => {
      const tasks = blueprintTaskRepository.findByBlueprint(bpId)
      assert.ok(tasks.length >= 2)
      if (tasks.length >= 2) {
        assert.ok(tasks[0].wave <= tasks[1].wave)
      }
    })

    test('findByWave() filters by wave number', () => {
      const tasks = blueprintTaskRepository.findByWave(bpId, 1)
      assert.ok(tasks.every((t: any) => t.wave === 1))
    })

    test('getWaveCount() returns max wave', () => {
      const count = blueprintTaskRepository.getWaveCount(bpId)
      assert.ok(count >= 2)
    })

    test('updateStatus() sets status + timestamps', () => {
      const task = blueprintTaskRepository.create({
        blueprintId: bpId, taskId: 'T-003', wave: 1, description: 'Status test'
      })
      const running = blueprintTaskRepository.updateStatus(task.id, 'running')
      assert.equal(running!.status, 'running')
      assert.ok(running!.startedAt)

      const complete = blueprintTaskRepository.updateStatus(task.id, 'complete')
      assert.equal(complete!.status, 'complete')
      assert.ok(complete!.completedAt)
    })

    test('setExecutorRun() links executor run', () => {
      const task = blueprintTaskRepository.create({
        blueprintId: bpId, taskId: 'T-004', wave: 1, description: 'Executor test'
      })
      const updated = blueprintTaskRepository.setExecutorRun(task.id, 'exec-run-1')
      assert.ok(updated)
      assert.equal(updated.executorRunId, 'exec-run-1')
    })

    test('deleteByBlueprint() removes all tasks', () => {
      const bp3 = blueprintRepository.create({ workspaceId: wsId, title: 'Delete Tasks' })
      blueprintTaskRepository.createBulk(bp3.id, [
        { taskId: 'D-001', wave: 1, description: 'A' },
        { taskId: 'D-002', wave: 1, description: 'B' }
      ])
      const deleted = blueprintTaskRepository.deleteByBlueprint(bp3.id)
      assert.ok(deleted >= 2)
      assert.equal(blueprintTaskRepository.findByBlueprint(bp3.id).length, 0)
    })
  })
}

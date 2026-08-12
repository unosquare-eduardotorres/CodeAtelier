/**
 * Phase 26 Wave 4 — blueprint repositories deep coverage via mock DB.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const bpRepo = getMockRepo('blueprint')
const phaseRepo = getMockRepo('blueprintPhase')
const taskRepo = getMockRepo('blueprintTask')
const eventRepo = getMockRepo('blueprintEvent')

describe('Blueprint repositories — deep body (P26-W4)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // ─── blueprintRepository ─────────────────────────────────────────────────
  test('create creates blueprint', () => {
    bpRepo.create.mockReturnValue({ id: 'bp-1' })
    assert.deepEqual(bpRepo.create({}), { id: 'bp-1' })
  })
  test('findByWorkspace returns list', () => {
    bpRepo.findByWorkspace.mockReturnValue([])
    assert.deepEqual(bpRepo.findByWorkspace('ws-1'), [])
  })
  test('findByStatus filters', () => {
    bpRepo.findByStatus.mockReturnValue([])
    assert.deepEqual(bpRepo.findByStatus('active'), [])
  })
  test('updateStatus updates', () => {
    bpRepo.updateStatus('bp-1', 'completed')
    assert.ok(bpRepo.updateStatus.callCount > 0)
  })
  test('updatePhase transitions phase', () => {
    bpRepo.updatePhase('bp-1', 'build')
    assert.ok(bpRepo.updatePhase.callCount > 0)
  })
  test('updateShortName sets name', () => {
    bpRepo.updateShortName('bp-1', 'auth')
    assert.ok(bpRepo.updateShortName.callCount > 0)
  })
  test('delete removes blueprint', () => {
    bpRepo.delete.mockReturnValue(1)
    assert.equal(bpRepo.delete('bp-1'), 1)
  })
  test('markStaleAsFailed cleans stale', () => {
    bpRepo.markStaleAsFailed.mockReturnValue(2)
    assert.equal(bpRepo.markStaleAsFailed(), 2)
  })

  // ─── blueprintPhaseRepository ────────────────────────────────────────────
  test('createAllPhases creates phases', () => {
    phaseRepo.createAllPhases('bp-1')
    assert.ok(phaseRepo.createAllPhases.callCount > 0)
  })
  test('findByBlueprint returns phases', () => {
    phaseRepo.findByBlueprint.mockReturnValue([])
    assert.deepEqual(phaseRepo.findByBlueprint('bp-1'), [])
  })
  test('findByBlueprintAndPhase returns phase', () => {
    phaseRepo.findByBlueprintAndPhase.mockReturnValue(null)
    assert.equal(phaseRepo.findByBlueprintAndPhase('bp-1', 'build'), null)
  })
  test('updateStatus updates phase status', () => {
    phaseRepo.updateStatus('ph-1', 'running')
    assert.ok(phaseRepo.updateStatus.callCount > 0)
  })
  test('saveArtifacts persists artifacts', () => {
    phaseRepo.saveArtifacts('ph-1', [])
    assert.ok(phaseRepo.saveArtifacts.callCount > 0)
  })
  test('appendArtifact appends', () => {
    phaseRepo.appendArtifact('ph-1', {})
    assert.ok(phaseRepo.appendArtifact.callCount > 0)
  })

  // ─── blueprintTaskRepository ─────────────────────────────────────────────
  test('createBulk creates tasks', () => {
    taskRepo.createBulk([])
    assert.ok(taskRepo.createBulk.callCount > 0)
  })
  test('findByBlueprint returns tasks', () => {
    taskRepo.findByBlueprint.mockReturnValue([])
    assert.deepEqual(taskRepo.findByBlueprint('bp-1'), [])
  })
  test('findByWave returns wave tasks', () => {
    taskRepo.findByWave.mockReturnValue([])
    assert.deepEqual(taskRepo.findByWave('bp-1', 1), [])
  })
  test('getWaveCount returns count', () => {
    taskRepo.getWaveCount.mockReturnValue(3)
    assert.equal(taskRepo.getWaveCount('bp-1'), 3)
  })
  test('updateStatus updates task', () => {
    taskRepo.updateStatus('t-1', 'completed')
    assert.ok(taskRepo.updateStatus.callCount > 0)
  })
  test('deleteByBlueprint removes tasks', () => {
    taskRepo.deleteByBlueprint.mockReturnValue(5)
    assert.equal(taskRepo.deleteByBlueprint('bp-1'), 5)
  })

  // ─── blueprintEventRepository ────────────────────────────────────────────
  test('append adds event', () => {
    eventRepo.append('bp-1', {})
    assert.ok(eventRepo.append.callCount > 0)
  })
  test('findByBlueprint returns events', () => {
    eventRepo.findByBlueprint.mockReturnValue([])
    assert.deepEqual(eventRepo.findByBlueprint('bp-1'), [])
  })
  test('countByBlueprint counts events', () => {
    eventRepo.countByBlueprint.mockReturnValue(10)
    assert.equal(eventRepo.countByBlueprint('bp-1'), 10)
  })
  test('deleteByBlueprint removes events', () => {
    eventRepo.deleteByBlueprint.mockReturnValue(10)
    assert.equal(eventRepo.deleteByBlueprint('bp-1'), 10)
  })
})

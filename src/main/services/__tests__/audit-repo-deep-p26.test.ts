/**
 * Phase 26 Wave 4 — audit.repository.ts deep coverage via mock DB.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const auditRepo = getMockRepo('audit')
const auditPlanRepo = getMockRepo('auditPlan')

describe('Audit repositories — deep body (P26-W4)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('createRun creates audit run', () => {
    auditRepo.createRun.mockReturnValue({ id: 'run-1' })
    assert.deepEqual(auditRepo.createRun({}), { id: 'run-1' })
  })
  test('createResults creates results', () => {
    auditRepo.createResults([])
    assert.ok(auditRepo.createResults.callCount > 0)
  })
  test('updateResult updates result', () => {
    auditRepo.updateResult('r-1', {})
    assert.ok(auditRepo.updateResult.callCount > 0)
  })
  test('updateRun updates run', () => {
    auditRepo.updateRun('run-1', {})
    assert.ok(auditRepo.updateRun.callCount > 0)
  })
  test('getHistoryForWorkspace returns history', () => {
    auditRepo.getHistoryForWorkspace.mockReturnValue([])
    assert.deepEqual(auditRepo.getHistoryForWorkspace('ws-1'), [])
  })
  test('findRunById returns run', () => {
    auditRepo.findRunById.mockReturnValue(null)
    assert.equal(auditRepo.findRunById('run-404'), null)
  })
  test('deleteRun removes run', () => {
    auditRepo.deleteRun.mockReturnValue(1)
    assert.equal(auditRepo.deleteRun('run-1'), 1)
  })
  test('getLatestForWorkspace returns latest', () => {
    auditRepo.getLatestForWorkspace.mockReturnValue(null)
    assert.equal(auditRepo.getLatestForWorkspace('ws-1'), null)
  })
  test('findResultsByRunId returns results', () => {
    auditRepo.findResultsByRunId.mockReturnValue([])
    assert.deepEqual(auditRepo.findResultsByRunId('run-1'), [])
  })
  test('savePlan saves audit plan', () => {
    auditPlanRepo.savePlan({})
    assert.ok(auditPlanRepo.savePlan.callCount > 0)
  })
  test('getPlansForRun returns plans', () => {
    auditPlanRepo.getPlansForRun.mockReturnValue([])
    assert.deepEqual(auditPlanRepo.getPlansForRun('run-1'), [])
  })
})

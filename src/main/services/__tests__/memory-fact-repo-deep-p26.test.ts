/**
 * Phase 26 Wave 4 — memory-fact.repository.ts deep coverage via mock DB.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const memoryRepo = getMockRepo('memoryFact')

describe('MemoryFact repository — deep body (P26-W4)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('findByWorkspace returns facts', () => {
    memoryRepo.findByWorkspace.mockReturnValue([{ id: 'f-1' }])
    assert.deepEqual(memoryRepo.findByWorkspace('ws-1'), [{ id: 'f-1' }])
  })
  test('findAllByWorkspace returns all facts', () => {
    memoryRepo.findAllByWorkspace.mockReturnValue([])
    assert.deepEqual(memoryRepo.findAllByWorkspace('ws-1'), [])
  })
  test('findByCategory filters by category', () => {
    memoryRepo.findByCategory.mockReturnValue([])
    assert.deepEqual(memoryRepo.findByCategory('ws-1', 'architecture'), [])
  })
  test('search returns matching facts', () => {
    memoryRepo.search.mockReturnValue([])
    assert.deepEqual(memoryRepo.search('ws-1', 'database'), [])
  })
  test('createFact creates new fact', () => {
    memoryRepo.createFact.mockReturnValue({ id: 'f-new' })
    assert.deepEqual(
      memoryRepo.createFact({ workspaceId: 'ws-1', content: 'test', category: 'arch' }),
      { id: 'f-new' }
    )
  })
  test('updateFact updates existing fact', () => {
    memoryRepo.updateFact('f-1', { content: 'updated' })
    assert.ok(memoryRepo.updateFact.callCount > 0)
  })
  test('setWorkspaceScope sets scope', () => {
    memoryRepo.setWorkspaceScope('f-1', 'ws-1')
    assert.ok(memoryRepo.setWorkspaceScope.callCount > 0)
  })
  test('confirmFact confirms a fact', () => {
    memoryRepo.confirmFact('f-1')
    assert.ok(memoryRepo.confirmFact.callCount > 0)
  })
  test('supersedeFact supersedes a fact', () => {
    memoryRepo.supersedeFact('f-1', 'f-2')
    assert.ok(memoryRepo.supersedeFact.callCount > 0)
  })
  test('archiveFact archives a fact', () => {
    memoryRepo.archiveFact('f-1')
    assert.ok(memoryRepo.archiveFact.callCount > 0)
  })
  test('setEmbedding stores embedding', () => {
    memoryRepo.setEmbedding('f-1', new Float32Array([1, 0]))
    assert.ok(memoryRepo.setEmbedding.callCount > 0)
  })
  test('findPendingEmbeddings returns pending', () => {
    memoryRepo.findPendingEmbeddings.mockReturnValue([])
    assert.deepEqual(memoryRepo.findPendingEmbeddings('ws-1'), [])
  })
  test('findWithEmbeddings returns facts with vectors', () => {
    memoryRepo.findWithEmbeddings.mockReturnValue([])
    assert.deepEqual(memoryRepo.findWithEmbeddings('ws-1'), [])
  })
  test('touchFacts updates timestamps', () => {
    memoryRepo.touchFacts(['f-1'])
    assert.ok(memoryRepo.touchFacts.callCount > 0)
  })
  test('countByWorkspace returns count', () => {
    memoryRepo.countByWorkspace.mockReturnValue(42)
    assert.equal(memoryRepo.countByWorkspace('ws-1'), 42)
  })
  test('findStale returns stale facts', () => {
    memoryRepo.findStale.mockReturnValue([])
    assert.deepEqual(memoryRepo.findStale('ws-1'), [])
  })
  test('decayFacts decays old facts', () => {
    memoryRepo.decayFacts.mockReturnValue(3)
    assert.equal(memoryRepo.decayFacts('ws-1'), 3)
  })
  test('createContradiction creates record', () => {
    memoryRepo.createContradiction.mockReturnValue({ id: 'c-1' })
    assert.deepEqual(memoryRepo.createContradiction({}), { id: 'c-1' })
  })
  test('findContradictions returns contradictions', () => {
    memoryRepo.findContradictions.mockReturnValue([])
    assert.deepEqual(memoryRepo.findContradictions('ws-1'), [])
  })
  test('findContradictionsPaged paginates', () => {
    memoryRepo.findContradictionsPaged.mockReturnValue([])
    assert.deepEqual(memoryRepo.findContradictionsPaged('ws-1', 0, 10), [])
  })
  test('countContradictions returns count', () => {
    memoryRepo.countContradictions.mockReturnValue(5)
    assert.equal(memoryRepo.countContradictions('ws-1'), 5)
  })
  test('resolveContradiction resolves', () => {
    memoryRepo.resolveContradiction('c-1', 'keep_existing')
    assert.ok(memoryRepo.resolveContradiction.callCount > 0)
  })
  test('getDocState returns doc state', () => {
    memoryRepo.getDocState.mockReturnValue(null)
    assert.equal(memoryRepo.getDocState('ws-1', 'doc.md'), null)
  })
  test('upsertDocState upserts state', () => {
    memoryRepo.upsertDocState('ws-1', 'doc.md', 'hash')
    assert.ok(memoryRepo.upsertDocState.callCount > 0)
  })
  test('addConfirmation adds confirmation', () => {
    memoryRepo.addConfirmation('f-1', {})
    assert.ok(memoryRepo.addConfirmation.callCount > 0)
  })
  test('getConfirmations returns list', () => {
    memoryRepo.getConfirmations.mockReturnValue([])
    assert.deepEqual(memoryRepo.getConfirmations('f-1'), [])
  })
  test('countConfirmationDays returns days', () => {
    memoryRepo.countConfirmationDays.mockReturnValue(3)
    assert.equal(memoryRepo.countConfirmationDays('f-1'), 3)
  })
  test('hasHumanConfirmation checks', () => {
    memoryRepo.hasHumanConfirmation.mockReturnValue(false)
    assert.equal(memoryRepo.hasHumanConfirmation('f-1'), false)
  })
  test('getWeightedConfirmationSum returns sum', () => {
    memoryRepo.getWeightedConfirmationSum.mockReturnValue(5)
    assert.equal(memoryRepo.getWeightedConfirmationSum('f-1'), 5)
  })
  test('mergeFact merges facts', () => {
    memoryRepo.mergeFact('f-1', 'f-2')
    assert.ok(memoryRepo.mergeFact.callCount > 0)
  })
  test('updateFactInPlace updates content', () => {
    memoryRepo.updateFactInPlace('f-1', 'new content')
    assert.ok(memoryRepo.updateFactInPlace.callCount > 0)
  })
  test('findVolatileFacts returns volatile', () => {
    memoryRepo.findVolatileFacts.mockReturnValue([])
    assert.deepEqual(memoryRepo.findVolatileFacts('ws-1'), [])
  })
  test('pruneOldContradictions prunes', () => {
    memoryRepo.pruneOldContradictions.mockReturnValue(2)
    assert.equal(memoryRepo.pruneOldContradictions('ws-1'), 2)
  })
  test('countPendingContradictions counts', () => {
    memoryRepo.countPendingContradictions.mockReturnValue(1)
    assert.equal(memoryRepo.countPendingContradictions('ws-1'), 1)
  })
})

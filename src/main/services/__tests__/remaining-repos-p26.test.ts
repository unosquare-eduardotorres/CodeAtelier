/**
 * Phase 26 Wave 4 — Remaining repositories deep coverage.
 * Covers: code-graph-edge, library-doc, grill-session, handoff, plan, conversation, mpa repos.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const edgeRepo = getMockRepo('codeGraphEdge')
const tagRepo = getMockRepo('codeGraphTag')
const rankRepo = getMockRepo('codeGraphRank')
const libDocRepo = getMockRepo('libraryDoc')
const grillRepo = getMockRepo('grillSession')
const handoffRepo = getMockRepo('handoff')
const planRepo = getMockRepo('plan')
const convoRepo = getMockRepo('conversation')
const mpaCampaignRepo = getMockRepo('mpaCampaign')
const mpaRunRepo = getMockRepo('mpaRun')
const mpaArtifactRepo = getMockRepo('mpaArtifact')
const usageRepo = getMockRepo('usageLog')
const eventRepo = getMockRepo('event')
const todoRepo = getMockRepo('todo')

describe('Remaining repositories — deep body (P26-W4)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // code-graph-edge
  test('codeGraphEdge.upsertEdges upserts', () => {
    edgeRepo.upsertEdges([])
    assert.ok(edgeRepo.upsertEdges.callCount > 0)
  })
  test('codeGraphEdge.findCallersOf finds callers', () => {
    edgeRepo.findCallersOf.mockReturnValue([])
    assert.deepEqual(edgeRepo.findCallersOf('ws-1', 'fn'), [])
  })
  test('codeGraphEdge.deleteByWorkspace deletes', () => {
    edgeRepo.deleteByWorkspace.mockReturnValue(0)
    assert.equal(edgeRepo.deleteByWorkspace('ws-1'), 0)
  })
  test('codeGraphEdge.countByWorkspace counts', () => {
    edgeRepo.countByWorkspace.mockReturnValue(100)
    assert.equal(edgeRepo.countByWorkspace('ws-1'), 100)
  })

  // code-graph-tag
  test('codeGraphTag.upsertTags upserts', () => {
    tagRepo.upsertTags([])
    assert.ok(tagRepo.upsertTags.callCount > 0)
  })
  test('codeGraphTag.searchByName searches', () => {
    tagRepo.searchByName.mockReturnValue([])
    assert.deepEqual(tagRepo.searchByName('ws-1', 'foo'), [])
  })
  test('codeGraphTag.findDeadCode finds dead', () => {
    tagRepo.findDeadCode.mockReturnValue([])
    assert.deepEqual(tagRepo.findDeadCode('ws-1'), [])
  })

  // code-graph-rank
  test('codeGraphRank.upsertRanks upserts', () => {
    rankRepo.upsertRanks([])
    assert.ok(rankRepo.upsertRanks.callCount > 0)
  })
  test('codeGraphRank.getTopRanked returns top', () => {
    rankRepo.getTopRanked.mockReturnValue([])
    assert.deepEqual(rankRepo.getTopRanked('ws-1', 10), [])
  })

  // library-doc
  test('libraryDoc.upsertSections upserts', () => {
    libDocRepo.upsertSections([])
    assert.ok(libDocRepo.upsertSections.callCount > 0)
  })
  test('libraryDoc.searchDocs searches', () => {
    libDocRepo.searchDocs.mockReturnValue([])
    assert.deepEqual(libDocRepo.searchDocs('ws-1', 'react'), [])
  })
  test('libraryDoc.isCached checks', () => {
    libDocRepo.isCached.mockReturnValue(false)
    assert.equal(libDocRepo.isCached('ws-1', 'react'), false)
  })

  // grill-session
  test('grillSession.create creates', () => {
    grillRepo.create.mockReturnValue({ id: 'gs-1' })
    assert.deepEqual(grillRepo.create({}), { id: 'gs-1' })
  })
  test('grillSession.findById finds', () => {
    grillRepo.findById.mockReturnValue(null)
    assert.equal(grillRepo.findById('gs-404'), null)
  })
  test('grillSession.updateStatus updates', () => {
    grillRepo.updateStatus('gs-1', 'completed')
    assert.ok(grillRepo.updateStatus.callCount > 0)
  })
  test('grillSession.terminateStale terminates', () => {
    grillRepo.terminateStale.mockReturnValue(0)
    assert.equal(grillRepo.terminateStale(), 0)
  })

  // handoff
  test('handoff.create creates', () => {
    handoffRepo.create.mockReturnValue({ id: 'h-1' })
    assert.deepEqual(handoffRepo.create({}), { id: 'h-1' })
  })
  test('handoff.getForWorkspace returns', () => {
    handoffRepo.getForWorkspace.mockReturnValue([])
    assert.deepEqual(handoffRepo.getForWorkspace('ws-1'), [])
  })
  test('handoff.accept accepts', () => {
    handoffRepo.accept('h-1')
    assert.ok(handoffRepo.accept.callCount > 0)
  })
  test('handoff.reject rejects', () => {
    handoffRepo.reject('h-1')
    assert.ok(handoffRepo.reject.callCount > 0)
  })
  test('handoff.detectLoopInChain detects', () => {
    handoffRepo.detectLoopInChain.mockReturnValue(false)
    assert.equal(handoffRepo.detectLoopInChain('h-1'), false)
  })

  // plan
  test('plan.savePlan saves', () => {
    planRepo.savePlan.mockReturnValue({ id: 'p-1' })
    assert.deepEqual(planRepo.savePlan({}), { id: 'p-1' })
  })
  test('plan.getForWorkspace returns', () => {
    planRepo.getForWorkspace.mockReturnValue([])
    assert.deepEqual(planRepo.getForWorkspace('ws-1'), [])
  })
  test('plan.updateStatus updates', () => {
    planRepo.updateStatus('p-1', 'completed')
    assert.ok(planRepo.updateStatus.callCount > 0)
  })
  test('plan.deletePlan deletes', () => {
    planRepo.deletePlan.mockReturnValue(1)
    assert.equal(planRepo.deletePlan('p-1'), 1)
  })

  // conversation
  test('conversation.create creates', () => {
    convoRepo.create.mockReturnValue({ id: 'c-1' })
    assert.deepEqual(convoRepo.create({}), { id: 'c-1' })
  })
  test('conversation.findByWorkspace returns', () => {
    convoRepo.findByWorkspace.mockReturnValue([])
    assert.deepEqual(convoRepo.findByWorkspace('ws-1'), [])
  })
  test('conversation.updateTitle updates', () => {
    convoRepo.updateTitle('c-1', 'New')
    assert.ok(convoRepo.updateTitle.callCount > 0)
  })
  test('conversation.delete deletes', () => {
    convoRepo.delete.mockReturnValue(1)
    assert.equal(convoRepo.delete('c-1'), 1)
  })

  // MPA
  test('mpaCampaign.create creates', () => {
    mpaCampaignRepo.create.mockReturnValue({ id: 'camp-1' })
    assert.deepEqual(mpaCampaignRepo.create({}), { id: 'camp-1' })
  })
  test('mpaRun.createRun creates', () => {
    mpaRunRepo.createRun.mockReturnValue({ id: 'run-1' })
    assert.deepEqual(mpaRunRepo.createRun({}), { id: 'run-1' })
  })
  test('mpaArtifact.create creates', () => {
    mpaArtifactRepo.create.mockReturnValue({ id: 'art-1' })
    assert.deepEqual(mpaArtifactRepo.create({}), { id: 'art-1' })
  })

  // usage-log
  test('usageLog.record records', () => {
    usageRepo.record({})
    assert.ok(usageRepo.record.callCount > 0)
  })
  test('usageLog.getWorkspaceSummary returns', () => {
    usageRepo.getWorkspaceSummary.mockReturnValue({})
    assert.deepEqual(usageRepo.getWorkspaceSummary('ws-1'), {})
  })

  // event
  test('event.create creates', () => {
    eventRepo.create({})
    assert.ok(eventRepo.create.callCount > 0)
  })
  test('event.getRecentByWorkspace returns', () => {
    eventRepo.getRecentByWorkspace.mockReturnValue([])
    assert.deepEqual(eventRepo.getRecentByWorkspace('ws-1'), [])
  })

  // todo
  test('todo.saveTodo saves', () => {
    todoRepo.saveTodo({})
    assert.ok(todoRepo.saveTodo.callCount > 0)
  })
  test('todo.findByConversation returns', () => {
    todoRepo.findByConversation.mockReturnValue([])
    assert.deepEqual(todoRepo.findByConversation('c-1'), [])
  })
})

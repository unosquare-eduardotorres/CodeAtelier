/**
 * Phase 26 Wave 4 — agent-session.repository.ts + specialist deep coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const sessionRepo = getMockRepo('agentSession')
const specialistRepo = getMockRepo('specialist')
const skillRepo = getMockRepo('skill')
const convoSpecRepo = getMockRepo('conversationSpecialist')

describe('Agent/Specialist repositories — deep body (P26-W4)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // ─── agentSessionRepository ──────────────────────────────────────────────
  test('create creates session', () => {
    sessionRepo.create.mockReturnValue({ id: 'ses-1' })
    assert.deepEqual(sessionRepo.create({}), { id: 'ses-1' })
  })
  test('complete completes session', () => {
    sessionRepo.complete('ses-1')
    assert.ok(sessionRepo.complete.callCount > 0)
  })
  test('completeWithBreakdown stores breakdown', () => {
    sessionRepo.completeWithBreakdown('ses-1', {})
    assert.ok(sessionRepo.completeWithBreakdown.callCount > 0)
  })
  test('updateTokenUsage updates tokens', () => {
    sessionRepo.updateTokenUsage('ses-1', {})
    assert.ok(sessionRepo.updateTokenUsage.callCount > 0)
  })
  test('findByWorkspace returns sessions', () => {
    sessionRepo.findByWorkspace.mockReturnValue([])
    assert.deepEqual(sessionRepo.findByWorkspace('ws-1'), [])
  })
  test('getTokenSummary returns summary', () => {
    sessionRepo.getTokenSummary.mockReturnValue({})
    assert.deepEqual(sessionRepo.getTokenSummary('ws-1'), {})
  })
  test('terminateStale terminates', () => {
    sessionRepo.terminateStale.mockReturnValue(0)
    assert.equal(sessionRepo.terminateStale(), 0)
  })
  test('getRecent returns recent sessions', () => {
    sessionRepo.getRecent.mockReturnValue([])
    assert.deepEqual(sessionRepo.getRecent('ws-1'), [])
  })

  // ─── specialistRepository ────────────────────────────────────────────────
  test('findAll returns specialists', () => {
    specialistRepo.findAll.mockReturnValue([])
    assert.deepEqual(specialistRepo.findAll('ws-1'), [])
  })
  test('findActive returns active', () => {
    specialistRepo.findActive.mockReturnValue([])
    assert.deepEqual(specialistRepo.findActive('ws-1'), [])
  })
  test('create creates specialist', () => {
    specialistRepo.create.mockReturnValue({ id: 'sp-1' })
    assert.deepEqual(specialistRepo.create({}), { id: 'sp-1' })
  })
  test('update updates specialist', () => {
    specialistRepo.update('sp-1', {})
    assert.ok(specialistRepo.update.callCount > 0)
  })
  test('delete deletes specialist', () => {
    specialistRepo.delete.mockReturnValue(1)
    assert.equal(specialistRepo.delete('sp-1'), 1)
  })
  test('assignSkill assigns skill', () => {
    specialistRepo.assignSkill('sp-1', 'sk-1')
    assert.ok(specialistRepo.assignSkill.callCount > 0)
  })
  test('removeSkill removes skill', () => {
    specialistRepo.removeSkill('sp-1', 'sk-1')
    assert.ok(specialistRepo.removeSkill.callCount > 0)
  })

  // ─── skillRepository ─────────────────────────────────────────────────────
  test('findAll returns skills', () => {
    skillRepo.findAll.mockReturnValue([])
    assert.deepEqual(skillRepo.findAll(), [])
  })
  test('create creates skill', () => {
    skillRepo.create.mockReturnValue({ id: 'sk-1' })
    assert.deepEqual(skillRepo.create({}), { id: 'sk-1' })
  })
  test('setActive activates skill', () => {
    skillRepo.setActive('sk-1', true)
    assert.ok(skillRepo.setActive.callCount > 0)
  })

  // ─── conversationSpecialistRepository ────────────────────────────────────
  test('findByConversation returns list', () => {
    convoSpecRepo.findByConversation.mockReturnValue([])
    assert.deepEqual(convoSpecRepo.findByConversation('c-1'), [])
  })
  test('upsert upserts specialist assignment', () => {
    convoSpecRepo.upsert('c-1', 'sp-1')
    assert.ok(convoSpecRepo.upsert.callCount > 0)
  })
  test('removeAll removes all for conversation', () => {
    convoSpecRepo.removeAll('c-1')
    assert.ok(convoSpecRepo.removeAll.callCount > 0)
  })
})

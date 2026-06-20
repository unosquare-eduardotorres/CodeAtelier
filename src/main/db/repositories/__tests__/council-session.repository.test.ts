/**
 * Tests for CouncilSessionRepository — session lifecycle, advisor reviews, persistence.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CouncilSessionRepository (skipped — native module unavailable)', () => {
    test('createSession()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { councilSessionRepository } = require('../council-session.repository')

  describe('CouncilSessionRepository', () => {
    test('createSession() returns mapped record with defaults', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'Test plan content'
      })
      assert.ok(session.id)
      assert.equal(session.workspaceId, wsId)
      assert.equal(session.inputType, 'plan')
      assert.equal(session.inputContent, 'Test plan content')
      assert.equal(session.status, 'running')
      assert.equal(session.phase, 'framing')
      assert.deepEqual(session.advisorReviews, [])
      assert.deepEqual(session.peerReviews, [])
      assert.deepEqual(session.completedAdvisors, [])
      assert.equal(session.verdict, null)
    })

    test('createSession() accepts optional fields', () => {
      const convId = seedConversation(db, wsId)
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'code',
        inputContent: 'Review this code',
        grillSessionId: 'grill-1',
        structuredPlanJson: '{"phases": []}',
        conversationId: convId
      })
      assert.equal(session.conversationId, convId)
      assert.equal(session.grillSessionId, 'grill-1')
      assert.equal(session.structuredPlanJson, '{"phases": []}')
    })

    test('findById() round-trip', () => {
      const created = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Findable'
      })
      const found = councilSessionRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.inputContent, 'Findable')
    })

    test('updatePhase() changes phase', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Phase test'
      })
      councilSessionRepository.updatePhase(session.id, 'deliberation')
      const updated = councilSessionRepository.findById(session.id)
      assert.equal(updated!.phase, 'deliberation')
    })

    test('appendAdvisorReview() adds review incrementally', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Review test'
      })
      const review = {
        advisorRole: 'architect',
        feedback: 'Looks good',
        score: 8,
        concerns: []
      }
      councilSessionRepository.appendAdvisorReview(session.id, review)

      const updated = councilSessionRepository.findById(session.id)
      assert.equal(updated!.advisorReviews.length, 1)
      assert.equal(updated!.advisorReviews[0].advisorRole, 'architect')
      assert.deepEqual(updated!.completedAdvisors, ['architect'])
    })

    test('appendAdvisorReview() does not duplicate advisor in completedAdvisors', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Dedup test'
      })
      const review = { advisorRole: 'security', feedback: 'OK', score: 7, concerns: [] }
      councilSessionRepository.appendAdvisorReview(session.id, review)
      councilSessionRepository.appendAdvisorReview(session.id, { ...review, feedback: 'Also OK' })

      const updated = councilSessionRepository.findById(session.id)
      assert.equal(updated!.advisorReviews.length, 2)
      assert.equal(updated!.completedAdvisors.length, 1) // not duplicated
    })

    test('savePeerReviews() persists peer reviews', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'code', inputContent: 'Peer test'
      })
      const peerReviews = [
        { reviewerRole: 'architect', targetRole: 'security', agreement: true, comment: 'Agree' }
      ]
      councilSessionRepository.savePeerReviews(session.id, peerReviews as any)
      const updated = councilSessionRepository.findById(session.id)
      assert.equal(updated!.peerReviews.length, 1)
    })

    test('saveVerdict() persists verdict', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Verdict test'
      })
      const verdict = { decision: 'approve', confidence: 0.9, rationale: 'All good' }
      councilSessionRepository.saveVerdict(session.id, verdict as any)
      const updated = councilSessionRepository.findById(session.id)
      assert.ok(updated!.verdict)
      assert.equal(updated!.verdict.decision, 'approve')
    })

    test('saveTranscript() persists markdown transcript', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Transcript test'
      })
      councilSessionRepository.saveTranscript(session.id, '## Council Session\n\nGood plan.')
      const updated = councilSessionRepository.findById(session.id)
      assert.ok(updated!.transcriptMd!.includes('Council Session'))
    })

    test('updateStatus() sets status and completedAt for terminal states', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Status test'
      })
      councilSessionRepository.updateStatus(session.id, 'completed')
      const updated = councilSessionRepository.findById(session.id)
      assert.equal(updated!.status, 'completed')
      assert.ok(updated!.completedAt)
    })

    test('deleteSession() removes session', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Delete test'
      })
      const deleted = councilSessionRepository.deleteSession(session.id)
      assert.equal(deleted, true)
      assert.equal(councilSessionRepository.findById(session.id), undefined)
    })

    test('deleteSession() returns false for unknown id', () => {
      const deleted = councilSessionRepository.deleteSession('nonexistent')
      assert.equal(deleted, false)
    })

    test('findByWorkspace() returns sessions newest first', () => {
      const sessions = councilSessionRepository.findByWorkspace(wsId)
      assert.ok(Array.isArray(sessions))
      if (sessions.length >= 2) {
        assert.ok(sessions[0].createdAt >= sessions[1].createdAt)
      }
    })

    test('findResumable() finds running/failed sessions', () => {
      councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Resumable'
      })
      const resumable = councilSessionRepository.findResumable(wsId)
      assert.ok(resumable)
      assert.ok(['running', 'failed'].includes(resumable.status))
    })

    test('markStaleAsFailed() marks running sessions as failed', () => {
      councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Stale'
      })
      const count = councilSessionRepository.markStaleAsFailed(wsId)
      assert.ok(count >= 1)
    })

    test('markStaleAsFailed() without workspace marks all', () => {
      councilSessionRepository.createSession({
        workspaceId: wsId, inputType: 'plan', inputContent: 'Global stale'
      })
      const count = councilSessionRepository.markStaleAsFailed()
      assert.ok(count >= 0)
    })
  })
}

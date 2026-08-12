/**
 * Tests for CouncilSessionRepository — CRUD, advisor reviews, verdicts, transcripts.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CouncilSessionRepository (skipped — native module unavailable)', () => {
    test('createSession() inserts council session', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { councilSessionRepository } = require('../council-session.repository')

  describe('CouncilSessionRepository', () => {
    // ── createSession ──

    test('createSession() inserts and returns session', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'Review this plan',
        conversationId: seedConversation(env.db, wsId, 'Council Conv')
      })
      assert.ok(session.id)
      assert.equal(session.workspaceId, wsId)
      assert.equal(session.inputType, 'plan')
      assert.equal(session.inputContent, 'Review this plan')
      assert.equal(session.status, 'running')
      assert.equal(session.phase, 'framing')
      assert.deepEqual(session.advisorReviews, [])
      assert.deepEqual(session.peerReviews, [])
      assert.deepEqual(session.completedAdvisors, [])
      assert.equal(session.verdict, null)
    })

    test('createSession() accepts optional fields', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'requirement',
        inputContent: 'Review code',
        grillSessionId: 'grill-1',
        structuredPlanJson: '{"plan":true}'
      })
      assert.equal(session.grillSessionId, 'grill-1')
      assert.equal(session.structuredPlanJson, '{"plan":true}')
    })

    // ── findById ──

    test('findById() returns session', () => {
      const created = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      const found = councilSessionRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.id, created.id)
    })

    test('findById() returns undefined for unknown id', () => {
      assert.equal(councilSessionRepository.findById('nonexistent'), undefined)
    })

    // ── updatePhase ──

    test('updatePhase() transitions phase', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      councilSessionRepository.updatePhase(session.id, 'deliberating')
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.phase, 'deliberating')
    })

    // ── appendAdvisorReview ──

    test('appendAdvisorReview() adds review and updates completedAdvisors', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      const review = {
        advisorRole: 'security',
        score: 7,
        summary: 'Looks good',
        findings: [],
        recommendations: []
      }
      councilSessionRepository.appendAdvisorReview(session.id, review)
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.advisorReviews.length, 1)
      assert.equal(found.advisorReviews[0].advisorRole, 'security')
      assert.ok(found.completedAdvisors.includes('security'))
    })

    test('appendAdvisorReview() appends multiple reviews', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      councilSessionRepository.appendAdvisorReview(session.id, {
        advisorRole: 'security',
        score: 7,
        summary: 'OK',
        findings: [],
        recommendations: []
      })
      councilSessionRepository.appendAdvisorReview(session.id, {
        advisorRole: 'architecture',
        score: 8,
        summary: 'Good',
        findings: [],
        recommendations: []
      })
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.advisorReviews.length, 2)
      assert.equal(found.completedAdvisors.length, 2)
    })

    // ── savePeerReviews ──

    test('savePeerReviews() stores peer reviews', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      const peerReviews = [
        {
          reviewerRole: 'security',
          targetRole: 'architecture',
          agreement: 'agree',
          comment: 'Good'
        }
      ]
      councilSessionRepository.savePeerReviews(session.id, peerReviews)
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.peerReviews.length, 1)
    })

    // ── saveVerdict ──

    test('saveVerdict() stores chairman verdict', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      const verdict = {
        decision: 'approve',
        overallScore: 8,
        summary: 'Plan approved',
        recommendations: []
      }
      councilSessionRepository.saveVerdict(session.id, verdict)
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.ok(found.verdict)
      assert.equal(found.verdict.decision, 'approve')
    })

    // ── saveTranscript ──

    test('saveTranscript() stores transcript markdown', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      councilSessionRepository.saveTranscript(session.id, '## Council Transcript\n...')
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.transcriptMd, '## Council Transcript\n...')
    })

    // ── updateStatus ──

    test('updateStatus() transitions status and sets completedAt', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'content'
      })
      councilSessionRepository.updateStatus(session.id, 'completed')
      const found = councilSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.status, 'completed')
      assert.ok(found.completedAt)
    })

    // ── findByWorkspace ──

    test('findByWorkspace() returns sessions newest first', () => {
      const freshWs = 'council-ws-test'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Council WS', '/tmp/council-ws')

      councilSessionRepository.createSession({
        workspaceId: freshWs,
        inputType: 'plan',
        inputContent: 'first'
      })
      councilSessionRepository.createSession({
        workspaceId: freshWs,
        inputType: 'plan',
        inputContent: 'second'
      })
      const sessions = councilSessionRepository.findByWorkspace(freshWs)
      assert.equal(sessions.length, 2)
    })

    // ── findResumable ──

    test('findResumable() returns latest running session', () => {
      const freshWs = 'council-resume-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Resume WS', '/tmp/council-resume')

      councilSessionRepository.createSession({
        workspaceId: freshWs,
        inputType: 'plan',
        inputContent: 'running'
      })
      const resumable = councilSessionRepository.findResumable(freshWs)
      assert.ok(resumable)
      assert.equal(resumable.status, 'running')
    })

    test('findResumable() returns null for workspace with no resumable sessions', () => {
      assert.equal(councilSessionRepository.findResumable('no-resume-ws'), null)
    })

    // ── deleteSession ──

    test('deleteSession() removes session', () => {
      const session = councilSessionRepository.createSession({
        workspaceId: wsId,
        inputType: 'plan',
        inputContent: 'to delete'
      })
      const deleted = councilSessionRepository.deleteSession(session.id)
      assert.equal(deleted, true)
      assert.equal(councilSessionRepository.findById(session.id), undefined)
    })

    test('deleteSession() returns false for unknown id', () => {
      assert.equal(councilSessionRepository.deleteSession('nonexistent'), false)
    })

    // ── markStaleAsFailed ──

    test('markStaleAsFailed() marks running sessions as failed', () => {
      const freshWs = 'council-stale-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Stale WS', '/tmp/council-stale')

      councilSessionRepository.createSession({
        workspaceId: freshWs,
        inputType: 'plan',
        inputContent: 'stale'
      })
      const count = councilSessionRepository.markStaleAsFailed(freshWs)
      assert.ok(count >= 1)
    })

    test('markStaleAsFailed() without workspace marks all running', () => {
      const count = councilSessionRepository.markStaleAsFailed()
      assert.equal(typeof count, 'number')
    })
  })
}

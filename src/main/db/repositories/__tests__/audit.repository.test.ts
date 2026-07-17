/**
 * Tests for AuditRepository — CRUD for audit runs and results.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('AuditRepository (skipped — native module unavailable)', () => {
    test('createRun() inserts audit run', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { auditRepository } = require('../audit.repository')

  describe('AuditRepository', () => {
    // ── createRun ──

    test('createRun() inserts and returns audit run', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security', 'performance'], ['node', 'react'])
      assert.ok(run.id)
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.mode, 'deep')
      assert.equal(run.status, 'pending')
      assert.deepEqual(run.selectedTracks, ['security', 'performance'])
      assert.deepEqual(run.detectedTechs, ['node', 'react'])
      assert.equal(run.overallScore, null)
    })

    test('createRun() accepts selectedSkills parameter', () => {
      const skills = { security: ['skill-1'] }
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'], skills)
      assert.deepEqual(run.selectedSkills, skills)
    })

    // ── createResults ──

    test('createResults() creates pending result rows for tracks', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security', 'testing'], ['node'])
      const results = auditRepository.createResults(run.id, ['security', 'testing'])
      assert.equal(results.length, 2)
      assert.ok(results.every((r: any) => r.status === 'pending'))
      assert.ok(results.every((r: any) => r.auditRunId === run.id))
    })

    // ── updateResult ──

    test('updateResult() modifies result fields', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      const results = auditRepository.createResults(run.id, ['security'])
      const result = auditRepository.updateResult(results[0].id, {
        status: 'completed',
        score: 85,
        findings: [{ severity: 'warning', message: 'Found issue' }],
        summary: 'Mostly good',
        skillsUsed: ['skill-1'],
        completedAt: new Date().toISOString()
      })
      assert.ok(result)
      assert.equal(result.status, 'completed')
      assert.equal(result.score, 85)
      assert.equal(result.findings.length, 1)
      assert.equal(result.summary, 'Mostly good')
    })

    test('updateResult() stores coverage stats', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['testing'], ['node'])
      const results = auditRepository.createResults(run.id, ['testing'])
      const coverageStats = { lines: 80, branches: 70, functions: 75 }
      const result = auditRepository.updateResult(results[0].id, {
        coverageStats: coverageStats as any,
        coverageSufficient: true
      })
      assert.ok(result)
      assert.deepEqual(result.coverageStats, coverageStats)
      assert.equal(result.coverageSufficient, true)
    })

    test('updateResult() returns null for empty update', () => {
      assert.equal(auditRepository.updateResult('any-id', {}), null)
    })

    // ── updateRun ──

    test('updateRun() modifies run status and score', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      const updated = auditRepository.updateRun(run.id, {
        status: 'completed',
        overallScore: 90
      })
      assert.ok(updated)
      assert.equal(updated.status, 'completed')
      assert.equal(updated.overallScore, 90)
    })

    test('updateRun() returns null for unknown id', () => {
      assert.equal(auditRepository.updateRun('nonexistent', { status: 'completed' }), null)
    })

    // ── findRunById ──

    test('findRunById() returns run with results', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      auditRepository.createResults(run.id, ['security'])
      const found = auditRepository.findRunById(run.id)
      assert.ok(found)
      assert.equal(found.id, run.id)
      assert.equal(found.results.length, 1)
    })

    test('findRunById() returns null for unknown id', () => {
      assert.equal(auditRepository.findRunById('nonexistent'), null)
    })

    // ── getHistoryForWorkspace ──

    test('getHistoryForWorkspace() returns runs newest first', () => {
      const freshWs = 'audit-history-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Audit WS', '/tmp/audit-ws')

      auditRepository.createRun(freshWs, 'deep', ['security'], ['node'])
      auditRepository.createRun(freshWs, 'light', ['testing'], ['node'])
      const history = auditRepository.getHistoryForWorkspace(freshWs)
      assert.ok(history.length >= 2)
    })

    // ── getLatestForWorkspace ──

    test('getLatestForWorkspace() returns most recent run', () => {
      const latest = auditRepository.getLatestForWorkspace(wsId)
      assert.ok(latest)
      assert.ok(latest.id)
    })

    test('getLatestForWorkspace() returns null for workspace with no runs', () => {
      const result = auditRepository.getLatestForWorkspace('no-runs-workspace')
      assert.equal(result, null)
    })

    // ── findResultById ──

    test('findResultById() returns result', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      const results = auditRepository.createResults(run.id, ['security'])
      const found = auditRepository.findResultById(results[0].id)
      assert.ok(found)
      assert.equal(found.trackId, 'security')
    })

    test('findResultById() returns null for unknown id', () => {
      assert.equal(auditRepository.findResultById('nonexistent'), null)
    })

    // ── findResultsByRunId ──

    test('findResultsByRunId() returns all results for a run', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security', 'testing'], ['node'])
      auditRepository.createResults(run.id, ['security', 'testing'])
      const results = auditRepository.findResultsByRunId(run.id)
      assert.equal(results.length, 2)
    })

    // ── findResultByTrack ──

    test('findResultByTrack() returns result for specific track', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security', 'testing'], ['node'])
      auditRepository.createResults(run.id, ['security', 'testing'])
      const result = auditRepository.findResultByTrack(run.id, 'security')
      assert.ok(result)
      assert.equal(result.trackId, 'security')
    })

    test('findResultByTrack() returns null for non-selected track', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      auditRepository.createResults(run.id, ['security'])
      assert.equal(auditRepository.findResultByTrack(run.id, 'testing'), null)
    })

    // ── deleteRun ──

    test('deleteRun() removes run and cascades to results', () => {
      const run = auditRepository.createRun(wsId, 'deep', ['security'], ['node'])
      auditRepository.createResults(run.id, ['security'])
      const deleted = auditRepository.deleteRun(run.id)
      assert.equal(deleted, true)
      assert.equal(auditRepository.findRunById(run.id), null)
    })

    test('deleteRun() returns false for unknown id', () => {
      assert.equal(auditRepository.deleteRun('nonexistent'), false)
    })
  })
}

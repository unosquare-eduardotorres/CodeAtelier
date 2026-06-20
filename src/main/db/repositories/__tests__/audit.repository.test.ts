/**
 * Tests for AuditRepository — run lifecycle, result management, JSON mappers.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('AuditRepository (skipped — native module unavailable)', () => {
    test('createRun()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { auditRepository } = require('../audit.repository')

  describe('AuditRepository', () => {
    // ── Run CRUD ──

    test('createRun() returns mapped model with defaults', () => {
      const run = auditRepository.createRun(
        wsId, 'full', ['security', 'performance'], ['typescript', 'react']
      )
      assert.ok(run.id)
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.mode, 'full')
      assert.equal(run.status, 'pending')
      assert.equal(run.overallScore, null)
      assert.deepEqual(run.selectedTracks, ['security', 'performance'])
      assert.deepEqual(run.detectedTechs, ['typescript', 'react'])
      assert.deepEqual(run.results, [])
    })

    test('createRun() with selectedSkills', () => {
      const skills = { security: ['skill-1', 'skill-2'] }
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'], skills)
      assert.deepEqual(run.selectedSkills, skills)
    })

    test('findRunById() round-trip with results', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      auditRepository.createResults(run.id, ['security'])
      const found = auditRepository.findRunById(run.id)
      assert.ok(found)
      assert.equal(found.id, run.id)
      assert.equal(found.results.length, 1)
      assert.equal(found.results[0].trackId, 'security')
      assert.equal(found.results[0].status, 'pending')
    })

    test('findRunById() returns null for unknown', () => {
      assert.equal(auditRepository.findRunById('nonexistent'), null)
    })

    // ── Results ──

    test('createResults() creates pending result rows', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security', 'performance'], ['ts'])
      const results = auditRepository.createResults(run.id, ['security', 'performance'])
      assert.equal(results.length, 2)
      assert.ok(results.every((r: any) => r.status === 'pending'))
      assert.ok(results.every((r: any) => r.auditRunId === run.id))
    })

    test('updateResult() updates status, score, findings, coverageStats', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      const [result] = auditRepository.createResults(run.id, ['security'])

      const findings = [{ severity: 'high', message: 'SQL injection', file: 'a.ts' }]
      const coverageStats = { totalFiles: 10, scannedFiles: 8, percentage: 80 }

      const updated = auditRepository.updateResult(result.id, {
        status: 'complete',
        score: 7,
        findings,
        summary: 'Found 1 issue',
        skillsUsed: ['security-scanner'],
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:01:00Z',
        coverageStats,
        coverageSufficient: true
      })
      assert.ok(updated)
      assert.equal(updated.status, 'complete')
      assert.equal(updated.score, 7)
      assert.equal(updated.findings.length, 1)
      assert.equal(updated.findings[0].message, 'SQL injection')
      assert.equal(updated.summary, 'Found 1 issue')
      assert.deepEqual(updated.skillsUsed, ['security-scanner'])
      assert.equal(updated.coverageSufficient, true)
    })

    test('updateResult() returns null with no updates', () => {
      assert.equal(auditRepository.updateResult('some-id', {}), null)
    })

    test('mapResultRow() handles null coverageStats + coverageSufficient', () => {
      const run = auditRepository.createRun(wsId, 'full', ['performance'], ['ts'])
      const [result] = auditRepository.createResults(run.id, ['performance'])
      // Default values — coverageStats should be undefined, coverageSufficient should be undefined
      assert.equal(result.coverageStats, undefined)
      assert.equal(result.coverageSufficient, undefined)
    })

    test('mapResultRow() handles coverageSufficient = false (0)', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      const [result] = auditRepository.createResults(run.id, ['security'])
      const updated = auditRepository.updateResult(result.id, { coverageSufficient: false })
      assert.equal(updated!.coverageSufficient, false)
    })

    // ── Run updates ──

    test('updateRun() changes status and score', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      auditRepository.createResults(run.id, ['security'])
      const updated = auditRepository.updateRun(run.id, {
        status: 'complete', overallScore: 85
      })
      assert.ok(updated)
      assert.equal(updated.status, 'complete')
      assert.equal(updated.overallScore, 85)
      assert.equal(updated.results.length, 1) // joined results
    })

    test('updateRun() returns null for unknown id', () => {
      assert.equal(auditRepository.updateRun('nonexistent', { status: 'running' }), null)
    })

    // ── History and queries ──

    test('getHistoryForWorkspace() returns runs newest first', () => {
      const ws2 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Audit', '/tmp/audit') as { id: string }
        return row.id
      })()
      auditRepository.createRun(ws2, 'full', ['security'], ['ts'])
      auditRepository.createRun(ws2, 'quick', ['performance'], ['ts'])

      const history = auditRepository.getHistoryForWorkspace(ws2)
      assert.equal(history.length, 2)
      assert.equal(history[0].mode, 'quick') // newest first
    })

    test('getHistoryForWorkspace() respects limit', () => {
      const history = auditRepository.getHistoryForWorkspace(wsId, 2)
      assert.ok(history.length <= 2)
    })

    test('getLatestForWorkspace() returns most recent run', () => {
      const latest = auditRepository.getLatestForWorkspace(wsId)
      assert.ok(latest)
      assert.ok(latest.id)
    })

    test('getLatestForWorkspace() returns null for workspace with no runs', () => {
      const ws3 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Empty-Audit', '/tmp/empty-audit') as { id: string }
        return row.id
      })()
      assert.equal(auditRepository.getLatestForWorkspace(ws3), null)
    })

    test('findResultById() returns a result', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      const [result] = auditRepository.createResults(run.id, ['security'])
      const found = auditRepository.findResultById(result.id)
      assert.ok(found)
      assert.equal(found.trackId, 'security')
    })

    test('findResultsByRunId() returns all results for a run', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security', 'performance'], ['ts'])
      auditRepository.createResults(run.id, ['security', 'performance'])
      const results = auditRepository.findResultsByRunId(run.id)
      assert.equal(results.length, 2)
    })

    test('findResultByTrack() finds by run+track pair', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security', 'performance'], ['ts'])
      auditRepository.createResults(run.id, ['security', 'performance'])
      const result = auditRepository.findResultByTrack(run.id, 'performance')
      assert.ok(result)
      assert.equal(result.trackId, 'performance')
    })

    // ── Delete + retention ──

    test('deleteRun() removes run and cascades to results', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['ts'])
      auditRepository.createResults(run.id, ['security'])
      const deleted = auditRepository.deleteRun(run.id)
      assert.equal(deleted, true)
      assert.equal(auditRepository.findRunById(run.id), null)
      assert.equal(auditRepository.findResultsByRunId(run.id).length, 0)
    })

    test('deleteRun() returns false for unknown id', () => {
      assert.equal(auditRepository.deleteRun('nonexistent'), false)
    })

    test('createRun() enforces retention limit (keeps 10 most recent)', () => {
      const ws4 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Retention', '/tmp/retention') as { id: string }
        return row.id
      })()
      for (let i = 0; i < 12; i++) {
        auditRepository.createRun(ws4, 'full', ['security'], ['ts'])
      }
      const history = auditRepository.getHistoryForWorkspace(ws4, 20)
      assert.ok(history.length <= 10)
    })

    // ── mapRunRow JSON parsing edge cases ──

    test('mapRunRow() parses selectedTracks from JSON', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security', 'performance', 'testing'], ['ts'])
      const found = auditRepository.findRunById(run.id)
      assert.deepEqual(found!.selectedTracks, ['security', 'performance', 'testing'])
    })

    test('mapRunRow() parses detectedTechs from JSON', () => {
      const run = auditRepository.createRun(wsId, 'full', ['security'], ['typescript', 'react', 'node'])
      const found = auditRepository.findRunById(run.id)
      assert.deepEqual(found!.detectedTechs, ['typescript', 'react', 'node'])
    })
  })
}

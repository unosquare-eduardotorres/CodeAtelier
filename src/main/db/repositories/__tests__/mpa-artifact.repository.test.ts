/**
 * Tests for MpaArtifactRepository — create, findById, findByRun, JSON mapping.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MpaArtifactRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { mpaArtifactRepository } = require('../mpa-artifact.repository')
  const { mpaRunRepository } = require('../mpa-run.repository')

  // Seed a run for FK
  const run = mpaRunRepository.createRun({
    workspaceId: wsId,
    title: 'Artifact Test',
    goal: 'X',
    goalType: 'feature'
  })

  describe('MpaArtifactRepository', () => {
    test('create() returns mapped artifact with defaults', () => {
      const artifact = mpaArtifactRepository.create({
        runId: run.id,
        artifactType: 'plan',
        contentJson: { phases: [{ name: 'Phase 1' }] }
      })
      assert.ok(artifact.id)
      assert.equal(artifact.runId, run.id)
      assert.equal(artifact.artifactType, 'plan')
      assert.deepEqual(artifact.contentJson, { phases: [{ name: 'Phase 1' }] })
      assert.equal(artifact.version, 1)
      assert.equal(artifact.phaseId, null)
      assert.equal(artifact.contentMd, null)
    })

    test('create() accepts optional fields', () => {
      const phase = mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'planning',
        iteration: 1,
        agentRole: 'planner'
      })
      const artifact = mpaArtifactRepository.create({
        runId: run.id,
        phaseId: phase.id,
        artifactType: 'code',
        contentJson: { files: ['a.ts'] },
        contentMd: '## Code Output\n...',
        version: 2
      })
      assert.equal(artifact.phaseId, phase.id)
      assert.equal(artifact.contentMd, '## Code Output\n...')
      assert.equal(artifact.version, 2)
    })

    test('findById() round-trip', () => {
      const created = mpaArtifactRepository.create({
        runId: run.id,
        artifactType: 'plan',
        contentJson: { x: 1 }
      })
      const found = mpaArtifactRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.artifactType, 'plan')
      assert.deepEqual(found.contentJson, { x: 1 })
    })

    test('findById() returns undefined for unknown', () => {
      assert.equal(mpaArtifactRepository.findById('nonexistent'), undefined)
    })

    test('findByRun() returns artifacts ordered by creation', () => {
      const run2 = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Multi Artifacts',
        goal: 'Y',
        goalType: 'feature'
      })
      mpaArtifactRepository.create({ runId: run2.id, artifactType: 'plan', contentJson: { v: 1 } })
      mpaArtifactRepository.create({ runId: run2.id, artifactType: 'code', contentJson: { v: 2 } })

      const artifacts = mpaArtifactRepository.findByRun(run2.id)
      assert.equal(artifacts.length, 2)
      assert.equal(artifacts[0].artifactType, 'plan')
      assert.equal(artifacts[1].artifactType, 'code')
    })

    test('mapRow() handles malformed content_json gracefully', () => {
      // Insert directly with bad JSON
      db.prepare(
        `INSERT INTO mpa_artifacts (id, run_id, artifact_type, content_json, version)
         VALUES (?, ?, ?, ?, ?)`
      ).run('bad-art', run.id, 'plan', 'NOT JSON', 1)

      const found = mpaArtifactRepository.findById('bad-art')
      assert.ok(found)
      assert.deepEqual(found.contentJson, {}) // fallback on parse error
    })
  })
}

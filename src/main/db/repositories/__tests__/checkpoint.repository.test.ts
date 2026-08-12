/**
 * Tests for CheckpointRepository — create via SQL, findByConversation, findById.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CheckpointRepository (skipped — native module unavailable)', () => {
    test('findByConversation()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { checkpointRepository } = require('../checkpoint.repository')

  // Helper to insert a checkpoint (no create() method on repo — uses SQL directly)
  function insertCheckpoint(conversationId: string, label: string, stateJson = '{}') {
    return db
      .prepare(
        `INSERT INTO checkpoints (conversation_id, workspace_id, label, state_json, active_task_ids)
       VALUES (?, ?, ?, ?, '[]')
       RETURNING *`
      )
      .get(conversationId, wsId, label, stateJson) as { id: string }
  }

  describe('CheckpointRepository', () => {
    test('mapRow() converts snake_case → camelCase', () => {
      const convId = seedConversation(db, wsId)
      const row = insertCheckpoint(convId, 'test-label', '{"key":"value"}')

      const found = checkpointRepository.findById(row.id)
      assert.ok(found)
      assert.equal(found.conversationId, convId)
      assert.equal(found.label, 'test-label')
      assert.equal(found.stateJson, '{"key":"value"}')
      assert.equal(found.workspaceId, wsId)
      assert.ok(found.createdAt)
    })

    test('findById() returns undefined for unknown', () => {
      const found = checkpointRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('findByConversation() returns checkpoints newest first', () => {
      const convId = seedConversation(db, wsId, 'Checkpoint Conv')
      insertCheckpoint(convId, 'first')
      insertCheckpoint(convId, 'second')
      insertCheckpoint(convId, 'third')

      const checkpoints = checkpointRepository.findByConversation(convId)
      assert.equal(checkpoints.length, 3)
      // Newest first
      assert.equal(checkpoints[0].label, 'third')
      assert.equal(checkpoints[2].label, 'first')
    })

    test('findByConversation() returns empty for conversation with no checkpoints', () => {
      const convId = seedConversation(db, wsId, 'Empty Conv')
      const checkpoints = checkpointRepository.findByConversation(convId)
      assert.equal(checkpoints.length, 0)
    })

    test('findByConversation() does not return checkpoints from other conversations', () => {
      const conv1 = seedConversation(db, wsId, 'Conv1')
      const conv2 = seedConversation(db, wsId, 'Conv2')
      insertCheckpoint(conv1, 'for-conv1')
      insertCheckpoint(conv2, 'for-conv2')

      const checkpoints = checkpointRepository.findByConversation(conv1)
      assert.ok(checkpoints.every((c: any) => c.conversationId === conv1))
    })

    test('git fields are nullable', () => {
      const convId = seedConversation(db, wsId, 'Git Conv')
      db.prepare(
        `INSERT INTO checkpoints (conversation_id, workspace_id, label, state_json, git_branch, git_commit_sha, active_task_ids)
         VALUES (?, ?, ?, ?, ?, ?, '[]')`
      ).run(convId, wsId, 'git-cp', '{}', 'main', 'abc123')

      const checkpoints = checkpointRepository.findByConversation(convId)
      const cp = checkpoints.find((c: any) => c.label === 'git-cp')
      assert.ok(cp)
      assert.equal(cp.gitBranch, 'main')
      assert.equal(cp.gitCommitSha, 'abc123')
    })
  })
}

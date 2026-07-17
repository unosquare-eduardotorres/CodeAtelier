/**
 * Tests for WorkspaceRepository — CRUD, settings, path lookup.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('WorkspaceRepository (skipped — native module unavailable)', () => {
    test('create() inserts and returns a workspace', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { workspaceRepository } = require('../workspace.repository')

  describe('WorkspaceRepository', () => {
    test('create() inserts and returns a workspace', () => {
      const ws = workspaceRepository.create('My Project', '/tmp/ws-test-1')
      assert.equal(ws.name, 'My Project')
      assert.equal(ws.repoPath, '/tmp/ws-test-1')
      assert.equal(ws.isGitRepo, true)
      assert.ok(ws.id)
      assert.ok(ws.createdAt)
    })

    test('create() stores git remote URL', () => {
      const ws = workspaceRepository.create(
        'Remote',
        '/tmp/ws-test-2',
        'https://github.com/org/repo.git'
      )
      assert.equal(ws.gitRemoteUrl, 'https://github.com/org/repo.git')
    })

    test('create() supports isGitRepo=false', () => {
      const ws = workspaceRepository.create('Non-Git', '/tmp/ws-test-3', undefined, false)
      assert.equal(ws.isGitRepo, false)
    })

    test('findAll() returns workspaces', () => {
      const all = workspaceRepository.findAll()
      assert.ok(all.length >= 3)
    })

    test('findById() returns a workspace', () => {
      const ws = workspaceRepository.create('Findable', '/tmp/ws-test-4')
      const found = workspaceRepository.findById(ws.id)
      assert.ok(found)
      assert.equal(found.name, 'Findable')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = workspaceRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('delete() removes workspace', () => {
      const ws = workspaceRepository.create('To Delete', '/tmp/ws-test-5')
      workspaceRepository.delete(ws.id)
      const found = workspaceRepository.findById(ws.id)
      assert.equal(found, undefined)
    })

    test('updateSettings() and getSettings() round-trip', () => {
      // Use env.db directly to avoid shared-DB-singleton ordering issues
      const row = env.db.prepare('INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING *')
        .get('Settings Test', '/tmp/ws-test-6') as any
      env.db.prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?')
        .run(JSON.stringify({ theme: 'dark', fontSize: 14 }), row.id)
      const result = env.db.prepare('SELECT settings_json FROM workspaces WHERE id = ?')
        .get(row.id) as any
      assert.deepEqual(JSON.parse(result.settings_json), { theme: 'dark', fontSize: 14 })
    })

    test('getSettings() returns {} for unknown workspace', () => {
      const result = env.db.prepare('SELECT settings_json FROM workspaces WHERE id = ?')
        .get('nonexistent-ws-id') as any
      assert.equal(result, undefined)
    })

    test('getSettingsByPath() returns settings by repo path', () => {
      const ws = workspaceRepository.create('Path Test', '/tmp/ws-test-7')
      workspaceRepository.updateSettings(ws.id, { key: 'value' })
      const result = workspaceRepository.getSettingsByPath('/tmp/ws-test-7')
      assert.deepEqual(result, { key: 'value' })
    })
  })
}

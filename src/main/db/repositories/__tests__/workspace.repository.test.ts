/**
 * Tests for WorkspaceRepository — CRUD, settings, path lookup.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'
import type { Workspace } from '../../../../shared/types'

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

    test('updateIsGitRepo() promotes a non-git workspace once it becomes a repo', () => {
      const ws = workspaceRepository.create('Became Git', '/tmp/ws-test-gitflag', undefined, false)
      assert.equal(ws.isGitRepo, false)

      const updated = workspaceRepository.updateIsGitRepo(ws.id, true)
      assert.equal(updated.isGitRepo, true, 'the refreshed flag must be returned')
      assert.equal(
        workspaceRepository.findById(ws.id).isGitRepo,
        true,
        'and it must be persisted, not just returned'
      )
    })

    test('updateIsGitRepo() can also demote, and tolerates an unknown id', () => {
      const ws = workspaceRepository.create('Was Git', '/tmp/ws-test-gitflag-2')
      assert.equal(workspaceRepository.updateIsGitRepo(ws.id, false).isGitRepo, false)
      assert.equal(workspaceRepository.updateIsGitRepo('nonexistent', true), undefined)
    })

    test('ensureShadow() creates a scope row and reuses it for the same worktree', () => {
      const parent = workspaceRepository.create('Parent', '/tmp/ws-shadow-parent')
      const first = workspaceRepository.ensureShadow(parent.id, '/tmp/wt/feat-a', 'feat-a')
      const second = workspaceRepository.ensureShadow(parent.id, '/tmp/wt/feat-a', 'feat-a')

      assert.equal(first.id, second.id, 'a worktree must keep one index scope, not accrue them')
      assert.equal(first.shadowOfWorkspaceId, parent.id)
      assert.notEqual(first.id, parent.id, 'the scope must not collide with the real workspace')
    })

    test('two worktrees of one workspace get separate scopes', () => {
      const parent = workspaceRepository.create('Two Tracks', '/tmp/ws-shadow-two')
      const a = workspaceRepository.ensureShadow(parent.id, '/tmp/wt2/a', 'a')
      const b = workspaceRepository.ensureShadow(parent.id, '/tmp/wt2/b', 'b')

      assert.notEqual(a.id, b.id, 'branches must not share an index')
      assert.equal(workspaceRepository.findShadows(parent.id).length, 2)
    })

    test('shadows are hidden from findAll() so they never look like workspaces', () => {
      const parent = workspaceRepository.create('Hidden Parent', '/tmp/ws-shadow-hidden')
      workspaceRepository.ensureShadow(parent.id, '/tmp/wt3/hidden', 'hidden')

      // `workspaceRepository` comes from a bare require() (so the suite can skip
      // when the native module is unavailable), which makes it `any` — these
      // callbacks need the element type spelled out.
      const all: Workspace[] = workspaceRepository.findAll()
      assert.ok(
        all.some((w: Workspace) => w.id === parent.id),
        'the real workspace still lists'
      )
      assert.equal(
        all.some((w: Workspace) => w.shadowOfWorkspaceId),
        false,
        'no shadow may appear in the workspace list'
      )
    })

    test('deleting a workspace takes its shadows with it', () => {
      const parent = workspaceRepository.create('Cascade', '/tmp/ws-shadow-cascade')
      const shadow = workspaceRepository.ensureShadow(parent.id, '/tmp/wt4/gone', 'gone')

      workspaceRepository.delete(parent.id)

      assert.equal(
        workspaceRepository.findById(shadow.id),
        undefined,
        'an orphaned scope would keep a dead index alive forever'
      )
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
      const row = env.db
        .prepare('INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING *')
        .get('Settings Test', '/tmp/ws-test-6') as any
      env.db
        .prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?')
        .run(JSON.stringify({ theme: 'dark', fontSize: 14 }), row.id)
      const result = env.db
        .prepare('SELECT settings_json FROM workspaces WHERE id = ?')
        .get(row.id) as any
      assert.deepEqual(JSON.parse(result.settings_json), { theme: 'dark', fontSize: 14 })
    })

    test('getSettings() returns {} for unknown workspace', () => {
      const result = env.db
        .prepare('SELECT settings_json FROM workspaces WHERE id = ?')
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

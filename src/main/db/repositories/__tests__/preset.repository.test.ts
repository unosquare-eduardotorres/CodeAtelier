/**
 * Tests for PresetRepository — CRUD for LLM configuration presets.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('PresetRepository (skipped — native module unavailable)', () => {
    test('create() inserts preset', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { presetRepository } = require('../preset.repository')

  describe('PresetRepository', () => {
    // ── create ──

    test('create() inserts custom preset and returns it', () => {
      const preset = presetRepository.create(wsId, 'My Preset', { chat: { provider: 'claude' } })
      assert.ok(preset.id)
      assert.equal(preset.workspaceId, wsId)
      assert.equal(preset.name, 'My Preset')
      assert.equal(preset.isBuiltIn, false)
      assert.deepEqual(preset.actionConfig, { chat: { provider: 'claude' } })
      assert.ok(preset.createdAt)
    })

    test('create() stores empty actionConfig', () => {
      const preset = presetRepository.create(wsId, 'Empty Config', {})
      assert.deepEqual(preset.actionConfig, {})
    })

    // ── getAll ──

    test('getAll() returns presets for workspace', () => {
      const all = presetRepository.getAll(wsId)
      assert.ok(all.length >= 1)
      assert.ok(all.every((p: any) => p.workspaceId === wsId))
    })

    test('getAll() returns [] for unknown workspace', () => {
      const all = presetRepository.getAll('nonexistent-workspace')
      assert.equal(all.length, 0)
    })

    // ── getById ──

    test('getById() returns preset', () => {
      const created = presetRepository.create(wsId, 'GetById Test', {})
      const found = presetRepository.getById(created.id)
      assert.ok(found)
      assert.equal(found.name, 'GetById Test')
    })

    test('getById() returns null for unknown id', () => {
      const found = presetRepository.getById('nonexistent')
      assert.equal(found, null)
    })

    // ── update ──

    test('update() modifies name', () => {
      const preset = presetRepository.create(wsId, 'Old Name', {})
      const updated = presetRepository.update(preset.id, { name: 'New Name' })
      assert.ok(updated)
      assert.equal(updated.name, 'New Name')
    })

    test('update() modifies actionConfig', () => {
      const preset = presetRepository.create(wsId, 'Config Update', {})
      const updated = presetRepository.update(preset.id, {
        actionConfig: { plan: { provider: 'local' } }
      })
      assert.ok(updated)
      assert.deepEqual(updated.actionConfig, { plan: { provider: 'local' } })
    })

    test('update() returns null for unknown id', () => {
      const result = presetRepository.update('nonexistent', { name: 'X' })
      assert.equal(result, null)
    })

    test('update() returns null for built-in preset', () => {
      presetRepository.ensureBuiltIns(wsId)
      const all = presetRepository.getAll(wsId)
      const builtIn = all.find((p: any) => p.isBuiltIn)
      if (builtIn) {
        const result = presetRepository.update(builtIn.id, { name: 'Hacked' })
        assert.equal(result, null)
      }
    })

    // ── delete ──

    test('delete() removes custom preset', () => {
      const preset = presetRepository.create(wsId, 'To Delete', {})
      const deleted = presetRepository.delete(preset.id)
      assert.equal(deleted, true)
      const found = presetRepository.getById(preset.id)
      assert.equal(found, null)
    })

    test('delete() returns false for unknown id', () => {
      const deleted = presetRepository.delete('nonexistent')
      assert.equal(deleted, false)
    })

    test('delete() refuses to delete built-in preset', () => {
      presetRepository.ensureBuiltIns(wsId)
      const all = presetRepository.getAll(wsId)
      const builtIn = all.find((p: any) => p.isBuiltIn)
      if (builtIn) {
        const deleted = presetRepository.delete(builtIn.id)
        assert.equal(deleted, false)
        const still = presetRepository.getById(builtIn.id)
        assert.ok(still)
      }
    })

    // ── ensureBuiltIns ──

    test('ensureBuiltIns() creates Full Claude and Full Local presets', () => {
      // Use a fresh workspace to avoid interference
      const freshWsId = 'preset-builtins-test'
      env.db
        .prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`)
        .run(freshWsId, 'BuiltIn Test', '/tmp/builtin-test')

      presetRepository.ensureBuiltIns(freshWsId)
      const all = presetRepository.getAll(freshWsId)
      const names = all.map((p: any) => p.name)
      assert.ok(names.includes('Full Claude'))
      assert.ok(names.includes('Full Local'))
      assert.ok(all.filter((p: any) => p.isBuiltIn).length >= 2)
    })

    test('ensureBuiltIns() is idempotent', () => {
      const freshWsId = 'preset-idempotent-test'
      env.db
        .prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`)
        .run(freshWsId, 'Idempotent Test', '/tmp/idempotent-test')

      presetRepository.ensureBuiltIns(freshWsId)
      presetRepository.ensureBuiltIns(freshWsId)
      const all = presetRepository.getAll(freshWsId)
      const builtIns = all.filter((p: any) => p.isBuiltIn)
      assert.equal(builtIns.length, 2)
    })
  })
}

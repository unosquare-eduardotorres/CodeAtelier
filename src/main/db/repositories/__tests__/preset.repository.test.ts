/**
 * Unit tests for PresetRepository — CRUD for named LLM configuration presets.
 * Tests built-in vs custom preset semantics, ordering, JSON config round-trips,
 * and the ensureBuiltIns idempotency guarantee.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('PresetRepository (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { presetRepository } = require('../preset.repository')
  const { wsId, db } = env

  describe('PresetRepository', () => {
    // ── getAll ──

    test('getAll() returns empty array for fresh workspace', () => {
      const freshWs = db
        .prepare("INSERT INTO workspaces (name, path) VALUES ('fresh', '/tmp/fresh') RETURNING id")
        .get() as { id: string }
      const presets = presetRepository.getAll(freshWs.id)
      assert.deepEqual(presets, [])
    })

    test('getAll() returns built-in first, then custom by name', () => {
      presetRepository.ensureBuiltIns(wsId)
      presetRepository.create(wsId, 'Zulu Custom', {})
      presetRepository.create(wsId, 'Alpha Custom', {})

      const all = presetRepository.getAll(wsId)
      assert.ok(all.length >= 4, 'should have ≥4 presets')

      // Built-ins first (is_built_in=1 DESC), then custom alphabetical
      const builtInCount = all.filter((p: any) => p.isBuiltIn).length
      assert.ok(builtInCount >= 2, 'should have ≥2 built-in presets')

      // All built-ins should come before custom
      const firstCustomIdx = all.findIndex((p: any) => !p.isBuiltIn)
      const lastBuiltInIdx = all.length - 1 - [...all].reverse().findIndex((p: any) => p.isBuiltIn)
      if (firstCustomIdx >= 0) {
        assert.ok(firstCustomIdx > lastBuiltInIdx, 'built-ins should precede custom presets')
      }

      // Custom presets should be alphabetical
      const customs = all.filter((p: any) => !p.isBuiltIn)
      for (let i = 1; i < customs.length; i++) {
        assert.ok(
          customs[i].name >= customs[i - 1].name,
          `custom presets should be alphabetical: "${customs[i - 1].name}" before "${customs[i].name}"`
        )
      }
    })

    // ── getById / create ──

    test('create() + getById() round-trip', () => {
      const preset = presetRepository.create(wsId, 'Round Trip', { plan: { model: 'haiku' } })
      assert.equal(preset.name, 'Round Trip')
      assert.equal(preset.isBuiltIn, false)
      assert.deepEqual(preset.actionConfig, { plan: { model: 'haiku' } })

      const fetched = presetRepository.getById(preset.id)
      assert.ok(fetched, 'getById should find the preset')
      assert.equal(fetched.id, preset.id)
      assert.equal(fetched.name, 'Round Trip')
      assert.deepEqual(fetched.actionConfig, { plan: { model: 'haiku' } })
    })

    test('getById() returns null for unknown id', () => {
      assert.equal(presetRepository.getById('nonexistent-preset-id'), null)
    })

    test('create() stores actionConfig JSON correctly', () => {
      const config = {
        plan: { model: 'claude-sonnet-4-6', maxTokens: 4096 },
        build: { model: 'claude-opus-4-7' }
      }
      const preset = presetRepository.create(wsId, 'Config Test', config)
      assert.deepEqual(preset.actionConfig, config)
    })

    // ── update ──

    test('update() changes name for custom preset', () => {
      const preset = presetRepository.create(wsId, 'Old Name', {})
      const updated = presetRepository.update(preset.id, { name: 'New Name' })
      assert.ok(updated, 'update should return the updated preset')
      assert.equal(updated.name, 'New Name')
    })

    test('update() changes actionConfig', () => {
      const preset = presetRepository.create(wsId, 'Config Update', {})
      const newConfig = { plan: { model: 'opus' } }
      const updated = presetRepository.update(preset.id, { actionConfig: newConfig })
      assert.ok(updated)
      assert.deepEqual(updated.actionConfig, newConfig)
    })

    test('update() returns null for unknown id', () => {
      assert.equal(presetRepository.update('nonexistent-id', { name: 'x' }), null)
    })

    test('update() ignores name change for built-in preset', () => {
      presetRepository.ensureBuiltIns(wsId)
      const builtIn = presetRepository.getBuiltIn(wsId, 'Full Claude')
      assert.ok(builtIn, 'built-in should exist')

      const updated = presetRepository.update(builtIn.id, { name: 'Renamed' })
      assert.ok(updated)
      assert.equal(updated.name, 'Full Claude', 'built-in name should not change')
    })

    test('update() allows actionConfig change on built-in preset', () => {
      const builtIn = presetRepository.getBuiltIn(wsId, 'Full Claude')
      assert.ok(builtIn)

      const newConfig = { build: { model: 'sonnet' } }
      const updated = presetRepository.update(builtIn.id, { actionConfig: newConfig })
      assert.ok(updated)
      assert.deepEqual(updated.actionConfig, newConfig)
    })

    // ── delete ──

    test('delete() removes custom preset, returns true', () => {
      const preset = presetRepository.create(wsId, 'To Delete', {})
      assert.equal(presetRepository.delete(preset.id), true)
      assert.equal(presetRepository.getById(preset.id), null)
    })

    test('delete() returns false for built-in preset', () => {
      const builtIn = presetRepository.getBuiltIn(wsId, 'Full Local')
      assert.ok(builtIn, 'built-in should exist')
      assert.equal(presetRepository.delete(builtIn.id), false)
      assert.ok(presetRepository.getById(builtIn.id), 'built-in should still exist after delete attempt')
    })

    test('delete() returns false for unknown id', () => {
      assert.equal(presetRepository.delete('nonexistent-id'), false)
    })

    // ── getBuiltIn ──

    test('getBuiltIn() returns matching built-in preset', () => {
      const builtIn = presetRepository.getBuiltIn(wsId, 'Full Claude')
      assert.ok(builtIn)
      assert.equal(builtIn.name, 'Full Claude')
      assert.equal(builtIn.isBuiltIn, true)
    })

    test('getBuiltIn() returns null when no built-in exists', () => {
      const freshWs = db
        .prepare("INSERT INTO workspaces (name, path) VALUES ('empty', '/tmp/empty') RETURNING id")
        .get() as { id: string }
      assert.equal(presetRepository.getBuiltIn(freshWs.id, 'Full Claude'), null)
    })

    // ── ensureBuiltIns ──

    test('ensureBuiltIns() creates Full Claude and Full Local', () => {
      const ws = db
        .prepare("INSERT INTO workspaces (name, path) VALUES ('builtins', '/tmp/builtins') RETURNING id")
        .get() as { id: string }

      presetRepository.ensureBuiltIns(ws.id)

      const claude = presetRepository.getBuiltIn(ws.id, 'Full Claude')
      const local = presetRepository.getBuiltIn(ws.id, 'Full Local')
      assert.ok(claude, 'Full Claude should exist')
      assert.ok(local, 'Full Local should exist')
      assert.equal(claude.isBuiltIn, true)
      assert.equal(local.isBuiltIn, true)
    })

    test('ensureBuiltIns() is idempotent — second call does not duplicate', () => {
      const ws = db
        .prepare("INSERT INTO workspaces (name, path) VALUES ('idem', '/tmp/idem') RETURNING id")
        .get() as { id: string }

      presetRepository.ensureBuiltIns(ws.id)
      presetRepository.ensureBuiltIns(ws.id) // second call

      const all = presetRepository.getAll(ws.id)
      const builtIns = all.filter((p: any) => p.isBuiltIn)
      assert.equal(builtIns.length, 2, 'should still have exactly 2 built-in presets')
    })
  })
}

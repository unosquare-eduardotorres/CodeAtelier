/**
 * Tests for SkillRepository — CRUD, active toggle, summaries, tiers, enrichment.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('SkillRepository (skipped — native module unavailable)', () => {
    test('create() inserts skill', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { skillRepository } = require('../skill.repository')

  describe('SkillRepository', () => {
    // ── create ──

    test('create() inserts and returns skill with all fields', () => {
      const sk = skillRepository.create({
        name: 'React Hooks',
        description: 'Patterns for React hooks',
        filename: 'react-hooks.md',
        filePath: '/skills/react-hooks.md',
        isActive: true,
        lastUpdatedDate: '2025-01-01',
        tier1Json: '{"key":"val"}',
        tier2Instructions: 'Use hooks wisely'
      })
      assert.ok(sk.id)
      assert.equal(sk.name, 'React Hooks')
      assert.equal(sk.description, 'Patterns for React hooks')
      assert.equal(sk.filename, 'react-hooks.md')
      assert.equal(sk.filePath, '/skills/react-hooks.md')
      assert.equal(sk.isActive, true)
      assert.equal(sk.lastUpdatedDate, '2025-01-01')
      assert.equal(sk.tier1Json, '{"key":"val"}')
      assert.equal(sk.tier2Instructions, 'Use hooks wisely')
    })

    test('create() applies defaults for optional fields', () => {
      const sk = skillRepository.create({
        name: 'Defaults',
        filename: 'defaults.md',
        filePath: '/skills/defaults.md'
      })
      assert.equal(sk.description, '')
      assert.equal(sk.isActive, true) // isActive defaults to true (isActive !== false)
      assert.equal(sk.lastUpdatedDate, null)
      assert.equal(sk.tier1Json, null)
      assert.equal(sk.tier2Instructions, null)
    })

    // ── findAll ──

    test('findAll() returns skills sorted by name ASC', () => {
      // Clean: delete all then create known set
      skillRepository.deleteAll()
      skillRepository.create({ name: 'Zulu', filename: 'z.md', filePath: '/z.md' })
      skillRepository.create({ name: 'Alpha', filename: 'a.md', filePath: '/a.md' })
      const all = skillRepository.findAll()
      assert.ok(all.length >= 2)
      assert.equal(all[0].name, 'Alpha')
    })

    // ── findById ──

    test('findById() returns skill', () => {
      const sk = skillRepository.create({ name: 'Find Me', filename: 'find.md', filePath: '/f.md' })
      const found = skillRepository.findById(sk.id)
      assert.ok(found)
      assert.equal(found.name, 'Find Me')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = skillRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    // ── findByFilename ──

    test('findByFilename() returns skill by filename', () => {
      skillRepository.create({
        name: 'File Lookup',
        filename: 'unique-file.md',
        filePath: '/skills/unique-file.md'
      })
      const found = skillRepository.findByFilename('unique-file.md')
      assert.ok(found)
      assert.equal(found.name, 'File Lookup')
    })

    test('findByFilename() returns undefined for unknown filename', () => {
      const found = skillRepository.findByFilename('no-such-file.md')
      assert.equal(found, undefined)
    })

    // ── findActive ──

    test('findActive() returns only active skills', () => {
      skillRepository.deleteAll()
      skillRepository.create({ name: 'Active', filename: 'act.md', filePath: '/act.md', isActive: true })
      skillRepository.create({ name: 'Inactive', filename: 'inact.md', filePath: '/inact.md', isActive: false })
      const active = skillRepository.findActive()
      assert.equal(active.length, 1)
      assert.equal(active[0].name, 'Active')
    })

    // ── update ──

    test('update() modifies name and description', () => {
      const sk = skillRepository.create({ name: 'Old Name', filename: 'upd.md', filePath: '/u.md' })
      const updated = skillRepository.update(sk.id, {
        name: 'New Name',
        description: 'New desc'
      })
      assert.equal(updated.name, 'New Name')
      assert.equal(updated.description, 'New desc')
    })

    test('update() with empty input returns existing skill', () => {
      const sk = skillRepository.create({ name: 'NoOp', filename: 'noop.md', filePath: '/n.md' })
      const result = skillRepository.update(sk.id, {})
      assert.equal(result.name, 'NoOp')
    })

    test('update() throws for unknown id', () => {
      assert.throws(() => skillRepository.update('nonexistent', { name: 'X' }), {
        message: /not found/i
      })
    })

    // ── delete ──

    test('delete() removes skill', () => {
      const sk = skillRepository.create({ name: 'ToDelete', filename: 'del.md', filePath: '/d.md' })
      skillRepository.delete(sk.id)
      const found = skillRepository.findById(sk.id)
      assert.equal(found, undefined)
    })

    // ── setActive ──

    test('setActive() toggles active flag', () => {
      const sk = skillRepository.create({
        name: 'Toggle',
        filename: 'tog.md',
        filePath: '/tog.md',
        isActive: true
      })
      const deactivated = skillRepository.setActive(sk.id, false)
      assert.equal(deactivated.isActive, false)
      const reactivated = skillRepository.setActive(sk.id, true)
      assert.equal(reactivated.isActive, true)
    })

    test('setActive() throws for unknown id', () => {
      assert.throws(() => skillRepository.setActive('nonexistent', true), {
        message: /not found/i
      })
    })

    // ── updateSummaries ──

    test('updateSummaries() stores summary fields', () => {
      const sk = skillRepository.create({
        name: 'Summary',
        filename: 'sum.md',
        filePath: '/sum.md'
      })
      skillRepository.updateSummaries(sk.id, {
        full: 'Full text',
        standard: 'Standard text',
        minimal: 'Minimal text',
        hash: 'abc123'
      })
      const found = skillRepository.findById(sk.id)
      assert.ok(found)
      assert.equal(found.summaryFull, 'Full text')
      assert.equal(found.summaryStandard, 'Standard text')
      assert.equal(found.summaryMinimal, 'Minimal text')
      assert.equal(found.summaryHash, 'abc123')
    })

    // ── updateTiers ──

    test('updateTiers() stores tier1/tier2 data', () => {
      const sk = skillRepository.create({
        name: 'Tiers',
        filename: 'tier.md',
        filePath: '/tier.md'
      })
      skillRepository.updateTiers(sk.id, '{"tier":"1"}', 'tier2 instructions')
      const found = skillRepository.findById(sk.id)
      assert.ok(found)
      assert.equal(found.tier1Json, '{"tier":"1"}')
      assert.equal(found.tier2Instructions, 'tier2 instructions')
    })

    // ── updateEnrichment ──

    test('updateEnrichment() stores enrichment JSON', () => {
      const sk = skillRepository.create({
        name: 'Enrich',
        filename: 'enrich.md',
        filePath: '/enrich.md'
      })
      skillRepository.updateEnrichment(sk.id, '{"enriched":true}')
      const found = skillRepository.findById(sk.id)
      assert.ok(found)
      assert.equal(found.enrichmentJson, '{"enriched":true}')
    })

    // ── getSummary ──

    test('getSummary() returns correct tier summary', () => {
      const sk = skillRepository.create({
        name: 'GetSum',
        filename: 'getsum.md',
        filePath: '/getsum.md'
      })
      skillRepository.updateSummaries(sk.id, {
        full: 'FULL',
        standard: 'STANDARD',
        minimal: 'MINIMAL',
        hash: 'h'
      })
      assert.equal(skillRepository.getSummary(sk.id, 'full'), 'FULL')
      assert.equal(skillRepository.getSummary(sk.id, 'standard'), 'STANDARD')
      assert.equal(skillRepository.getSummary(sk.id, 'minimal'), 'MINIMAL')
    })

    test('getSummary() returns null for skill without summaries', () => {
      const sk = skillRepository.create({
        name: 'NoSum',
        filename: 'nosum.md',
        filePath: '/nosum.md'
      })
      assert.equal(skillRepository.getSummary(sk.id, 'full'), null)
    })

    test('getSummary() returns null for unknown skill', () => {
      assert.equal(skillRepository.getSummary('nonexistent', 'full'), null)
    })

    // ── deleteAll ──

    test('deleteAll() removes all skills and associations', () => {
      skillRepository.create({ name: 'DA', filename: 'da.md', filePath: '/da.md' })
      skillRepository.deleteAll()
      const all = skillRepository.findAll()
      assert.equal(all.length, 0)
    })
  })
}

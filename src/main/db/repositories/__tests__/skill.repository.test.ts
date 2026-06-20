/**
 * Tests for SkillRepository — CRUD, active/inactive toggle, summaries, tiers, enrichment.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('SkillRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { skillRepository } = require('../skill.repository')

  describe('SkillRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const skill = skillRepository.create({
        name: 'Test Skill',
        filename: 'test-skill.md',
        filePath: '/skills/test-skill.md'
      })
      assert.ok(skill.id)
      assert.equal(skill.name, 'Test Skill')
      assert.equal(skill.description, '')
      assert.equal(skill.filename, 'test-skill.md')
      assert.equal(skill.filePath, '/skills/test-skill.md')
      assert.equal(skill.isActive, true) // default is true (isActive !== false)
    })

    test('create() respects isActive=false', () => {
      const skill = skillRepository.create({
        name: 'Inactive Skill',
        filename: 'inactive.md',
        filePath: '/skills/inactive.md',
        isActive: false
      })
      assert.equal(skill.isActive, false)
    })

    test('create() accepts tier data', () => {
      const skill = skillRepository.create({
        name: 'Tiered Skill',
        filename: 'tiered.md',
        filePath: '/skills/tiered.md',
        tier1Json: '{"overview": "brief"}',
        tier2Instructions: 'Detailed instructions'
      })
      assert.equal(skill.tier1Json, '{"overview": "brief"}')
      assert.equal(skill.tier2Instructions, 'Detailed instructions')
    })

    test('findById() round-trip', () => {
      const created = skillRepository.create({
        name: 'Findable', filename: 'find.md', filePath: '/skills/find.md'
      })
      const found = skillRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.name, 'Findable')
    })

    test('findById() returns undefined for unknown', () => {
      const found = skillRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('findByFilename() looks up by filename', () => {
      skillRepository.create({
        name: 'By Filename', filename: 'unique-file.md', filePath: '/skills/unique-file.md'
      })
      const found = skillRepository.findByFilename('unique-file.md')
      assert.ok(found)
      assert.equal(found.name, 'By Filename')
    })

    test('findAll() returns all skills', () => {
      const all = skillRepository.findAll()
      assert.ok(all.length > 0)
    })

    test('findActive() filters to active skills', () => {
      const active = skillRepository.findActive()
      assert.ok(active.every((s: any) => s.isActive === true))
    })

    test('update() modifies name and description', () => {
      const skill = skillRepository.create({
        name: 'Old Name', filename: 'upd.md', filePath: '/skills/upd.md'
      })
      const updated = skillRepository.update(skill.id, {
        name: 'New Name', description: 'New desc'
      })
      assert.equal(updated.name, 'New Name')
      assert.equal(updated.description, 'New desc')
    })

    test('update() with empty data returns existing', () => {
      const skill = skillRepository.create({
        name: 'No Change', filename: 'noop.md', filePath: '/skills/noop.md'
      })
      const result = skillRepository.update(skill.id, {})
      assert.equal(result.name, 'No Change')
    })

    test('update() throws for nonexistent id', () => {
      assert.throws(() => skillRepository.update('nonexistent', { name: 'X' }), /not found/i)
    })

    test('setActive() toggles active state', () => {
      const skill = skillRepository.create({
        name: 'Toggle', filename: 'toggle.md', filePath: '/skills/toggle.md'
      })
      const deactivated = skillRepository.setActive(skill.id, false)
      assert.equal(deactivated.isActive, false)

      const activated = skillRepository.setActive(skill.id, true)
      assert.equal(activated.isActive, true)
    })

    test('setActive() throws for nonexistent id', () => {
      assert.throws(() => skillRepository.setActive('nonexistent', true), /not found/i)
    })

    test('updateSummaries() stores all summary tiers', () => {
      const skill = skillRepository.create({
        name: 'Summary Skill', filename: 'sum.md', filePath: '/skills/sum.md'
      })
      skillRepository.updateSummaries(skill.id, {
        full: 'Full summary text',
        standard: 'Standard summary',
        minimal: 'Minimal',
        hash: 'abc123'
      })
      const found = skillRepository.findById(skill.id)
      assert.equal(found!.summaryFull, 'Full summary text')
      assert.equal(found!.summaryStandard, 'Standard summary')
      assert.equal(found!.summaryMinimal, 'Minimal')
      assert.equal(found!.summaryHash, 'abc123')
    })

    test('getSummary() returns correct tier', () => {
      const skill = skillRepository.create({
        name: 'Get Summary', filename: 'getsum.md', filePath: '/skills/getsum.md'
      })
      skillRepository.updateSummaries(skill.id, {
        full: 'FULL', standard: 'STD', minimal: 'MIN', hash: 'h'
      })
      assert.equal(skillRepository.getSummary(skill.id, 'full'), 'FULL')
      assert.equal(skillRepository.getSummary(skill.id, 'standard'), 'STD')
      assert.equal(skillRepository.getSummary(skill.id, 'minimal'), 'MIN')
    })

    test('getSummary() returns null for unknown skill', () => {
      assert.equal(skillRepository.getSummary('nonexistent', 'full'), null)
    })

    test('updateTiers() stores tier1/tier2 data', () => {
      const skill = skillRepository.create({
        name: 'Tier Skill', filename: 'tier.md', filePath: '/skills/tier.md'
      })
      skillRepository.updateTiers(skill.id, '{"tier1": true}', 'tier2 instructions')
      const found = skillRepository.findById(skill.id)
      assert.equal(found!.tier1Json, '{"tier1": true}')
      assert.equal(found!.tier2Instructions, 'tier2 instructions')
    })

    test('updateEnrichment() stores enrichment JSON', () => {
      const skill = skillRepository.create({
        name: 'Enriched', filename: 'enriched.md', filePath: '/skills/enriched.md'
      })
      skillRepository.updateEnrichment(skill.id, '{"enriched": true}')
      const found = skillRepository.findById(skill.id)
      assert.equal(found!.enrichmentJson, '{"enriched": true}')
    })

    test('delete() removes skill', () => {
      const skill = skillRepository.create({
        name: 'Delete Me', filename: 'del.md', filePath: '/skills/del.md'
      })
      skillRepository.delete(skill.id)
      assert.equal(skillRepository.findById(skill.id), undefined)
    })

    // ── Phase 6C: Untested methods ──

    test('deleteAll() removes all skills and specialist_skills rows', () => {
      // Ensure there's at least one skill
      skillRepository.create({
        name: 'Bulk Delete Skill', filename: 'bulk.md', filePath: '/skills/bulk.md'
      })
      assert.ok(skillRepository.findAll().length > 0)

      skillRepository.deleteAll()
      assert.deepEqual(skillRepository.findAll(), [])
    })
  })
}

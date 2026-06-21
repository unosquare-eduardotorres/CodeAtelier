/**
 * Tests for SpecialistRepository — CRUD, skill associations, reorder, canDelete.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('SpecialistRepository (skipped — native module unavailable)', () => {
    test('create() inserts and returns specialist', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { specialistRepository } = require('../specialist.repository')
  const { skillRepository } = require('../skill.repository')

  describe('SpecialistRepository', () => {
    // ── create ──

    test('create() inserts and returns specialist with all fields', () => {
      const s = specialistRepository.create({
        agentId: 'agent-1',
        displayName: 'Builder',
        description: 'Builds things',
        icon: '🔨',
        color: '#FF0000',
        prompt: 'You are a builder',
        priority: 10,
        isActive: true
      })
      assert.ok(s.id)
      assert.equal(s.agentId, 'agent-1')
      assert.equal(s.displayName, 'Builder')
      assert.equal(s.description, 'Builds things')
      assert.equal(s.icon, '🔨')
      assert.equal(s.color, '#FF0000')
      assert.equal(s.prompt, 'You are a builder')
      assert.equal(s.priority, 10)
      assert.equal(s.isActive, true)
    })

    test('create() applies defaults for optional fields', () => {
      const s = specialistRepository.create({
        agentId: 'agent-defaults',
        displayName: 'Defaults'
      })
      assert.equal(s.icon, '🔧')
      assert.equal(s.color, '#6366F1')
      assert.equal(s.prompt, '')
      assert.equal(s.priority, 100)
      assert.equal(s.isActive, false)
    })

    // ── findAll ──

    test('findAll() returns specialists sorted by priority ASC', () => {
      // Clean slate
      specialistRepository.deleteAll()
      specialistRepository.create({ agentId: 'low', displayName: 'Low', priority: 50 })
      specialistRepository.create({ agentId: 'high', displayName: 'High', priority: 1 })
      const all = specialistRepository.findAll()
      assert.ok(all.length >= 2)
      assert.equal(all[0].displayName, 'High')
    })

    // ── findById ──

    test('findById() returns specialist', () => {
      const created = specialistRepository.create({
        agentId: 'find-test',
        displayName: 'Findable'
      })
      const found = specialistRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.displayName, 'Findable')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = specialistRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    // ── findByAgentId ──

    test('findByAgentId() returns specialist by agentId', () => {
      specialistRepository.create({ agentId: 'unique-agent', displayName: 'Agent Find' })
      const found = specialistRepository.findByAgentId('unique-agent')
      assert.ok(found)
      assert.equal(found.displayName, 'Agent Find')
    })

    test('findByAgentId() returns undefined for unknown agentId', () => {
      const found = specialistRepository.findByAgentId('no-such-agent')
      assert.equal(found, undefined)
    })

    // ── findActive ──

    test('findActive() returns only active specialists', () => {
      specialistRepository.deleteAll()
      specialistRepository.create({ agentId: 'active-1', displayName: 'A', isActive: true })
      specialistRepository.create({ agentId: 'inactive-1', displayName: 'B', isActive: false })
      const active = specialistRepository.findActive()
      assert.equal(active.length, 1)
      assert.equal(active[0].displayName, 'A')
    })

    // ── update ──

    test('update() modifies specified fields', () => {
      const s = specialistRepository.create({ agentId: 'upd-1', displayName: 'Original' })
      const updated = specialistRepository.update(s.id, {
        displayName: 'Updated',
        description: 'New desc',
        icon: '🚀',
        color: '#00FF00',
        prompt: 'New prompt',
        priority: 5,
        isActive: true,
        alias: 'my-alias',
        avatarUrl: 'https://example.com/avatar.png'
      })
      assert.equal(updated.displayName, 'Updated')
      assert.equal(updated.description, 'New desc')
      assert.equal(updated.icon, '🚀')
      assert.equal(updated.color, '#00FF00')
      assert.equal(updated.prompt, 'New prompt')
      assert.equal(updated.priority, 5)
      assert.equal(updated.isActive, true)
      assert.equal(updated.alias, 'my-alias')
      assert.equal(updated.avatarUrl, 'https://example.com/avatar.png')
    })

    test('update() with no fields returns existing specialist', () => {
      const s = specialistRepository.create({ agentId: 'upd-noop', displayName: 'NoOp' })
      const result = specialistRepository.update(s.id, {})
      assert.equal(result.displayName, 'NoOp')
    })

    test('update() throws for unknown id', () => {
      assert.throws(() => specialistRepository.update('nonexistent', { displayName: 'X' }), {
        message: /not found/i
      })
    })

    // ── delete ──

    test('delete() removes specialist', () => {
      const s = specialistRepository.create({ agentId: 'del-1', displayName: 'ToDelete' })
      specialistRepository.delete(s.id)
      const found = specialistRepository.findById(s.id)
      assert.equal(found, undefined)
    })

    // ── skill associations ──

    test('assignSkill() and getSkills() round-trip', () => {
      const s = specialistRepository.create({
        agentId: 'skill-test',
        displayName: 'SkillTest',
        isActive: true
      })
      const sk = skillRepository.create({
        name: 'TypeScript',
        filename: 'ts.md',
        filePath: '/skills/ts.md',
        isActive: true
      })
      specialistRepository.assignSkill(s.id, sk.id)
      const skills = specialistRepository.getSkills(s.id)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'TypeScript')
    })

    test('getSkills() returns only active skills', () => {
      const s = specialistRepository.create({
        agentId: 'skill-active-test',
        displayName: 'SkillActiveTest'
      })
      const activeSk = skillRepository.create({
        name: 'Active Skill',
        filename: 'active.md',
        filePath: '/skills/active.md',
        isActive: true
      })
      const inactiveSk = skillRepository.create({
        name: 'Inactive Skill',
        filename: 'inactive.md',
        filePath: '/skills/inactive.md',
        isActive: false
      })
      specialistRepository.assignSkill(s.id, activeSk.id)
      specialistRepository.assignSkill(s.id, inactiveSk.id)
      const skills = specialistRepository.getSkills(s.id)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'Active Skill')
    })

    test('getAllSkills() returns active and inactive', () => {
      const s = specialistRepository.create({
        agentId: 'skill-all-test',
        displayName: 'AllSkillsTest'
      })
      const sk1 = skillRepository.create({
        name: 'All-Active',
        filename: 'a.md',
        filePath: '/skills/a.md',
        isActive: true
      })
      const sk2 = skillRepository.create({
        name: 'All-Inactive',
        filename: 'b.md',
        filePath: '/skills/b.md',
        isActive: false
      })
      specialistRepository.assignSkill(s.id, sk1.id)
      specialistRepository.assignSkill(s.id, sk2.id)
      const all = specialistRepository.getAllSkills(s.id)
      assert.equal(all.length, 2)
    })

    test('removeSkill() removes skill association', () => {
      const s = specialistRepository.create({
        agentId: 'rm-skill',
        displayName: 'RmSkill'
      })
      const sk = skillRepository.create({
        name: 'Removable',
        filename: 'rm.md',
        filePath: '/skills/rm.md'
      })
      specialistRepository.assignSkill(s.id, sk.id)
      specialistRepository.removeSkill(s.id, sk.id)
      const skills = specialistRepository.getAllSkills(s.id)
      assert.equal(skills.length, 0)
    })

    test('findSpecialistsForSkill() returns specialists assigned to a skill', () => {
      specialistRepository.deleteAll()
      const s1 = specialistRepository.create({ agentId: 'for-skill-1', displayName: 'S1' })
      const s2 = specialistRepository.create({ agentId: 'for-skill-2', displayName: 'S2' })
      const sk = skillRepository.create({
        name: 'Shared',
        filename: 'shared.md',
        filePath: '/skills/shared.md'
      })
      specialistRepository.assignSkill(s1.id, sk.id)
      specialistRepository.assignSkill(s2.id, sk.id)
      const specialists = specialistRepository.findSpecialistsForSkill(sk.id)
      assert.equal(specialists.length, 2)
    })

    // ── reorder ──

    test('reorderPriorities() updates priorities in order', () => {
      specialistRepository.deleteAll()
      const a = specialistRepository.create({ agentId: 'ord-a', displayName: 'A', priority: 99 })
      const b = specialistRepository.create({ agentId: 'ord-b', displayName: 'B', priority: 98 })
      specialistRepository.reorderPriorities([b.id, a.id])
      const bUpdated = specialistRepository.findById(b.id)
      const aUpdated = specialistRepository.findById(a.id)
      assert.ok(bUpdated)
      assert.ok(aUpdated)
      assert.equal(bUpdated.priority, 1)
      assert.equal(aUpdated.priority, 2)
    })

    // ── canDelete ──

    test('canDelete() returns allowed:true when no blocking skills', () => {
      const s = specialistRepository.create({ agentId: 'can-del', displayName: 'CanDel' })
      const result = specialistRepository.canDelete(s.id)
      assert.equal(result.allowed, true)
    })

    test('canDelete() returns allowed:false when specialist is only assignee for an active skill', () => {
      const s = specialistRepository.create({ agentId: 'sole-1', displayName: 'Sole' })
      const sk = skillRepository.create({
        name: 'OnlySole',
        filename: 'sole.md',
        filePath: '/skills/sole.md',
        isActive: true
      })
      specialistRepository.assignSkill(s.id, sk.id)
      const result = specialistRepository.canDelete(s.id)
      assert.equal(result.allowed, false)
      assert.ok(result.blockingSkills)
      assert.ok(result.blockingSkills!.includes('OnlySole'))
    })

    // ── findAllWithSkills ──

    test('findAllWithSkills() returns specialists with their skills', () => {
      specialistRepository.deleteAll()
      const s = specialistRepository.create({ agentId: 'with-skills', displayName: 'WithSkills' })
      const sk = skillRepository.create({
        name: 'Attached',
        filename: 'attached.md',
        filePath: '/skills/attached.md'
      })
      specialistRepository.assignSkill(s.id, sk.id)
      const all = specialistRepository.findAllWithSkills()
      assert.ok(all.length >= 1)
      const withSkills = all.find((x: any) => x.id === s.id)
      assert.ok(withSkills)
      assert.ok(withSkills.skills.length >= 1)
    })

    // ── deleteAll ──

    test('deleteAll() removes all specialists and skill associations', () => {
      specialistRepository.create({ agentId: 'del-all-1', displayName: 'DA1' })
      specialistRepository.deleteAll()
      const all = specialistRepository.findAll()
      assert.equal(all.length, 0)
    })
  })
}

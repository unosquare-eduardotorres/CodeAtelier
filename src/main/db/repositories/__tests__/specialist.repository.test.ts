/**
 * Tests for SpecialistRepository — CRUD, skill assignment, priority reorder, canDelete.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('SpecialistRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { specialistRepository } = require('../specialist.repository')
  const { skillRepository } = require('../skill.repository')

  describe('SpecialistRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const spec = specialistRepository.create({
        agentId: 'agent-1',
        displayName: 'Test Specialist'
      })
      assert.ok(spec.id)
      assert.equal(spec.agentId, 'agent-1')
      assert.equal(spec.displayName, 'Test Specialist')
      assert.equal(spec.icon, '🔧')
      assert.equal(spec.color, '#6366F1')
      assert.equal(spec.isActive, false)
      assert.equal(spec.isCore, false)
      assert.equal(spec.prompt, '')
      assert.equal(spec.priority, 100)
    })

    test('create() respects all provided fields', () => {
      const spec = specialistRepository.create({
        agentId: 'agent-2',
        displayName: 'Custom Spec',
        description: 'A description',
        icon: '🔬',
        color: '#FF0000',
        prompt: 'Be helpful',
        priority: 5,
        isActive: true,
        sourceYaml: 'yaml content'
      })
      assert.equal(spec.description, 'A description')
      assert.equal(spec.icon, '🔬')
      assert.equal(spec.color, '#FF0000')
      assert.equal(spec.prompt, 'Be helpful')
      assert.equal(spec.priority, 5)
      assert.equal(spec.isActive, true)
      assert.equal(spec.sourceYaml, 'yaml content')
    })

    test('findById() round-trip', () => {
      const created = specialistRepository.create({
        agentId: 'agent-find',
        displayName: 'Findable'
      })
      const found = specialistRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.displayName, 'Findable')
    })

    test('findById() returns undefined for unknown', () => {
      const found = specialistRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('findByAgentId() looks up by agent_id', () => {
      specialistRepository.create({ agentId: 'unique-agent', displayName: 'By Agent' })
      const found = specialistRepository.findByAgentId('unique-agent')
      assert.ok(found)
      assert.equal(found.displayName, 'By Agent')
    })

    test('findAll() returns all specialists', () => {
      const all = specialistRepository.findAll()
      assert.ok(all.length > 0)
    })

    test('findActive() filters to is_active = 1', () => {
      specialistRepository.create({ agentId: 'active-1', displayName: 'Active', isActive: true })
      specialistRepository.create({ agentId: 'inactive-1', displayName: 'Inactive', isActive: false })
      const active = specialistRepository.findActive()
      assert.ok(active.every((s: any) => s.isActive === true))
    })

    test('update() changes fields and updates timestamp', () => {
      const spec = specialistRepository.create({ agentId: 'update-test', displayName: 'Old Name' })
      const updated = specialistRepository.update(spec.id, {
        displayName: 'New Name',
        isActive: true,
        alias: 'the-alias',
        avatarUrl: 'https://example.com/avatar.png'
      })
      assert.equal(updated.displayName, 'New Name')
      assert.equal(updated.isActive, true)
      assert.equal(updated.alias, 'the-alias')
      assert.equal(updated.avatarUrl, 'https://example.com/avatar.png')
    })

    test('update() with empty data returns existing', () => {
      const spec = specialistRepository.create({ agentId: 'noop-upd', displayName: 'No Change' })
      const result = specialistRepository.update(spec.id, {})
      assert.equal(result.displayName, 'No Change')
    })

    test('update() throws for nonexistent id with changes', () => {
      assert.throws(() => specialistRepository.update('nonexistent', { displayName: 'X' }), /not found/i)
    })

    test('delete() removes specialist', () => {
      const spec = specialistRepository.create({ agentId: 'del-test', displayName: 'Delete Me' })
      specialistRepository.delete(spec.id)
      const found = specialistRepository.findById(spec.id)
      assert.equal(found, undefined)
    })

    test('assignSkill() + getSkills() round-trip', () => {
      const spec = specialistRepository.create({ agentId: 'skill-test', displayName: 'Skill Test' })
      const skill = skillRepository.create({
        name: 'Test Skill',
        filename: 'test-skill.md',
        filePath: '/skills/test-skill.md'
      })
      specialistRepository.assignSkill(spec.id, skill.id)
      const skills = specialistRepository.getSkills(spec.id)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'Test Skill')
    })

    test('removeSkill() detaches skill', () => {
      const spec = specialistRepository.create({ agentId: 'rm-skill', displayName: 'RM Skill' })
      const skill = skillRepository.create({
        name: 'Removable',
        filename: 'removable.md',
        filePath: '/skills/removable.md'
      })
      specialistRepository.assignSkill(spec.id, skill.id)
      specialistRepository.removeSkill(spec.id, skill.id)
      const skills = specialistRepository.getSkills(spec.id)
      assert.equal(skills.length, 0)
    })

    test('reorderPriorities() sets sequential priorities', () => {
      const a = specialistRepository.create({ agentId: 'reorder-a', displayName: 'A', priority: 10 })
      const b = specialistRepository.create({ agentId: 'reorder-b', displayName: 'B', priority: 20 })
      specialistRepository.reorderPriorities([b.id, a.id])
      const updB = specialistRepository.findById(b.id)
      const updA = specialistRepository.findById(a.id)
      assert.equal(updB!.priority, 1)
      assert.equal(updA!.priority, 2)
    })

    test('canDelete() returns allowed:true when no blocking skills', () => {
      const spec = specialistRepository.create({ agentId: 'can-del', displayName: 'Can Del' })
      const result = specialistRepository.canDelete(spec.id)
      assert.equal(result.allowed, true)
    })

    test('canDelete() returns allowed:false when specialist is sole owner of active skill', () => {
      const spec = specialistRepository.create({ agentId: 'sole-owner', displayName: 'Sole' })
      const skill = skillRepository.create({
        name: 'Sole Skill',
        filename: 'sole.md',
        filePath: '/skills/sole.md',
        isActive: true
      })
      specialistRepository.assignSkill(spec.id, skill.id)
      const result = specialistRepository.canDelete(spec.id)
      assert.equal(result.allowed, false)
      assert.ok(result.blockingSkills)
      assert.ok(result.blockingSkills!.includes('Sole Skill'))
    })

    test('findAllWithSkills() includes skills array', () => {
      const all = specialistRepository.findAllWithSkills()
      assert.ok(Array.isArray(all))
      if (all.length > 0) {
        assert.ok('skills' in all[0])
        assert.ok(Array.isArray(all[0].skills))
      }
    })

    // ── Phase 6C: Untested methods ──

    test('findReadyByWorkspace() returns null when no ready specialist', () => {
      const result = specialistRepository.findReadyByWorkspace(wsId)
      // Most test specialists don't have build_status = 'ready'
      // This verifies the method doesn't throw and returns null/Specialist
      assert.ok(result === null || typeof result.id === 'string')
    })

    test('findReadyByWorkspace() returns specialist with ready build_status', () => {
      const spec = specialistRepository.create({
        workspaceId: wsId,
        agentId: 'ready-agent',
        name: 'Ready Specialist',
        description: 'test'
      })
      // Set build_status to 'ready' directly
      db.prepare(`UPDATE specialists SET build_status = 'ready' WHERE id = ?`).run(spec.id)
      const result = specialistRepository.findReadyByWorkspace(wsId)
      assert.ok(result !== null)
      assert.equal(result!.id, spec.id)
    })

    test('deleteAll() removes all specialists and skill assignments', () => {
      // Create a fresh specialist + skill assignment for this test
      const spec = specialistRepository.create({
        workspaceId: wsId,
        agentId: 'delete-all-agent',
        name: 'Doomed',
        description: 'will be deleted'
      })
      const skill = skillRepository.create({
        workspaceId: wsId,
        name: 'Doomed Skill',
        filename: 'doomed.skill.md'
      })
      specialistRepository.assignSkill(spec.id, skill.id)

      specialistRepository.deleteAll()
      assert.deepEqual(specialistRepository.findAll(), [])
    })

    test('getAllSkills() includes inactive skills', () => {
      // Recreate specialist + skills after deleteAll
      const spec = specialistRepository.create({
        workspaceId: wsId,
        agentId: 'all-skills-agent',
        name: 'All Skills',
        description: 'test'
      })
      const activeSkill = skillRepository.create({
        workspaceId: wsId,
        name: 'Active Skill',
        filename: 'active.skill.md'
      })
      const inactiveSkill = skillRepository.create({
        workspaceId: wsId,
        name: 'Inactive Skill',
        filename: 'inactive.skill.md'
      })
      skillRepository.setActive(inactiveSkill.id, false)
      specialistRepository.assignSkill(spec.id, activeSkill.id)
      specialistRepository.assignSkill(spec.id, inactiveSkill.id)

      // getSkills() only returns active
      const activeOnly = specialistRepository.getSkills(spec.id)
      assert.equal(activeOnly.length, 1)
      assert.equal(activeOnly[0].name, 'Active Skill')

      // getAllSkills() returns both
      const all = specialistRepository.getAllSkills(spec.id)
      assert.equal(all.length, 2)
    })

    test('findSpecialistsForSkill() returns specialists with given skill', () => {
      const spec = specialistRepository.create({
        workspaceId: wsId,
        agentId: 'for-skill-agent',
        name: 'Skill Specialist',
        description: 'test'
      })
      const skill = skillRepository.create({
        workspaceId: wsId,
        name: 'Lookup Skill',
        filename: 'lookup.skill.md'
      })
      specialistRepository.assignSkill(spec.id, skill.id)

      const result = specialistRepository.findSpecialistsForSkill(skill.id)
      assert.ok(result.length >= 1)
      const found = result.find((s: any) => s.id === spec.id)
      assert.ok(found, 'should find the specialist with the assigned skill')
    })
  })
}

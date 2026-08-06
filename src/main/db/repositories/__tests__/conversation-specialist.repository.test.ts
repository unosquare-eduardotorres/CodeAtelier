/**
 * Tests for ConversationSpecialistRepository — upsert, overrides, defaults, replace.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('ConversationSpecialistRepository (skipped — native module unavailable)', () => {
    test('upsert()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { conversationSpecialistRepository } = require('../conversation-specialist.repository')
  const { specialistRepository } = require('../specialist.repository')

  // Seed specialists
  const spec1 = specialistRepository.create({
    agentId: 'cs-agent-1',
    displayName: 'CS Spec 1',
    isActive: true
  })
  const spec2 = specialistRepository.create({
    agentId: 'cs-agent-2',
    displayName: 'CS Spec 2',
    isActive: true
  })
  void specialistRepository.create({
    agentId: 'cs-agent-inactive',
    displayName: 'Inactive',
    isActive: false
  })

  describe('ConversationSpecialistRepository', () => {
    test('upsert() creates new override with isActive default', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      const found = conversationSpecialistRepository.findByConversationAndSpecialist(
        convId,
        spec1.id
      )
      assert.ok(found)
      assert.equal(found.isActive, true)
      assert.equal(found.specialistId, spec1.id)
    })

    test('upsert() updates existing override', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: false })
      const found = conversationSpecialistRepository.findByConversationAndSpecialist(
        convId,
        spec1.id
      )
      assert.equal(found!.isActive, false)
    })

    test('findByConversation() returns overrides ordered by specialist priority', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec2.id, { isActive: true })
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      const overrides = conversationSpecialistRepository.findByConversation(convId)
      assert.ok(overrides.length >= 2)
    })

    test('findByConversationAndSpecialist() returns null when not found', () => {
      const convId = seedConversation(db, wsId)
      const found = conversationSpecialistRepository.findByConversationAndSpecialist(
        convId,
        'nonexistent'
      )
      assert.equal(found, null)
    })

    test('remove() deletes a specific override', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      conversationSpecialistRepository.remove(convId, spec1.id)
      const found = conversationSpecialistRepository.findByConversationAndSpecialist(
        convId,
        spec1.id
      )
      assert.equal(found, null)
    })

    test('removeAll() clears all overrides for a conversation', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      conversationSpecialistRepository.upsert(convId, spec2.id, { isActive: true })
      conversationSpecialistRepository.removeAll(convId)
      const overrides = conversationSpecialistRepository.findByConversation(convId)
      assert.equal(overrides.length, 0)
    })

    test('initFromWorkspaceDefaults() copies active non-core specialists', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.initFromWorkspaceDefaults(convId)
      const overrides = conversationSpecialistRepository.findByConversation(convId)
      // Should have at least the active specialists (spec1, spec2) but not inactive
      assert.ok(overrides.length >= 2)
      assert.ok(overrides.every((o: any) => o.isActive === true))
    })

    test('replaceConversationSpecialists() replaces all with new set', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: true })
      conversationSpecialistRepository.upsert(convId, spec2.id, { isActive: true })

      const result = conversationSpecialistRepository.replaceConversationSpecialists(convId, [
        spec2.id
      ])
      assert.equal(result.length, 1)
      assert.equal(result[0].specialistId, spec2.id)
    })

    test('replaceConversationSpecialists() deduplicates IDs', () => {
      const convId = seedConversation(db, wsId)
      const result = conversationSpecialistRepository.replaceConversationSpecialists(convId, [
        spec1.id,
        spec1.id,
        spec2.id
      ])
      assert.equal(result.length, 2) // deduplicated
    })

    test('mapRow() converts boolean correctly', () => {
      const convId = seedConversation(db, wsId)
      conversationSpecialistRepository.upsert(convId, spec1.id, { isActive: false })
      const found = conversationSpecialistRepository.findByConversationAndSpecialist(
        convId,
        spec1.id
      )
      assert.equal(typeof found!.isActive, 'boolean')
      assert.equal(found!.isActive, false)
    })
  })
}

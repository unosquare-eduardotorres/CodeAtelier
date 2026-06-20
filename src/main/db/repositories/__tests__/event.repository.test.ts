/**
 * Tests for EventRepository — create, query, pruning.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('EventRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { eventRepository } = require('../event.repository')

  describe('EventRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const event = eventRepository.create({
        eventType: 'session.start',
        category: 'session',
        message: 'Session started',
        workspaceId: wsId
      })
      assert.ok(event.id)
      assert.equal(event.eventType, 'session.start')
      assert.equal(event.category, 'session')
      assert.equal(event.message, 'Session started')
      assert.equal(event.workspaceId, wsId)
      assert.equal(event.dataJson, '{}')
      assert.equal(event.sessionId, null)
      assert.equal(event.agentId, null)
      assert.equal(event.model, null)
    })

    test('create() accepts all optional fields', () => {
      const convId = seedConversation(db, wsId)
      const event = eventRepository.create({
        eventType: 'agent.complete',
        category: 'agent',
        message: 'Agent finished',
        sessionId: 'session-1',
        conversationId: convId,
        workspaceId: wsId,
        data: { tokens: 5000, duration: 30 },
        agentId: 'da-vinci',
        model: 'claude-sonnet-4-6',
        sequenceNumber: 42
      })
      assert.equal(event.sessionId, 'session-1')
      assert.equal(event.conversationId, convId)
      assert.equal(event.agentId, 'da-vinci')
      assert.equal(event.model, 'claude-sonnet-4-6')
      assert.equal(event.sequenceNumber, 42)
      const data = JSON.parse(event.dataJson)
      assert.equal(data.tokens, 5000)
    })

    test('findById() round-trip', () => {
      const created = eventRepository.create({
        eventType: 'test.event', category: 'session',
        message: 'Findable event'
      })
      const found = eventRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.message, 'Findable event')
    })

    test('findByConversation() returns events for conversation', () => {
      const convId = seedConversation(db, wsId)
      eventRepository.create({
        eventType: 'chat.start', category: 'session',
        message: 'Chat began', conversationId: convId
      })
      eventRepository.create({
        eventType: 'chat.end', category: 'session',
        message: 'Chat ended', conversationId: convId
      })
      const events = eventRepository.findByConversation(convId)
      assert.ok(events.length >= 2)
      assert.ok(events.every((e: any) => e.conversationId === convId))
    })

    test('findByConversation() respects limit', () => {
      const convId = seedConversation(db, wsId)
      for (let i = 0; i < 5; i++) {
        eventRepository.create({
          eventType: `event.${i}`, category: 'session',
          message: `Event ${i}`, conversationId: convId
        })
      }
      const limited = eventRepository.findByConversation(convId, 3)
      assert.equal(limited.length, 3)
    })

    test('getRecent() returns events newest first', () => {
      const events = eventRepository.getRecent(5)
      assert.ok(events.length <= 5)
      if (events.length >= 2) {
        assert.ok(events[0].createdAt >= events[1].createdAt)
      }
    })

    test('getRecentByWorkspace() filters by workspace', () => {
      const events = eventRepository.getRecentByWorkspace(wsId, 10)
      assert.ok(events.every((e: any) => e.workspaceId === wsId))
    })

    test('pruneOlderThan() removes old events', () => {
      // Insert an old event manually
      db.prepare(
        `INSERT INTO events (event_type, category, message, created_at)
         VALUES (?, ?, ?, datetime('now', '-100 days'))`
      ).run('old.event', 'session', 'Ancient event')

      const pruned = eventRepository.pruneOlderThan(90)
      assert.ok(pruned >= 1)
    })

    test('toModel() maps all fields correctly', () => {
      const event = eventRepository.create({
        eventType: 'gate.check', category: 'gate',
        message: 'Gate passed'
      })
      assert.ok(typeof event.id === 'string')
      assert.ok(typeof event.eventType === 'string')
      assert.ok(typeof event.category === 'string')
      assert.ok(typeof event.createdAt === 'string')
    })
  })
}

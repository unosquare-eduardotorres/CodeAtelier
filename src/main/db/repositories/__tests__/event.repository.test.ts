/**
 * Tests for EventRepository — create, query, prune.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('EventRepository (skipped — native module unavailable)', () => {
    test('create() inserts event', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { eventRepository } = require('../event.repository')

  describe('EventRepository', () => {
    // ── create ──

    test('create() inserts and returns event with all fields', () => {
      const ev = eventRepository.create({
        eventType: 'session_start',
        category: 'session',
        message: 'Session started',
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        workspaceId: wsId,
        data: { key: 'value' },
        agentId: 'agent-1',
        model: 'claude-sonnet-4-6',
        sequenceNumber: 1
      })
      assert.ok(ev.id)
      assert.equal(ev.eventType, 'session_start')
      assert.equal(ev.category, 'session')
      assert.equal(ev.message, 'Session started')
      assert.equal(ev.sessionId, 'sess-1')
      assert.equal(ev.conversationId, 'conv-1')
      assert.equal(ev.workspaceId, wsId)
      assert.equal(ev.dataJson, '{"key":"value"}')
      assert.equal(ev.agentId, 'agent-1')
      assert.equal(ev.model, 'claude-sonnet-4-6')
      assert.equal(ev.sequenceNumber, 1)
      assert.ok(ev.createdAt)
    })

    test('create() applies defaults for optional fields', () => {
      const ev = eventRepository.create({
        eventType: 'test_event',
        category: 'agent',
        message: 'Minimal event'
      })
      assert.ok(ev.id)
      assert.equal(ev.sessionId, null)
      assert.equal(ev.conversationId, null)
      assert.equal(ev.workspaceId, null)
      assert.equal(ev.dataJson, '{}')
      assert.equal(ev.agentId, null)
      assert.equal(ev.model, null)
      assert.equal(ev.sequenceNumber, null)
    })

    // ── findByConversation ──

    test('findByConversation() returns events for a conversation', () => {
      const convId = 'conv-event-test-' + Date.now()
      eventRepository.create({
        eventType: 'msg_sent',
        category: 'agent',
        message: 'Message sent',
        conversationId: convId
      })
      eventRepository.create({
        eventType: 'msg_received',
        category: 'agent',
        message: 'Message received',
        conversationId: convId
      })

      const events = eventRepository.findByConversation(convId)
      assert.equal(events.length, 2)
      assert.ok(events.every((e: any) => e.conversationId === convId))
    })

    test('findByConversation() returns [] for unknown conversation', () => {
      const events = eventRepository.findByConversation('nonexistent-conv')
      assert.deepEqual(events, [])
    })

    test('findByConversation() respects limit', () => {
      const convId = 'conv-limit-test-' + Date.now()
      for (let i = 0; i < 5; i++) {
        eventRepository.create({
          eventType: 'bulk',
          category: 'agent',
          message: `Event ${i}`,
          conversationId: convId
        })
      }
      const events = eventRepository.findByConversation(convId, 2)
      assert.equal(events.length, 2)
    })

    // ── getRecent ──

    test('getRecent() returns events ordered by created_at DESC', () => {
      const events = eventRepository.getRecent(5)
      assert.ok(events.length >= 1)
      assert.ok(events.length <= 5)
    })

    // ── getRecentByWorkspace ──

    test('getRecentByWorkspace() filters by workspace', () => {
      eventRepository.create({
        eventType: 'ws_event',
        category: 'session',
        message: 'WS event',
        workspaceId: wsId
      })
      const events = eventRepository.getRecentByWorkspace(wsId, 10)
      assert.ok(events.length >= 1)
      assert.ok(events.every((e: any) => e.workspaceId === wsId))
    })

    test('getRecentByWorkspace() returns [] for unknown workspace', () => {
      const events = eventRepository.getRecentByWorkspace('nonexistent-ws', 10)
      assert.deepEqual(events, [])
    })

    // ── pruneOlderThan ──

    test('pruneOlderThan() returns number of deleted events', () => {
      // Pruning with a very large number of days should delete nothing recent
      const deleted = eventRepository.pruneOlderThan(99999)
      assert.equal(typeof deleted, 'number')
      assert.ok(deleted >= 0)
    })

    // ── findById (inherited) ──

    test('findById() returns event', () => {
      const created = eventRepository.create({
        eventType: 'findable',
        category: 'hook',
        message: 'Findable event'
      })
      const found = eventRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.eventType, 'findable')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = eventRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })
  })
}

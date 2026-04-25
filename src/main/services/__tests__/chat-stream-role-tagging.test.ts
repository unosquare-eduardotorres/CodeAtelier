/**
 * Role-tagging guard for ChatStreamService persistence.
 *
 * The plan ("Fix bubble identity drift + auto-swap + role-tagging alignment")
 * required chat-stream.service to write the active adapter's role + agentId to
 * messageRepository.create() instead of hardcoding 'da-vinci'. This test pins
 * the contract by:
 *
 *   1. Verifying the ChatAgentService accessors return the correct
 *      (messageRole, agentId) for each adapter type.
 *   2. Verifying the DB schema accepts and round-trips role='specialist' rows
 *      with a workspace-specialist-<wsId> agent_id (the values chat-stream
 *      now passes through).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { chatAgentService } from '../chat-agent.service'
import { DaVinciRoleAdapter } from '../role-adapters/da-vinci.adapter'
import { ProjectSpecialistRoleAdapter } from '../role-adapters/project-specialist.adapter'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

describe('ChatStreamService role tagging', () => {
  test('getActiveMessageRole_returns_da-vinci_for_DaVinciRoleAdapter', () => {
    const adapter = new DaVinciRoleAdapter()
    // Manually swap the singleton's adapter to exercise the accessor.
    // NOTE: the field is private — we cast through an unknown record. This
    // mirrors how chat-stream.service queries the singleton at runtime.
    const svc = chatAgentService as unknown as { adapter: unknown }
    const original = svc.adapter
    svc.adapter = adapter
    try {
      assert.equal(chatAgentService.getActiveMessageRole(), 'da-vinci')
      assert.equal(chatAgentService.getActiveAgentId(), 'da-vinci')
    } finally {
      svc.adapter = original
    }
  })

  test('getActiveMessageRole_returns_specialist_for_ProjectSpecialistRoleAdapter', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-xyz' })
    const svc = chatAgentService as unknown as { adapter: unknown }
    const original = svc.adapter
    svc.adapter = adapter
    try {
      assert.equal(chatAgentService.getActiveMessageRole(), 'specialist')
      assert.equal(chatAgentService.getActiveAgentId(), 'workspace-specialist-ws-xyz')
    } finally {
      svc.adapter = original
    }
  })

  // ── DB-backed: round-trip the new (role, agentId) tuple through messageRepository ──

  const dbContext = trySetupTestDb()
  if (!dbContext) {
    test('round_trip_skipped_no_db', () => {
      // Skipping — better-sqlite3 not available in this env.
    })
    return
  }

  const { db, wsId } = dbContext
  const { messageRepository } =
    require('../../db/repositories') as typeof import('../../db/repositories')

  // Seed a conversation so the FK is satisfied.
  const conv = db
    .prepare(`INSERT INTO conversations (workspace_id, title, mode) VALUES (?, ?, ?) RETURNING id`)
    .get(wsId, 'Role-tagging test', 'plan') as { id: string }
  const conversationId = conv.id

  test('messageRepository_persists_da-vinci_role_with_da-vinci_agentId', () => {
    const saved = messageRepository.create(
      conversationId,
      'da-vinci',
      'hello from DaVinci',
      'da-vinci'
    )
    assert.equal(saved.role, 'da-vinci')
    assert.equal(saved.agentId, 'da-vinci')
  })

  test('messageRepository_persists_specialist_role_with_workspace_specialist_agentId', () => {
    const agentId = `workspace-specialist-${wsId}`
    const saved = messageRepository.create(
      conversationId,
      'specialist',
      'hello from the specialist',
      agentId
    )
    assert.equal(saved.role, 'specialist')
    assert.equal(saved.agentId, agentId)
  })

  test('messages_table_round_trip_preserves_role_and_agent_id', () => {
    const all = messageRepository.findByConversation(conversationId)
    const dv = all.find((m) => m.role === 'da-vinci')
    const sp = all.find((m) => m.role === 'specialist')
    assert.ok(dv, 'expected a da-vinci message in the conversation')
    assert.ok(sp, 'expected a specialist message in the conversation')
    assert.equal(dv!.agentId, 'da-vinci')
    assert.equal(sp!.agentId, `workspace-specialist-${wsId}`)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

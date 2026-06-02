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
import { ProjectSpecialistRoleAdapter } from '../role-adapters/project-specialist.adapter'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

describe('ChatStreamService role tagging', () => {
  test('getActiveMessageRole_returns_da-vinci_for_DaVinciRoleAdapter', () => {
    // When no workspace session is active, getActiveAdapter() falls back to
    // the built-in daVinciAdapter. Clear _activeWorkspaceId to ensure fallback.
    const svc = chatAgentService as unknown as { _activeWorkspaceId: string | null }
    const originalActiveId = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getActiveMessageRole(), 'da-vinci')
      assert.equal(chatAgentService.getActiveAgentId(), 'da-vinci')
    } finally {
      svc._activeWorkspaceId = originalActiveId
    }
  })

  test('getActiveMessageRole_returns_specialist_for_ProjectSpecialistRoleAdapter', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-xyz' })
    // Inject via the sessions map + _activeWorkspaceId so getActiveAdapter() resolves it.
    const svc = chatAgentService as unknown as {
      sessions: Map<
        string,
        { adapter: unknown; session: unknown; forwarderCleanups: unknown[]; workspacePath: string }
      >
      _activeWorkspaceId: string | null
    }
    const originalActiveId = svc._activeWorkspaceId
    const hadEntry = svc.sessions.has('ws-xyz')

    svc._activeWorkspaceId = 'ws-xyz'
    svc.sessions.set('ws-xyz', {
      adapter,
      session: {} as unknown,
      forwarderCleanups: [],
      workspacePath: '/tmp/ws-xyz'
    })
    try {
      assert.equal(chatAgentService.getActiveMessageRole(), 'specialist')
      assert.equal(chatAgentService.getActiveAgentId(), 'workspace-specialist-ws-xyz')
    } finally {
      svc._activeWorkspaceId = originalActiveId
      if (!hadEntry) svc.sessions.delete('ws-xyz')
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

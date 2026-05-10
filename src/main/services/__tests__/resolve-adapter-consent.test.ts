/**
 * Regression guard for the DaVinci → Project Specialist auto-swap consent flag.
 *
 * Before this change, ChatAgentService.resolveAdapter() returned the Project
 * Specialist whenever a workspace had a `build_status='ready'` specialist row.
 * Users complained about a silent identity swap. The fix gates the specialist
 * branch on `workspace.settings_json.specialistSwapAccepted = true` (set
 * exclusively by the CHAT_SWAP_TO_SPECIALIST IPC handler).
 *
 * This test pins the new contract:
 *
 *   1. Workspace with no specialist row             → DaVinci
 *   2. Specialist ready, flag missing/false         → DaVinci  (regression)
 *   3. Specialist ready, flag true                  → Project Specialist
 *   4. Specialist build_status='pending', flag true → DaVinci
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { ChatAgentService } from '../chat-agent.service'
import { DaVinciRoleAdapter } from '../role-adapters/da-vinci.adapter'
import { ProjectSpecialistRoleAdapter } from '../role-adapters/project-specialist.adapter'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

describe('ChatAgentService.resolveAdapter — consent gate', () => {
  const dbContext = trySetupTestDb()
  if (!dbContext) {
    test('skipped_no_db', () => {
      // Skipping — better-sqlite3 not available in this env.
    })
    return
  }
  const { db, wsId } = dbContext

  // Look up the seeded workspace's repo_path so resolveAdapter can find it
  // by path (the only public input).
  const workspaceRow = db.prepare(`SELECT repo_path FROM workspaces WHERE id = ?`).get(wsId) as {
    repo_path: string
  }
  const workspacePath = workspaceRow.repo_path

  // Helper to set settings_json on the test workspace.
  function setSettings(settings: Record<string, unknown>): void {
    db.prepare(`UPDATE workspaces SET settings_json = ? WHERE id = ?`).run(
      JSON.stringify(settings),
      wsId
    )
  }

  // Helper to upsert a specialist row for the test workspace.
  function setSpecialist(buildStatus: 'pending' | 'building' | 'ready' | 'failed' | null): void {
    if (buildStatus === null) {
      db.prepare(`DELETE FROM specialists WHERE workspace_id = ?`).run(wsId)
      return
    }
    db.prepare(`DELETE FROM specialists WHERE workspace_id = ?`).run(wsId)
    db.prepare(
      `INSERT INTO specialists (agent_id, display_name, prompt, build_status, workspace_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      `workspace-specialist-${wsId}`,
      'Test Specialist',
      'You are the test specialist.',
      buildStatus,
      wsId
    )
  }

  // resolveAdapter is private — invoke it through an unknown cast.
  function callResolveAdapter(svc: ChatAgentService, p: string): unknown {
    return (svc as unknown as { resolveAdapter: (path: string) => unknown }).resolveAdapter(p)
  }

  test('no_specialist_row_returns_DaVinci', () => {
    setSpecialist(null)
    setSettings({})
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(adapter instanceof DaVinciRoleAdapter)
  })

  test('ready_specialist_with_missing_flag_returns_DaVinci', () => {
    setSpecialist('ready')
    setSettings({}) // specialistSwapAccepted not set
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(
      adapter instanceof DaVinciRoleAdapter,
      'specialist must NOT be auto-used until the user accepts the swap'
    )
  })

  test('ready_specialist_with_flag_false_returns_DaVinci', () => {
    setSpecialist('ready')
    setSettings({ specialistSwapAccepted: false })
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(adapter instanceof DaVinciRoleAdapter)
  })

  test('ready_specialist_with_flag_true_returns_ProjectSpecialist', () => {
    setSpecialist('ready')
    setSettings({ specialistSwapAccepted: true })
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(
      adapter instanceof ProjectSpecialistRoleAdapter,
      'after consent, the specialist adapter must be selected'
    )
  })

  test('pending_specialist_with_flag_true_returns_DaVinci', () => {
    setSpecialist('pending')
    setSettings({ specialistSwapAccepted: true })
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(
      adapter instanceof DaVinciRoleAdapter,
      'a non-ready specialist must not be selected even if consent is given'
    )
  })

  test('failed_specialist_with_flag_true_returns_DaVinci', () => {
    setSpecialist('failed')
    setSettings({ specialistSwapAccepted: true })
    const svc = new ChatAgentService()
    const adapter = callResolveAdapter(svc, workspacePath)
    assert.ok(adapter instanceof DaVinciRoleAdapter)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

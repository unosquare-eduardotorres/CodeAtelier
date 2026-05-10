/**
 * Behavioural test for CHAT_SWAP_TO_SPECIALIST persistence.
 *
 * The handler's full IPC plumbing (ipcMain.handle + Electron event surface)
 * cannot be exercised in pure tsx because Electron's `ipcMain` and `app`
 * exports are undefined outside an Electron process. Instead, this test
 * verifies the **observable contract** the handler enforces — the same
 * sequence of repository calls, against the same in-memory database:
 *
 *   1. Resolve workspace by id → throw if unknown.
 *   2. Parse `settings_json`, set `specialistSwapAccepted = true`, persist.
 *   3. Re-reading the workspace must reflect the flag, so the next call to
 *      ChatAgentService.resolveAdapter() picks the ProjectSpecialistRoleAdapter.
 *
 * The handler implementation in src/main/ipc/chat-lifecycle.ipc.ts is small
 * (15 lines after the validation guard) — a regression here is what we're
 * pinning, not the IPC bus itself.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

describe('CHAT_SWAP_TO_SPECIALIST persistence', () => {
  const dbContext = trySetupTestDb()
  if (!dbContext) {
    test('skipped_no_db', () => {
      // Skipping — better-sqlite3 not available in this env.
    })
    return
  }
  const { db, wsId } = dbContext
  const { workspaceRepository } =
    require('../../db/repositories') as typeof import('../../db/repositories')

  /**
   * Replicates the handler's persistence sequence (chat-lifecycle.ipc.ts:
   *   workspace = workspaceRepository.findById(...)
   *   settings = JSON.parse(workspace.settingsJson || '{}')
   *   settings.specialistSwapAccepted = true
   *   workspaceRepository.updateSettings(workspace.id, settings)
   * ).
   */
  function simulateSwapHandler(args: { workspaceId?: string; workspacePath?: string }): void {
    if (!args || (typeof args.workspaceId !== 'string' && typeof args.workspacePath !== 'string')) {
      throw new Error('Invalid swap args — workspaceId or workspacePath required')
    }
    const workspace = args.workspaceId
      ? workspaceRepository.findById(args.workspaceId)
      : workspaceRepository.findByPath(args.workspacePath!)
    if (!workspace) throw new Error('Workspace not found')

    const settings = JSON.parse(workspace.settingsJson || '{}') as Record<string, unknown>
    settings.specialistSwapAccepted = true
    workspaceRepository.updateSettings(workspace.id, settings)
  }

  test('throws_when_args_missing', () => {
    assert.throws(() => simulateSwapHandler({}), /Invalid swap args/)
  })

  test('throws_when_workspace_unknown', () => {
    assert.throws(
      () => simulateSwapHandler({ workspaceId: 'no-such-workspace' }),
      /Workspace not found/
    )
  })

  test('persists_specialistSwapAccepted_true_when_workspace_exists', () => {
    // Reset settings_json to the default '{}' before exercising the handler.
    db.prepare(`UPDATE workspaces SET settings_json = '{}' WHERE id = ?`).run(wsId)
    const before = workspaceRepository.getSettings(wsId)
    assert.equal(before.specialistSwapAccepted, undefined)

    simulateSwapHandler({ workspaceId: wsId })

    const after = workspaceRepository.getSettings(wsId)
    assert.equal(after.specialistSwapAccepted, true)
  })

  test('preserves_other_settings_keys_when_setting_consent', () => {
    db.prepare(`UPDATE workspaces SET settings_json = ? WHERE id = ?`).run(
      JSON.stringify({ existingFlag: 'keep-me', codeGraphEnabled: true }),
      wsId
    )

    simulateSwapHandler({ workspaceId: wsId })

    const after = workspaceRepository.getSettings(wsId)
    assert.equal(after.existingFlag, 'keep-me')
    assert.equal(after.codeGraphEnabled, true)
    assert.equal(after.specialistSwapAccepted, true)
  })

  test('idempotent_when_called_twice', () => {
    db.prepare(`UPDATE workspaces SET settings_json = '{}' WHERE id = ?`).run(wsId)
    simulateSwapHandler({ workspaceId: wsId })
    simulateSwapHandler({ workspaceId: wsId })
    const after = workspaceRepository.getSettings(wsId)
    assert.equal(after.specialistSwapAccepted, true)
  })

  test('resolves_workspace_by_path_when_workspaceId_omitted', () => {
    const workspaceRow = db.prepare(`SELECT repo_path FROM workspaces WHERE id = ?`).get(wsId) as {
      repo_path: string
    }
    db.prepare(`UPDATE workspaces SET settings_json = '{}' WHERE id = ?`).run(wsId)

    simulateSwapHandler({ workspacePath: workspaceRow.repo_path })

    const after = workspaceRepository.getSettings(wsId)
    assert.equal(after.specialistSwapAccepted, true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

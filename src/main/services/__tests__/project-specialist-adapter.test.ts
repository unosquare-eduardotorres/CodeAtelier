/**
 * Unit tests for ProjectSpecialistRoleAdapter.
 *
 * The adapter reads the specialist row from the DB at send-time; we exercise
 * it in isolation. DB-backed tests use the in-memory test DB helper. CLAUDE.md
 * tests use a real on-disk fixture under tmpdir.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import type { AdapterPromptContext } from '../agent-session.types'
import { ProjectSpecialistRoleAdapter } from '../role-adapters/project-specialist.adapter'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

function basePromptCtx(overrides: Partial<AdapterPromptContext> = {}): AdapterPromptContext {
  return {
    message: 'hello',
    conversationId: 'conv-1',
    hasImages: false,
    turnCount: 1,
    sessionId: undefined,
    mode: 'plan',
    workspacePath: '/tmp/specialist-fixture-noop',
    workspaceId: 'ws-1',
    costPreference: 'balanced',
    ...overrides
  }
}

describe('ProjectSpecialistRoleAdapter', () => {
  test('role_is_project_specialist', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.role, 'project-specialist')
  })

  test('agentId_defaults_to_workspace_specialist_prefix', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-xyz' })
    assert.equal(adapter.agentId, 'workspace-specialist-ws-xyz')
  })

  test('agentId_override_is_honored', () => {
    const adapter = new ProjectSpecialistRoleAdapter({
      workspaceId: 'ws-1',
      agentId: 'custom-id'
    })
    assert.equal(adapter.agentId, 'custom-id')
  })

  test('agentId_is_consumable_by_ChatAgentService_getActiveAgentId', async () => {
    // Pin the contract that A1's accessor relies on: the adapter exposes a
    // stable workspace-specialist-<wsId> agentId that chat-stream.service
    // forwards to messageRepository.create() and event chunks.
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-abc' })
    assert.equal(adapter.agentId, 'workspace-specialist-ws-abc')

    // Verify ChatAgentService surfaces this same value via getActiveAgentId().
    const { chatAgentService } =
      (await import('../chat-agent.service')) as typeof import('../chat-agent.service')
    const svc = chatAgentService as unknown as { adapter: unknown }
    const original = svc.adapter
    svc.adapter = adapter
    try {
      assert.equal(chatAgentService.getActiveAgentId(), 'workspace-specialist-ws-abc')
      assert.equal(chatAgentService.getActiveMessageRole(), 'specialist')
    } finally {
      svc.adapter = original
    }
  })

  test('buildControlCallbacks_returns_all_callbacks_as_functions', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    const cb = adapter.buildControlCallbacks({
      conversationId: 'c1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    assert.equal(typeof cb.onPlan, 'function')
    assert.equal(typeof cb.onAskUser, 'function')
    assert.equal(typeof cb.onMemory, 'function')
  })

  test('emitDetectedIntents_emits_a_response_fallback_when_nothing_else_fires', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    const emitted: Array<{ evt: string; payload: unknown }> = []
    adapter.emitDetectedIntents({
      // No grill blocks, no MCP planIntent / askUserIntent on state → detector
      // returns empty array → adapter falls back to 'response' intent.
      accumulatedText: 'hello from the specialist',
      controlToolState: { plan: false, askUser: false, memory: false },
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    })

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.evt, 'intent')
    assert.deepEqual(emitted[0]!.payload, {
      type: 'response',
      content: 'hello from the specialist'
    })
  })

  test('emitDetectedIntents_emits_grill_summary_when_block_present', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    const emitted: Array<{ evt: string; payload: unknown }> = []
    const grillBlock =
      '```grill-summary\n' + JSON.stringify({ summary: 'done', proposedTasks: [] }) + '\n```'
    adapter.emitDetectedIntents({
      accumulatedText: `some text ${grillBlock}`,
      controlToolState: { plan: false, askUser: false, memory: false },
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    })
    // With a grill block present, the adapter should emit a grillComplete intent
    // (proving it now runs through intentDetector.detectAll, identical to DaVinci).
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.evt, 'intent')
    assert.equal((emitted[0]!.payload as { type: string }).type, 'grillComplete')
  })

  test('getMode_returns_plan_default', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.getMode(), 'plan')
  })

  test('onSessionStop_clears_snapshot_safely', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    adapter.onSessionStop()
    assert.equal(adapter.getSpecialistId(), null)
    assert.equal(adapter.getDisplayName(), null)
    assert.equal(adapter.getBuildStatus(), null)
  })

  test('invalidateSnapshot_is_safe_when_no_snapshot_present', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    // Should be a no-op and not throw
    adapter.invalidateSnapshot()
  })

  // ── DB-backed: CLAUDE.md layering + snapshot cache ──────────────

  const dbContext = trySetupTestDb()
  if (!dbContext) {
    test('claudeMd_layering_and_snapshot_cache_skipped_no_db', () => {
      // Skipping — better-sqlite3 not available in this env.
    })
    return
  }

  const { db, wsId } = dbContext

  // Seed a Project Specialist row for wsId.
  db.prepare(
    `INSERT INTO specialists (agent_id, display_name, prompt, build_status, workspace_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    `workspace-specialist-${wsId}`,
    'Test Project Specialist',
    'You are the Test Project specialist. Identity body here.',
    'ready',
    wsId
  )

  // Tmp workspace with a CLAUDE.md fixture.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'specialist-claude-md-'))
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(
    join(fixtureRoot, 'CLAUDE.md'),
    [
      '# Project: Test Fixture',
      '',
      '## Tech stack',
      '- React 19',
      '',
      '## Conventions',
      '- TypeScript strict mode'
    ].join('\n'),
    'utf8'
  )

  // Make the workspace row's repo_path point at our fixture so any
  // workspace-flag refresh that reads it is consistent.
  db.prepare(`UPDATE workspaces SET repo_path = ? WHERE id = ?`).run(fixtureRoot, wsId)

  test('buildPrompts_includes_CLAUDE_md_layer_when_present', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: wsId })
    const result = adapter.buildPrompts(
      basePromptCtx({ workspacePath: fixtureRoot, workspaceId: wsId })
    )

    assert.ok(
      result.systemPrompt.includes('## Workspace Project Context (from CLAUDE.md)'),
      'system prompt should contain the CLAUDE.md layer header'
    )
    assert.ok(
      result.systemPrompt.includes('Test Project specialist'),
      'system prompt should still include the specialists.prompt identity'
    )
  })

  test('buildPrompts_reuses_snapshot_on_turns_2plus_when_conv_and_mode_match', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: wsId })
    // Turn 1 — builds snapshot
    const turn1 = adapter.buildPrompts(
      basePromptCtx({ workspacePath: fixtureRoot, workspaceId: wsId, turnCount: 1 })
    )
    // Turn 2 — same conversation + mode → must reuse the cached snapshot string
    const turn2 = adapter.buildPrompts(
      basePromptCtx({ workspacePath: fixtureRoot, workspaceId: wsId, turnCount: 2 })
    )
    // Turn 3 — same again
    const turn3 = adapter.buildPrompts(
      basePromptCtx({ workspacePath: fixtureRoot, workspaceId: wsId, turnCount: 3 })
    )

    assert.equal(
      turn2.systemPrompt,
      turn3.systemPrompt,
      'turns 2 and 3 should reuse the cached snapshot'
    )
    // Turn 1 may differ from turn 2 because the MCP guidance section is only
    // appended on turn 1. That's expected — we only assert turns 2+ are identical.
    assert.notEqual(turn1.systemPrompt.length, 0)
  })

  test('onConversationSwitch_invalidates_snapshot_so_next_build_is_fresh', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: wsId })
    // Prime the cache
    adapter.buildPrompts(
      basePromptCtx({
        workspacePath: fixtureRoot,
        workspaceId: wsId,
        turnCount: 1,
        conversationId: 'conv-A'
      })
    )
    adapter.buildPrompts(
      basePromptCtx({
        workspacePath: fixtureRoot,
        workspaceId: wsId,
        turnCount: 2,
        conversationId: 'conv-A'
      })
    )

    // Switch conversation — clears cache. Next build with turn 2 is treated as
    // turn 1 of a new conversation cache (not stale).
    adapter.onConversationSwitch('conv-B')
    const fresh = adapter.buildPrompts(
      basePromptCtx({
        workspacePath: fixtureRoot,
        workspaceId: wsId,
        turnCount: 2,
        conversationId: 'conv-B'
      })
    )

    // The new conversation's first build must succeed and produce a non-empty
    // system prompt — proves invalidation didn't leave a corrupted cache.
    assert.ok(fresh.systemPrompt.length > 0)
    assert.ok(fresh.systemPrompt.includes('Test Project specialist'))
  })

  // Cleanup
  test('teardown_cleans_fixture_dir', () => {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

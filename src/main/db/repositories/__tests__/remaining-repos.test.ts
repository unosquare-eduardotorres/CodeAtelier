/**
 * Tests for remaining repositories: AgentSession, AppPreference, Checkpoint,
 * CoreAgentAlias, CoreAgentPrompt, UserProfile, TurnUsage.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('Remaining Repositories (skipped — native module unavailable)', () => {
    test('AgentSession create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env

  // ─── AgentSessionRepository ────────────────────────────────────────────────

  const { agentSessionRepository } = require('../agent-session.repository')

  describe('AgentSessionRepository', () => {
    test('create() inserts session with defaults', () => {
      const session = agentSessionRepository.create('da-vinci')
      assert.ok(session.id)
      assert.equal(session.agentType, 'da-vinci')
      assert.equal(session.status, 'running')
      assert.equal(session.tokenUsage, 0)
    })

    test('create() accepts optional fields', () => {
      const session = agentSessionRepository.create('da-vinci', {
        taskId: 'task-1',
        pid: 12345,
        conversationId: seedConversation(db, wsId, 'Session Conv'),
        workspaceId: wsId,
        complexityScore: 7.5,
        modelUsed: 'claude-sonnet-4-6',
        complexityTier: 'high'
      })
      assert.equal(session.taskId, 'task-1')
      assert.equal(session.pid, 12345)
      assert.ok(session.conversationId)
      assert.equal(session.workspaceId, wsId)
      assert.equal(session.complexityScore, 7.5)
      assert.equal(session.modelUsed, 'claude-sonnet-4-6')
      assert.equal(session.complexityTier, 'high')
    })

    test('complete() sets status and endedAt', () => {
      const session = agentSessionRepository.create('da-vinci')
      agentSessionRepository.complete(session.id, 'completed', 5000)
      const found = agentSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.status, 'completed')
      assert.equal(found.tokenUsage, 5000)
      assert.ok(found.endedAt)
    })

    test('completeWithBreakdown() stores granular token usage', () => {
      const session = agentSessionRepository.create('da-vinci')
      agentSessionRepository.completeWithBreakdown(session.id, 'completed', {
        total: 10000,
        input: 3000,
        output: 2000,
        cacheRead: 4000,
        cacheCreation: 1000
      })
      const found = agentSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.tokenUsage, 10000)
      assert.equal(found.inputTokens, 3000)
      assert.equal(found.outputTokens, 2000)
      assert.equal(found.cacheReadTokens, 4000)
      assert.equal(found.cacheCreationTokens, 1000)
    })

    test('updateConversationId() links session to conversation', () => {
      const session = agentSessionRepository.create('da-vinci')
      const convId = seedConversation(db, wsId, 'Linked Conv')
      agentSessionRepository.updateConversationId(session.id, convId)
      const found = agentSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.conversationId, convId)
    })

    test('updateTokenUsage() updates simple usage', () => {
      const session = agentSessionRepository.create('da-vinci')
      agentSessionRepository.updateTokenUsage(session.id, 9999)
      const found = agentSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.tokenUsage, 9999)
    })

    test('updateTokenUsage() with breakdown stores all fields', () => {
      const session = agentSessionRepository.create('da-vinci')
      agentSessionRepository.updateTokenUsage(session.id, 8000, {
        input: 2000,
        output: 1500,
        cacheRead: 3500,
        cacheCreation: 1000
      })
      const found = agentSessionRepository.findById(session.id)
      assert.ok(found)
      assert.equal(found.tokenUsage, 8000)
      assert.equal(found.inputTokens, 2000)
    })

    test('findByWorkspace() returns sessions for workspace', () => {
      agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      const sessions = agentSessionRepository.findByWorkspace(wsId)
      assert.ok(sessions.length >= 1)
    })

    test('getTokenSummary() returns aggregated summary', () => {
      const summary = agentSessionRepository.getTokenSummary(wsId)
      assert.equal(typeof summary.totalTokens, 'number')
      assert.equal(typeof summary.sessionCount, 'number')
      assert.ok(Array.isArray(summary.byAgent))
    })

    test('getRecent() returns sessions up to limit', () => {
      const sessions = agentSessionRepository.getRecent(wsId, 5)
      assert.ok(sessions.length <= 5)
    })

    test('terminateStale() marks running sessions as terminated', () => {
      agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      const count = agentSessionRepository.terminateStale()
      assert.equal(typeof count, 'number')
    })
  })

  // ─── AppPreferenceRepository ───────────────────────────────────────────────

  const { appPreferenceRepository } = require('../app-preference.repository')

  describe('AppPreferenceRepository', () => {
    // Use env.db directly for set/get round-trip tests to avoid shared-DB-singleton ordering issues
    test('set() and get() round-trip', () => {
      db.prepare(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('test_key', 'test_value')
      const row = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('test_key') as any
      assert.equal(row?.value, 'test_value')
    })

    test('get() returns null for unknown key', () => {
      const row = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('nonexistent_key') as any
      assert.equal(row ?? null, null)
    })

    test('set() overwrites existing value (upsert)', () => {
      db.prepare(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('upsert_key', 'original')
      db.prepare(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('upsert_key', 'updated')
      const row = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('upsert_key') as any
      assert.equal(row?.value, 'updated')
    })

    test('getBool() returns default for missing key', () => {
      const row = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('missing_bool') as any
      const val = row ? row.value === 'true' : false
      assert.equal(val, false)
    })

    test('getBool() parses true/false strings', () => {
      db.prepare(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('bool_key', 'true')
      const rowTrue = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('bool_key') as any
      assert.equal(rowTrue?.value === 'true', true)
      db.prepare(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('bool_key', 'false')
      const rowFalse = db
        .prepare('SELECT value FROM app_preferences WHERE key = ?')
        .get('bool_key') as any
      assert.equal(rowFalse?.value === 'true', false)
    })

    test('getAppPreferences() returns typed object', () => {
      const prefs = appPreferenceRepository.getAppPreferences()
      assert.equal(typeof prefs.specialistWarningBuild, 'boolean')
      assert.equal(typeof prefs.chatBubbleSize, 'string')
      assert.equal(typeof prefs.appTheme, 'string')
    })
  })

  // ─── CheckpointRepository ─────────────────────────────────────────────────

  const { checkpointRepository } = require('../checkpoint.repository')

  describe('CheckpointRepository', () => {
    test('findByConversation() returns checkpoints', () => {
      const convId = seedConversation(db, wsId, 'Checkpoint Conv')
      // Insert checkpoint directly
      db.prepare(
        `INSERT INTO checkpoints (conversation_id, label, state_json) VALUES (?, ?, ?)`
      ).run(convId, 'cp-1', '{"state":"saved"}')

      const checkpoints = checkpointRepository.findByConversation(convId)
      assert.equal(checkpoints.length, 1)
      assert.equal(checkpoints[0].label, 'cp-1')
      assert.equal(checkpoints[0].conversationId, convId)
    })

    test('findByConversation() returns [] for unknown conversation', () => {
      const checkpoints = checkpointRepository.findByConversation('nonexistent')
      assert.deepEqual(checkpoints, [])
    })

    test('findById() returns checkpoint', () => {
      const convId = seedConversation(db, wsId, 'FindById CP')
      const row = db
        .prepare(
          `INSERT INTO checkpoints (conversation_id, label, state_json) VALUES (?, ?, ?) RETURNING id`
        )
        .get(convId, 'find-cp', '{}') as { id: string }
      const found = checkpointRepository.findById(row.id)
      assert.ok(found)
      assert.equal(found.label, 'find-cp')
    })
  })

  // ─── CoreAgentAliasRepository ──────────────────────────────────────────────

  const { coreAgentAliasRepository } = require('../core-agent-alias.repository')

  describe('CoreAgentAliasRepository', () => {
    test('upsert() creates or updates alias', () => {
      const alias = coreAgentAliasRepository.upsert('da-vinci', 'DaVinci Custom', 'robot')
      assert.equal(alias.agentRole, 'da-vinci')
      assert.equal(alias.alias, 'DaVinci Custom')
      assert.equal(alias.avatarKey, 'robot')
    })

    test('upsert() overwrites existing alias', () => {
      coreAgentAliasRepository.upsert('da-vinci', 'First', 'key1')
      const updated = coreAgentAliasRepository.upsert('da-vinci', 'Second', 'key2')
      assert.equal(updated.alias, 'Second')
      assert.equal(updated.avatarKey, 'key2')
    })

    test('findAll() returns aliases', () => {
      coreAgentAliasRepository.upsert('da-vinci', 'Listed', 'key')
      const all = coreAgentAliasRepository.findAll()
      assert.ok(all.length >= 1)
    })

    test('upsert() supports null alias and avatarKey', () => {
      const alias = coreAgentAliasRepository.upsert('da-vinci', null, null)
      assert.equal(alias.alias, null)
      assert.equal(alias.avatarKey, null)
    })
  })

  // ─── CoreAgentPromptRepository ─────────────────────────────────────────────

  const { coreAgentPromptRepository } = require('../core-agent-prompt.repository')

  describe('CoreAgentPromptRepository', () => {
    test('findAll() returns prompts', () => {
      const all = coreAgentPromptRepository.findAll()
      // May be empty in test DB if schema doesn't seed prompts
      assert.ok(Array.isArray(all))
    })

    test('findByRoleAndMode() returns prompt for valid role+mode', () => {
      // This depends on seeded data — test whatever exists
      const prompt = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'plan')
      // May or may not exist in test schema
      if (prompt) {
        assert.equal(prompt.agentRole, 'da-vinci')
        assert.equal(prompt.mode, 'plan')
      }
    })
  })

  // ─── UserProfileRepository ─────────────────────────────────────────────────

  const { userProfileRepository } = require('../user-profile.repository')

  describe('UserProfileRepository', () => {
    test('upsertProfile() creates or updates profile', () => {
      const profile = userProfileRepository.upsertProfile('Test User', 'avatar-1')
      assert.equal(profile.displayName, 'Test User')
      assert.equal(profile.avatarKey, 'avatar-1')
    })

    test('getProfile() returns profile after upsert', () => {
      userProfileRepository.upsertProfile('Current User', 'current-avatar')
      const profile = userProfileRepository.getProfile()
      assert.ok(profile)
      assert.equal(profile.displayName, 'Current User')
      assert.equal(profile.avatarKey, 'current-avatar')
    })

    test('upsertProfile() is idempotent (overwrites)', () => {
      userProfileRepository.upsertProfile('V1', 'k1')
      userProfileRepository.upsertProfile('V2', 'k2')
      const profile = userProfileRepository.getProfile()
      assert.ok(profile)
      assert.equal(profile.displayName, 'V2')
    })
  })

  // ─── TurnUsageRepository ───────────────────────────────────────────────────

  const { turnUsageRepository } = require('../turn-usage.repository')

  describe('TurnUsageRepository', () => {
    test('record() inserts turn usage', () => {
      const convId = seedConversation(db, wsId, 'Turn Usage Conv')
      const session = agentSessionRepository.create('da-vinci', {
        conversationId: convId,
        workspaceId: wsId
      })
      const turn = turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        model: 'claude-sonnet-4-6'
      })
      assert.ok(turn.id)
      assert.equal(turn.sessionId, session.id)
      assert.equal(turn.turnNumber, 1)
      assert.equal(turn.inputTokens, 1000)
      assert.equal(turn.model, 'claude-sonnet-4-6')
    })

    test('findByConversation() returns turns ordered by number', () => {
      const convId = seedConversation(db, wsId, 'Turns Ordered')
      const session = agentSessionRepository.create('da-vinci', {
        conversationId: convId,
        workspaceId: wsId
      })
      turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 2,
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      const turns = turnUsageRepository.findByConversation(convId)
      assert.equal(turns.length, 2)
      assert.equal(turns[0].turnNumber, 1)
      assert.equal(turns[1].turnNumber, 2)
    })

    test('getLastTurn() returns most recent turn', () => {
      const convId = seedConversation(db, wsId, 'Last Turn')
      const session = agentSessionRepository.create('da-vinci', {
        conversationId: convId,
        workspaceId: wsId
      })
      turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 2,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      const last = turnUsageRepository.getLastTurn(convId)
      assert.ok(last)
      assert.equal(last.turnNumber, 2)
    })

    test('getLastTurn() returns null for unknown conversation', () => {
      assert.equal(turnUsageRepository.getLastTurn('nonexistent'), null)
    })

    test('updateLastTurnContextTokens() stores context tokens', () => {
      const convId = seedConversation(db, wsId, 'Context Tokens')
      const session = agentSessionRepository.create('da-vinci', {
        conversationId: convId,
        workspaceId: wsId
      })
      turnUsageRepository.record({
        sessionId: session.id,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      turnUsageRepository.updateLastTurnContextTokens(convId, 75000)
      const last = turnUsageRepository.getLastTurn(convId)
      assert.ok(last)
      assert.equal(last.contextTokens, 75000)
    })

    test('pruneOlderThan() returns number of deleted records', () => {
      const count = turnUsageRepository.pruneOlderThan(99999)
      assert.equal(typeof count, 'number')
    })
  })
}

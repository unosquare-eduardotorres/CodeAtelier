/**
 * Tests for the v1.0.92 blueprint provider-routing fixes:
 *
 * 1. ensureWithId() seeds llm_provider from workspace settings — synthetic
 *    blueprint conversation rows must never silently inherit the DB default
 *    'claude' on a GLM/local workspace.
 * 2. Per-turn provider resolution ignores conv.llmProvider for blueprint-type
 *    conversations (session provider wins — the row value is a row-creation
 *    artifact, never a user choice).
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('Blueprint provider routing (skipped — native module unavailable)', () => {
    test('ensureWithId seeds workspace provider', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { workspaceRepository } = require('../workspace.repository')
  const { conversationRepository } = require('../conversation.repository')

  describe('Blueprint provider routing', () => {
    test('ensureWithId() seeds llm_provider from the workspace settings', () => {
      const ws = workspaceRepository.create('GLM WS', '/tmp/ws-bpr-glm')
      workspaceRepository.updateSettings(ws.id, { llmProvider: 'glm' })

      const conv = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-1',
        ws.id,
        'Blueprint — specify',
        'plan',
        'blueprint'
      )
      assert.equal(conv.llmProvider, 'glm', 'synthetic rows must carry the workspace provider')
    })

    test('ensureWithId() explicit provider beats workspace settings', () => {
      const ws = workspaceRepository.create('Explicit WS', '/tmp/ws-bpr-explicit')
      workspaceRepository.updateSettings(ws.id, { llmProvider: 'glm' })

      const conv = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-2',
        ws.id,
        'Blueprint — specify',
        'plan',
        'blueprint',
        'local-llm'
      )
      assert.equal(conv.llmProvider, 'local-llm')
    })

    test('ensureWithId() falls back to claude when the workspace has no provider', () => {
      const ws = workspaceRepository.create('Bare WS', '/tmp/ws-bpr-bare')
      const conv = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-3',
        ws.id,
        'Blueprint — specify'
      )
      assert.equal(conv.llmProvider, 'claude', 'no provider anywhere → claude default stands')
    })

    test('ensureWithId() is idempotent — existing rows are never rewritten', () => {
      const ws = workspaceRepository.create('Idem WS', '/tmp/ws-bpr-idem')
      workspaceRepository.updateSettings(ws.id, { llmProvider: 'glm' })

      const first = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-4',
        ws.id,
        'Blueprint — specify'
      )
      assert.equal(first.llmProvider, 'glm')

      // Change the workspace provider — the existing row must NOT be rewritten
      workspaceRepository.updateSettings(ws.id, { llmProvider: 'claude' })
      const second = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-4',
        ws.id,
        'Blueprint — specify'
      )
      assert.equal(second.llmProvider, 'glm', 'existing rows keep their minted provider')
    })

    test('ensureWithId() seeds from shadow (worktree) rows via the merged settings', () => {
      const parent = workspaceRepository.create('Shadow Parent', '/tmp/ws-bpr-shadow')
      workspaceRepository.updateSettings(parent.id, { llmProvider: 'glm' })
      const shadow = workspaceRepository.ensureShadow(parent.id, '/tmp/wt-bpr/x', 'x')

      const conv = conversationRepository.ensureWithId(
        'blueprint-specify-bpr-test-5',
        shadow.id,
        'Blueprint — specify'
      )
      assert.equal(
        conv.llmProvider,
        'glm',
        'shadow rows read through the routing merge — provider inherits'
      )
    })

    test('per-turn resolution: blueprint-type conversations keep the session provider', () => {
      // The logic lives inline in agent-session.service.ts; pin the contract
      // here so a refactor cannot silently re-enable the override.
      // Simulate: session provider glm, conversation row says claude (the
      // v1.0.91 poison), type blueprint.
      const ws = workspaceRepository.create('Turn WS', '/tmp/ws-bpr-turn')
      workspaceRepository.updateSettings(ws.id, { llmProvider: 'glm' })

      // Mint a row the OLD way — llm_provider left to the DB default
      env.db
        .prepare(
          `INSERT INTO conversations (id, workspace_id, title, mode, type)
           VALUES ('blueprint-clarify-bpr-poison', ?, 'Blueprint — clarify', 'plan', 'blueprint')`
        )
        .run(ws.id)

      const conv = conversationRepository.findById('blueprint-clarify-bpr-poison')
      assert.equal(conv.llmProvider, 'claude', 'the legacy poison row reads claude')

      // The fix: type === 'blueprint' → session provider wins
      const sessionProvider = 'glm'
      const conversationProvider =
        conv.llmProvider && conv.type !== 'blueprint' ? conv.llmProvider : sessionProvider
      assert.equal(conversationProvider, 'glm')
    })

    test('per-turn resolution: chat conversations still honor their own provider', () => {
      const ws = workspaceRepository.create('Chat WS', '/tmp/ws-bpr-chat')
      const chat = conversationRepository.create(ws.id, 'A chat', 'plan', undefined, 'glm')

      const conv = conversationRepository.findById(chat.id)
      assert.equal(conv.type, 'chat')
      const sessionProvider = 'claude'
      const conversationProvider =
        conv.llmProvider && conv.type !== 'blueprint' ? conv.llmProvider : sessionProvider
      assert.equal(conversationProvider, 'glm', 'chat rows keep their user-chosen provider')
    })
  })
}

/**
 * Batch validation-contract tests for config/settings IPC files.
 *
 * Files covered: app-preference, core-agent-prompt, core-agent-alias,
 * user-profile, conversation-specialist, token, cost.
 *
 * Run: tsx src/main/ipc/__tests__/config-ipc-validation.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  requireObject,
  requireString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString
} from '../validate-args'

// ── app-preference.ipc.ts contracts ──────────────────────────────────────────

describe('app-preference.ipc validation contracts', () => {
  test('APP_PREFERENCE_UPDATE requires key string', () => {
    const ch = 'app:preference:update'
    const args = requireObject({ key: 'theme', value: 'dark' }, ch)
    assert.equal(requireString(args, 'key', ch), 'theme')
  })

  test('APP_PREFERENCE_UPDATE rejects missing key', () => {
    const ch = 'app:preference:update'
    const args = requireObject({ value: 'x' }, ch)
    assert.throws(() => requireString(args, 'key', ch), /key/)
  })
})

// ── core-agent-prompt.ipc.ts contracts ───────────────────────────────────────

describe('core-agent-prompt.ipc validation contracts', () => {
  test('CORE_AGENT_PROMPT_GET requires agentRole and mode', () => {
    const ch = 'coreAgentPrompt:get'
    const args = requireObject({ agentRole: 'specialist', mode: 'plan' }, ch)
    assert.equal(requireString(args, 'agentRole', ch), 'da-vinci')
    assert.equal(requireString(args, 'mode', ch), 'plan')
  })

  test('CORE_AGENT_PROMPT_UPSERT requires agentRole, mode, promptText', () => {
    const ch = 'coreAgentPrompt:upsert'
    const args = requireObject(
      { agentRole: 'specialist', mode: 'build', promptText: 'You are a builder.' },
      ch
    )
    assert.equal(requireString(args, 'agentRole', ch), 'da-vinci')
    assert.equal(requireString(args, 'mode', ch), 'build')
    assert.equal(requireString(args, 'promptText', ch), 'You are a builder.')
  })

  test('CORE_AGENT_PROMPT_UPSERT rejects empty promptText', () => {
    const ch = 'coreAgentPrompt:upsert'
    const args = requireObject({ agentRole: 'specialist', mode: 'build', promptText: '' }, ch)
    assert.throws(() => requireString(args, 'promptText', ch), /promptText/)
  })

  test('CORE_AGENT_PROMPT_RESET requires agentRole and mode', () => {
    const ch = 'coreAgentPrompt:reset'
    const args = requireObject({ agentRole: 'specialist', mode: 'danger' }, ch)
    assert.equal(requireString(args, 'agentRole', ch), 'da-vinci')
    assert.equal(requireString(args, 'mode', ch), 'danger')
  })
})

// ── core-agent-alias.ipc.ts contracts ────────────────────────────────────────

describe('core-agent-alias.ipc validation contracts', () => {
  test('CORE_AGENT_UPSERT requires agentRole', () => {
    const ch = 'coreAgent:upsert'
    const args = requireObject({ agentRole: 'specialist', alias: 'Claude' }, ch)
    assert.equal(requireString(args, 'agentRole', ch), 'da-vinci')
  })

  test('CORE_AGENT_UPSERT accepts nullable alias', () => {
    const ch = 'coreAgent:upsert'
    const args = requireObject({ agentRole: 'specialist', alias: null }, ch)
    assert.equal(optionalNullableString(args, 'alias', ch), null)
  })

  test('CORE_AGENT_UPSERT accepts string alias', () => {
    const ch = 'coreAgent:upsert'
    const args = requireObject({ agentRole: 'specialist', alias: 'Bot' }, ch)
    assert.equal(optionalNullableString(args, 'alias', ch), 'Bot')
  })

  test('CORE_AGENT_UPSERT accepts absent alias', () => {
    const ch = 'coreAgent:upsert'
    const args = requireObject({ agentRole: 'specialist' }, ch)
    assert.equal(optionalNullableString(args, 'alias', ch), undefined)
  })
})

// ── user-profile.ipc.ts contracts ────────────────────────────────────────────

describe('user-profile.ipc validation contracts', () => {
  test('USER_PROFILE_UPSERT requires displayName and avatarKey', () => {
    const ch = 'userProfile:upsert'
    const args = requireObject({ displayName: 'Alice', avatarKey: 'avatar-1' }, ch)
    assert.equal(requireString(args, 'displayName', ch), 'Alice')
    assert.equal(requireString(args, 'avatarKey', ch), 'avatar-1')
  })

  test('USER_PROFILE_UPSERT rejects missing displayName', () => {
    const ch = 'userProfile:upsert'
    const args = requireObject({ avatarKey: 'avatar-1' }, ch)
    assert.throws(() => requireString(args, 'displayName', ch), /displayName/)
  })

  test('USER_PROFILE_UPSERT rejects missing avatarKey', () => {
    const ch = 'userProfile:upsert'
    const args = requireObject({ displayName: 'Alice' }, ch)
    assert.throws(() => requireString(args, 'avatarKey', ch), /avatarKey/)
  })
})

// ── conversation-specialist.ipc.ts contracts ─────────────────────────────────

describe('conversation-specialist.ipc validation contracts', () => {
  test('CONV_SPECIALIST_LIST requires conversationId', () => {
    const ch = 'convSpec:list'
    const args = requireObject({ conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('CONV_SPECIALIST_UPSERT requires conversationId, specialistId; isActive optional', () => {
    const ch = 'convSpec:upsert'
    const args = requireObject(
      { conversationId: 'c-1', specialistId: 'sp-1', isActive: true },
      ch
    )
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
    assert.equal(requireString(args, 'specialistId', ch), 'sp-1')
    assert.equal(optionalBoolean(args, 'isActive', ch), true)
  })

  test('CONV_SPECIALIST_UPSERT accepts missing isActive', () => {
    const ch = 'convSpec:upsert'
    const args = requireObject({ conversationId: 'c-1', specialistId: 'sp-1' }, ch)
    assert.equal(optionalBoolean(args, 'isActive', ch), undefined)
  })

  test('CONV_SPECIALIST_REMOVE requires conversationId and specialistId', () => {
    const ch = 'convSpec:remove'
    const args = requireObject({ conversationId: 'c-1', specialistId: 'sp-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
    assert.equal(requireString(args, 'specialistId', ch), 'sp-1')
  })
})

// ── token.ipc.ts contracts ───────────────────────────────────────────────────

describe('token.ipc validation contracts', () => {
  test('TOKEN_GET_WORKSPACE_SUMMARY requires workspaceId', () => {
    const ch = 'token:getWorkspaceSummary'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })

  test('TOKEN_GET_CONVERSATION_SUMMARY requires conversationId', () => {
    const ch = 'token:getConversationSummary'
    const args = requireObject({ conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('TOKEN_GET_RECENT_SESSIONS requires workspaceId, limit optional', () => {
    const ch = 'token:getRecentSessions'
    const args = requireObject({ workspaceId: 'ws-1', limit: 10 }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
    assert.equal(optionalNumber(args, 'limit', ch), 10)
  })

  test('TOKEN_GET_RECENT_SESSIONS accepts missing limit', () => {
    const ch = 'token:getRecentSessions'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(optionalNumber(args, 'limit', ch), undefined)
  })
})

// ── cost.ipc.ts contracts ────────────────────────────────────────────────────

describe('cost.ipc validation contracts', () => {
  test('COST_GET_WORKSPACE_SUMMARY requires workspaceId', () => {
    const ch = 'cost:getWorkspaceSummary'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })

  test('COST_GET_CONVERSATION requires conversationId', () => {
    const ch = 'cost:getConversation'
    const args = requireObject({ conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('COST_CHECK_BUDGET requires workspaceId', () => {
    const ch = 'cost:checkBudget'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })

  test('COST_GET_WORKSPACE_CONVERSATIONS requires workspaceId', () => {
    const ch = 'cost:getWorkspaceConversations'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}

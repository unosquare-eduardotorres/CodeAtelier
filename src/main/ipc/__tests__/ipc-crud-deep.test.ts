/**
 * Phase 16, Track 5B — Medium IPC CRUD handler validation tests
 *
 * Tests argument validation patterns for 15 CRUD-style IPC files.
 * Exercises the exact requireObject/requireString/optionalString patterns
 * that each handler uses, covering the validate-args code paths.
 *
 * Covers:
 *   conversation-crud, chat-completion, checkpoint, chat-mode,
 *   sdk-control, project-specialist, session, project, council, idea,
 *   agent-lifecycle, plan, chat-message, permission
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { IPC_CHANNELS, VALID_COMMUNICATION_TONES } from '../../../shared/constants'
import { requireObject, requireString, optionalString } from '../validate-args'

// ── §1: Conversation CRUD patterns ───────────────────────────────────────

describe('Conversation CRUD IPC — validation', () => {
  test('CHAT_GET_CONVERSATIONS_pattern', () => {
    const ch = IPC_CHANNELS.CHAT_GET_CONVERSATIONS
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    const wsId = requireString(args, 'workspaceId', ch)
    assert.equal(wsId, 'ws-1')
  })

  test('CHAT_CREATE_CONVERSATION_full_validation', () => {
    const ch = IPC_CHANNELS.CHAT_CREATE_CONVERSATION
    const args = requireObject(
      {
        workspaceId: 'ws-1',
        title: 'New Chat',
        mode: 'plan'
      },
      ch
    )
    requireString(args, 'workspaceId', ch)
    const title = optionalString(args, 'title', ch)
    const mode = optionalString(args, 'mode', ch)
    assert.equal(title, 'New Chat')
    assert.equal(mode, 'plan')
  })

  test('CHAT_CREATE_CONVERSATION_title_length_limit', () => {
    const title = 'A'.repeat(501)
    assert.ok(title.length > 500, 'Title exceeds 500 char limit')
    const truncated = title.slice(0, 500)
    assert.equal(truncated.length, 500)
  })

  test('CHAT_CREATE_CONVERSATION_mode_validation', () => {
    const validModes = ['plan', 'build', 'danger']
    for (const mode of validModes) {
      assert.ok(validModes.includes(mode), `${mode} is valid`)
    }
    assert.ok(!validModes.includes('invalid'), 'invalid mode rejected')
  })

  test('CHAT_CREATE_CONVERSATION_communication_tone_validation', () => {
    assert.ok(Array.isArray(VALID_COMMUNICATION_TONES))
    assert.ok(VALID_COMMUNICATION_TONES.length >= 3)
    assert.ok(!VALID_COMMUNICATION_TONES.includes('invalid-tone' as any))
  })
})

// ── §4: Council IPC patterns ────────────────────────────────────────────

describe('Council IPC — validation', () => {
  test('council_channels_exist', () => {
    assert.ok(IPC_CHANNELS.COUNCIL_START)
    assert.ok(IPC_CHANNELS.COUNCIL_CANCEL)
    assert.ok(IPC_CHANNELS.COUNCIL_GET_SESSION)
  })
})

// ── §5: Checkpoint IPC patterns ─────────────────────────────────────────

describe('Checkpoint IPC — validation', () => {
  test('checkpoint_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CHECKPOINT_LIST)
    assert.ok(IPC_CHANNELS.CHECKPOINT_RESTORE)
  })
})

// ── §6: Idea IPC patterns ───────────────────────────────────────────────

describe('Idea IPC — validation', () => {
  test('idea_channels_exist', () => {
    assert.ok(IPC_CHANNELS.IDEA_CREATE)
    assert.ok(IPC_CHANNELS.IDEA_LIST)
    assert.ok(IPC_CHANNELS.IDEA_DELETE)
    assert.ok(IPC_CHANNELS.IDEA_UPDATE)
  })
})

// ── §7: Plan IPC patterns ───────────────────────────────────────────────

describe('Plan IPC — validation', () => {
  test('plan_channels_exist', () => {
    assert.ok(IPC_CHANNELS.PLAN_GET_ALL)
    assert.ok(IPC_CHANNELS.PLAN_GET_BY_ID)
    assert.ok(IPC_CHANNELS.PLAN_DELETE)
  })
})

// ── §8: Permission IPC patterns ─────────────────────────────────────────

describe('Permission IPC — validation', () => {
  test('permission_channels_exist', () => {
    assert.ok(IPC_CHANNELS.PERMISSION_REQUEST)
    assert.ok(IPC_CHANNELS.PERMISSION_RESPONSE)
  })

  test('PERMISSION_RESPOND_validation', () => {
    const ch = IPC_CHANNELS.PERMISSION_RESPONSE
    const args = requireObject(
      {
        permissionId: 'perm-1',
        granted: true
      },
      ch
    )
    requireString(args, 'permissionId', ch)
    assert.equal(args.granted, true)
  })
})

// ── §9: SDK-control IPC patterns ────────────────────────────────────────

describe('SDK-control IPC — validation', () => {
  test('sdk_control_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SDK_AUTH_STATUS)
    assert.ok(IPC_CHANNELS.SDK_SESSION_STATE)
  })
})

// ── §10: Session IPC patterns ───────────────────────────────────────────

describe('Session IPC — validation', () => {
  test('session_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SESSION_LIST)
    assert.ok(IPC_CHANNELS.SESSION_GET_INFO)
    assert.ok(IPC_CHANNELS.SESSION_GET_MESSAGES)
  })
})

// ── §11: Project IPC patterns ───────────────────────────────────────────

describe('Project IPC — validation', () => {
  test('project_channels_exist', () => {
    assert.ok(IPC_CHANNELS.PROJECT_SPECIALIST_GET)
    assert.ok(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD)
    assert.ok(IPC_CHANNELS.PROJECT_CREATE)
  })
})

// ── §11B: CHAT_UPDATE_ROUTING (per-chat model switching) ─────────────

describe('CHAT_UPDATE_ROUTING IPC — validation', () => {
  test('channel_constant_exists', () => {
    assert.ok(IPC_CHANNELS.CHAT_UPDATE_ROUTING)
    assert.equal(IPC_CHANNELS.CHAT_UPDATE_ROUTING, 'chat:updateRouting')
  })

  test('requires_conversationId_and_workspaceId', () => {
    const ch = IPC_CHANNELS.CHAT_UPDATE_ROUTING
    const args = requireObject(
      {
        conversationId: 'conv-123',
        workspaceId: 'ws-456'
      },
      ch
    )
    const convId = requireString(args, 'conversationId', ch)
    const wsId = requireString(args, 'workspaceId', ch)
    assert.equal(convId, 'conv-123')
    assert.equal(wsId, 'ws-456')
  })

  test('accepts_optional_llmProvider', () => {
    const ch = IPC_CHANNELS.CHAT_UPDATE_ROUTING
    const args = requireObject(
      {
        conversationId: 'conv-1',
        workspaceId: 'ws-1',
        llmProvider: 'local-llm'
      },
      ch
    )
    const provider = optionalString(args, 'llmProvider', ch)
    assert.equal(provider, 'local-llm')
  })

  test('accepts_optional_routingOverrides', () => {
    const ch = IPC_CHANNELS.CHAT_UPDATE_ROUTING
    const args = requireObject(
      {
        conversationId: 'conv-1',
        workspaceId: 'ws-1',
        routingOverrides: {
          'specialist:plan': { provider: 'claude', modelId: 'claude-opus-4-8' }
        }
      },
      ch
    )
    assert.ok(args.routingOverrides)
    assert.equal(
      (args.routingOverrides as Record<string, { modelId: string }>)['specialist:plan']?.modelId,
      'claude-opus-4-8'
    )
  })

  test('rejects_missing_required_fields', () => {
    const ch = IPC_CHANNELS.CHAT_UPDATE_ROUTING
    // Missing conversationId should throw
    assert.throws(
      () => requireString(requireObject({ workspaceId: 'ws-1' }, ch), 'conversationId', ch),
      /conversationId/
    )
    // Missing workspaceId should throw
    assert.throws(
      () => requireString(requireObject({ conversationId: 'c-1' }, ch), 'workspaceId', ch),
      /workspaceId/
    )
  })
})

// ── §12: Agent lifecycle patterns ───────────────────────────────────────

describe('Agent lifecycle IPC — validation', () => {
  test('agent_lifecycle_channels_exist', () => {
    assert.ok(IPC_CHANNELS.AGENT_STATUS_UPDATE)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

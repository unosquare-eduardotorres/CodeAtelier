/**
 * Phase 16, Track 5C — Zero-coverage IPC deeper tests
 *
 * Exercises validate-args.ts (all exported functions, all error branches),
 * validate-sender.ts (senderFrame checks), and IPC channel constant shapes.
 *
 * Covers:
 *   validate-args.ts    (148 lines)
 *   validate-sender.ts  (18 lines)
 *   IPC_CHANNELS constant deep verification
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString,
  requireStringArray,
  requirePlainObject
} from '../validate-args'
import { validateSender } from '../validate-sender'

// ── §1: requireObject — all branches ─────────────────────────────────────

describe('validate-args — requireObject', () => {
  test('throws_on_null', () => {
    assert.throws(() => requireObject(null, 'CH'), /expected an object argument, got null/)
  })

  test('throws_on_string', () => {
    assert.throws(() => requireObject('not-obj', 'CH'), /expected an object argument, got string/)
  })

  test('throws_on_undefined', () => {
    assert.throws(
      () => requireObject(undefined, 'CH'),
      /expected an object argument, got undefined/
    )
  })

  test('throws_on_number', () => {
    assert.throws(() => requireObject(42, 'CH'), /expected an object argument, got number/)
  })

  test('throws_on_boolean', () => {
    assert.throws(() => requireObject(true, 'CH'), /expected an object argument, got boolean/)
  })

  test('throws_on_array', () => {
    assert.throws(() => requireObject([1, 2], 'CH'), /expected an object argument, got array/)
  })

  test('returns_plain_object', () => {
    const obj = { key: 'val' }
    const result = requireObject(obj, 'CH')
    assert.deepEqual(result, obj)
  })

  test('returns_empty_object', () => {
    const result = requireObject({}, 'CH')
    assert.deepEqual(result, {})
  })
})

// ── §2: requireString — all branches ──────────────────────────────────────

describe('validate-args — requireString', () => {
  test('returns_valid_string', () => {
    assert.equal(requireString({ name: 'test' }, 'name', 'CH'), 'test')
  })

  test('throws_on_missing_field', () => {
    assert.throws(() => requireString({}, 'name', 'CH'), /must be a non-empty string/)
  })

  test('throws_on_empty_string', () => {
    assert.throws(() => requireString({ name: '' }, 'name', 'CH'), /must be a non-empty string/)
  })

  test('throws_on_number_value', () => {
    assert.throws(() => requireString({ name: 42 }, 'name', 'CH'), /must be a non-empty string/)
  })

  test('throws_on_null_value', () => {
    assert.throws(() => requireString({ name: null }, 'name', 'CH'), /must be a non-empty string/)
  })

  test('returns_whitespace_string', () => {
    // Non-zero length whitespace is valid per implementation
    assert.equal(requireString({ s: '  ' }, 's', 'CH'), '  ')
  })
})

// ── §3: optionalString — all branches ─────────────────────────────────────

describe('validate-args — optionalString', () => {
  test('returns_undefined_when_absent', () => {
    assert.equal(optionalString({}, 'name', 'CH'), undefined)
  })

  test('returns_string_when_present', () => {
    assert.equal(optionalString({ name: 'test' }, 'name', 'CH'), 'test')
  })

  test('returns_empty_string', () => {
    assert.equal(optionalString({ name: '' }, 'name', 'CH'), '')
  })

  test('throws_on_number', () => {
    assert.throws(() => optionalString({ name: 42 }, 'name', 'CH'), /must be a string/)
  })

  test('throws_on_boolean', () => {
    assert.throws(() => optionalString({ name: true }, 'name', 'CH'), /must be a string/)
  })
})

// ── §4: optionalNumber — all branches ─────────────────────────────────────

describe('validate-args — optionalNumber', () => {
  test('returns_undefined_when_absent', () => {
    assert.equal(optionalNumber({}, 'n', 'CH'), undefined)
  })

  test('returns_number_when_present', () => {
    assert.equal(optionalNumber({ n: 10 }, 'n', 'CH'), 10)
  })

  test('returns_zero', () => {
    assert.equal(optionalNumber({ n: 0 }, 'n', 'CH'), 0)
  })

  test('returns_negative', () => {
    assert.equal(optionalNumber({ n: -5 }, 'n', 'CH'), -5)
  })

  test('throws_on_string', () => {
    assert.throws(() => optionalNumber({ n: 'ten' }, 'n', 'CH'), /must be a finite number/)
  })

  test('throws_on_NaN', () => {
    assert.throws(() => optionalNumber({ n: NaN }, 'n', 'CH'), /must be a finite number/)
  })

  test('throws_on_Infinity', () => {
    assert.throws(() => optionalNumber({ n: Infinity }, 'n', 'CH'), /must be a finite number/)
  })
})

// ── §5: optionalBoolean — all branches ────────────────────────────────────

describe('validate-args — optionalBoolean', () => {
  test('returns_undefined_when_absent', () => {
    assert.equal(optionalBoolean({}, 'b', 'CH'), undefined)
  })

  test('returns_true', () => {
    assert.equal(optionalBoolean({ b: true }, 'b', 'CH'), true)
  })

  test('returns_false', () => {
    assert.equal(optionalBoolean({ b: false }, 'b', 'CH'), false)
  })

  test('throws_on_string', () => {
    assert.throws(() => optionalBoolean({ b: 'yes' }, 'b', 'CH'), /must be a boolean/)
  })

  test('throws_on_number', () => {
    assert.throws(() => optionalBoolean({ b: 1 }, 'b', 'CH'), /must be a boolean/)
  })
})

// ── §6: optionalNullableString — all branches ─────────────────────────────

describe('validate-args — optionalNullableString', () => {
  test('returns_undefined_when_absent', () => {
    assert.equal(optionalNullableString({}, 's', 'CH'), undefined)
  })

  test('returns_null_when_null', () => {
    assert.equal(optionalNullableString({ s: null }, 's', 'CH'), null)
  })

  test('returns_string_when_present', () => {
    assert.equal(optionalNullableString({ s: 'test' }, 's', 'CH'), 'test')
  })

  test('throws_on_number', () => {
    assert.throws(
      () => optionalNullableString({ s: 42 }, 's', 'CH'),
      /must be a string, null, or omitted/
    )
  })
})

// ── §7: requireStringArray — all branches ─────────────────────────────────

describe('validate-args — requireStringArray', () => {
  test('returns_valid_string_array', () => {
    const result = requireStringArray({ tags: ['a', 'b', 'c'] }, 'tags', 'CH')
    assert.deepEqual(result, ['a', 'b', 'c'])
  })

  test('throws_on_empty_array', () => {
    assert.throws(() => requireStringArray({ tags: [] }, 'tags', 'CH'), /must be a non-empty array/)
  })

  test('throws_on_non_array', () => {
    assert.throws(
      () => requireStringArray({ tags: 'not-array' }, 'tags', 'CH'),
      /must be a non-empty array/
    )
  })

  test('throws_on_missing_field', () => {
    assert.throws(() => requireStringArray({}, 'tags', 'CH'), /must be a non-empty array/)
  })

  test('throws_on_mixed_types', () => {
    assert.throws(() => requireStringArray({ tags: ['a', 42] }, 'tags', 'CH'), /must be a string/)
  })

  test('single_element_array_is_valid', () => {
    const result = requireStringArray({ tags: ['only'] }, 'tags', 'CH')
    assert.deepEqual(result, ['only'])
  })
})

// ── §8: requirePlainObject — all branches ─────────────────────────────────

describe('validate-args — requirePlainObject', () => {
  test('returns_plain_object', () => {
    const result = requirePlainObject({ config: { key: 'val' } }, 'config', 'CH')
    assert.deepEqual(result, { key: 'val' })
  })

  test('throws_on_null_field', () => {
    assert.throws(
      () => requirePlainObject({ config: null }, 'config', 'CH'),
      /must be a plain object/
    )
  })

  test('throws_on_undefined_field', () => {
    assert.throws(() => requirePlainObject({}, 'config', 'CH'), /must be a plain object/)
  })

  test('throws_on_array_field', () => {
    assert.throws(
      () => requirePlainObject({ config: [1, 2] }, 'config', 'CH'),
      /must be a plain object/
    )
  })

  test('throws_on_string_field', () => {
    assert.throws(
      () => requirePlainObject({ config: 'str' }, 'config', 'CH'),
      /must be a plain object/
    )
  })
})

// ── §9: validateSender — all branches ─────────────────────────────────────

describe('validateSender — branch coverage', () => {
  test('accepts_file_protocol', () => {
    const event = { senderFrame: { url: 'file:///path/to/app.html' } }
    assert.doesNotThrow(() => validateSender(event as never))
  })

  test('accepts_localhost', () => {
    const event = { senderFrame: { url: 'http://localhost:5173/' } }
    assert.doesNotThrow(() => validateSender(event as never))
  })

  test('rejects_https_url', () => {
    const event = { senderFrame: { url: 'https://evil.com' } }
    assert.throws(() => validateSender(event as never), /Unauthorized IPC sender/)
  })

  test('rejects_missing_senderFrame', () => {
    assert.throws(() => validateSender({} as never), /no sender frame/)
  })

  test('rejects_null_senderFrame', () => {
    assert.throws(() => validateSender({ senderFrame: null } as never))
  })
})

// ── §10: IPC channel constant deep verification ──────────────────────────

describe('IPC Channels — deep structure', () => {
  test('app_preference_channels', () => {
    assert.ok(IPC_CHANNELS.APP_PREFERENCE_GET_ALL)
    assert.ok(IPC_CHANNELS.APP_PREFERENCE_SET)
  })

  test('bug_channels', () => {
    assert.ok(IPC_CHANNELS.BUG_REPORT)
    assert.ok(IPC_CHANNELS.BUG_LIST)
    assert.ok(IPC_CHANNELS.BUG_GET)
    assert.ok(IPC_CHANNELS.BUG_RESOLVE)
    assert.ok(IPC_CHANNELS.BUG_UNRESOLVE)
    assert.ok(IPC_CHANNELS.BUG_DELETE)
    assert.ok(IPC_CHANNELS.BUG_UPDATE_NOTE)
    assert.ok(IPC_CHANNELS.BUG_COUNT)
    assert.ok(IPC_CHANNELS.BUG_NEW)
  })

  test('code_graph_channels', () => {
    assert.ok(IPC_CHANNELS.CODE_GRAPH_INDEX_START)
    assert.ok(IPC_CHANNELS.CODE_GRAPH_GET_STATUS)
    assert.ok(IPC_CHANNELS.CODE_GRAPH_HAS_INDEX)
    assert.ok(IPC_CHANNELS.CODE_GRAPH_PROGRESS)
  })

  test('core_agent_channels', () => {
    assert.ok(IPC_CHANNELS.CORE_AGENT_LIST)
    assert.ok(IPC_CHANNELS.CORE_AGENT_UPSERT)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_LIST)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_GET)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_RESET)
  })

  test('cost_channels', () => {
    assert.ok(IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
    assert.ok(IPC_CHANNELS.COST_GET_CONVERSATION)
    assert.ok(IPC_CHANNELS.COST_GET_WORKSPACE_CONVERSATIONS)
    assert.ok(IPC_CHANNELS.COST_CHECK_BUDGET)
  })

  test('embedding_channels', () => {
    assert.ok(IPC_CHANNELS.EMBEDDING_CHECK_STATUS)
    assert.ok(IPC_CHANNELS.EMBEDDING_INITIALIZE)
    assert.ok(IPC_CHANNELS.EMBEDDING_MODEL_READY)
    assert.ok(IPC_CHANNELS.EMBEDDING_MODEL_ERROR)
  })

  test('events_channels', () => {
    assert.ok(IPC_CHANNELS.EVENTS_GET_RECENT)
    assert.ok(IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION)
  })

  test('github_channels', () => {
    assert.ok(IPC_CHANNELS.GITHUB_SAVE_TOKEN)
    assert.ok(IPC_CHANNELS.GITHUB_VALIDATE_TOKEN)
    assert.ok(IPC_CHANNELS.GITHUB_GET_STATUS)
    assert.ok(IPC_CHANNELS.GITHUB_REMOVE_TOKEN)
  })

  test('hooks_channels', () => {
    assert.ok(IPC_CHANNELS.HOOKS_LIST)
    assert.ok(IPC_CHANNELS.HOOKS_RELOAD)
  })

  test('insights_channel', () => {
    assert.ok(IPC_CHANNELS.CONVERSATION_INSIGHTS)
  })

  test('log_channel', () => {
    assert.ok(IPC_CHANNELS.LOG_FROM_RENDERER)
  })

  test('docs_channels', () => {
    assert.ok(IPC_CHANNELS.DOCS_LIST)
  })
})

// ── §11: Argument validation patterns (simulating IPC handler bodies) ────

describe('IPC handler validation patterns', () => {
  test('app_preference_set_validation', () => {
    const rawArgs = { key: 'theme', value: 'dark' }
    const args = requireObject(rawArgs, IPC_CHANNELS.APP_PREFERENCE_SET)
    const key = requireString(args, 'key', IPC_CHANNELS.APP_PREFERENCE_SET)
    assert.equal(key, 'theme')
    assert.equal(typeof args.value, 'string')
  })

  test('cost_handler_validation', () => {
    const args = requireObject({ workspaceId: 'ws-1' }, IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
    const wsId = requireString(args, 'workspaceId', IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
    assert.equal(wsId, 'ws-1')
  })

  test('bug_report_validation', () => {
    const input = { errorMessage: 'test', process: 'main', appVersion: '1.0.0' }
    const args = requireObject(input, IPC_CHANNELS.BUG_REPORT)
    requireString(args, 'errorMessage', IPC_CHANNELS.BUG_REPORT)
    requireString(args, 'process', IPC_CHANNELS.BUG_REPORT)
    requireString(args, 'appVersion', IPC_CHANNELS.BUG_REPORT)
    assert.ok(true)
  })

  test('bug_get_validation', () => {
    const args = requireObject({ id: 'bug-123' }, IPC_CHANNELS.BUG_GET)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_GET)
    assert.equal(id, 'bug-123')
  })

  test('events_optional_args_pattern', () => {
    // With optional workspace filter
    const args = requireObject({ workspaceId: 'ws-1', limit: 50 }, IPC_CHANNELS.EVENTS_GET_RECENT)
    const wsId = optionalString(args, 'workspaceId', IPC_CHANNELS.EVENTS_GET_RECENT)
    const limit = optionalNumber(args, 'limit', IPC_CHANNELS.EVENTS_GET_RECENT) ?? 200
    assert.equal(wsId, 'ws-1')
    assert.equal(limit, 50)
  })

  test('hooks_reload_validation', () => {
    const args = requireObject({ workspacePath: '/tmp/test' }, IPC_CHANNELS.HOOKS_RELOAD)
    const wsPath = requireString(args, 'workspacePath', IPC_CHANNELS.HOOKS_RELOAD)
    assert.equal(wsPath, '/tmp/test')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

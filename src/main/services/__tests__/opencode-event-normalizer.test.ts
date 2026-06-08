/**
 * Unit tests for opencode-event-normalizer.ts — maps OpenCode SSE events to
 * StreamChunks via a dispatch table.
 *
 * Pure logic (electron-log is import-safe under tsx) — runs from the harness.
 *
 * Coverage:
 *  - Dispatch per event type (text part, tool-invocation, thinking, status).
 *  - Transient vs permanent error classification + rate_limit emission.
 *  - Child/subagent session filtering + foreign session drop.
 *  - 2% context-delta gating on session.updated.
 *  - thinking→text turn_boundary emission (F16).
 *  - Missing type/properties → [].
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  normalizeOpenCodeEvent,
  type ExecutorTokenUsage,
  type NormalizerState
} from '../opencode-event-normalizer'

function freshState(overrides: Partial<NormalizerState> = {}): NormalizerState {
  return {
    childSessions: new Map(),
    sessionMap: new Map(),
    ...overrides
  }
}

function freshUsage(): ExecutorTokenUsage {
  return { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

const SID = 'session-1'

describe('normalizeOpenCodeEvent — guards & dispatch', () => {
  test('missing type returns []', () => {
    const out = normalizeOpenCodeEvent({ properties: {} }, SID, freshUsage(), freshState())
    assert.deepEqual(out, [])
  })

  test('missing properties returns []', () => {
    const out = normalizeOpenCodeEvent({ type: 'session.idle' }, SID, freshUsage(), freshState())
    assert.deepEqual(out, [])
  })

  test('unknown event type returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'some.unknown.event', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('text part emits a text chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'text', content: 'hello' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
    assert.equal(out[0].content, 'hello')
  })

  test('tool-invocation call emits tool_use', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool-invocation', state: 'call', toolName: 'Bash', toolCallId: 't1' }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'tool_use')
    assert.equal(out[0].toolName, 'Bash')
  })

  test('tool-invocation result emits tool_result + tool_use_summary', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool-invocation',
            state: 'result',
            toolName: 'Read',
            toolCallId: 't2',
            result: 'a\nb\nc',
            args: { file_path: 'x.ts' }
          }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    const types = out.map((c) => c.type)
    assert.ok(types.includes('tool_result'))
    assert.ok(types.includes('tool_use_summary'))
  })

  test('thinking part emits a thinking chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'reasoning', content: 'hmm' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'thinking')
  })

  test('session.status maps known statuses', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: 'generating' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].content, 'writing')
  })
})

describe('normalizeOpenCodeEvent — turn boundary (F16)', () => {
  test('thinking→text emits a turn_boundary before the text', () => {
    const state = freshState({ lastPartType: 'thinking', hasPriorText: true })
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'text', content: 'answer' } } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].type, 'turn_boundary')
    assert.equal(out[1].type, 'text')
  })
})

describe('normalizeOpenCodeEvent — error classification', () => {
  test('transient error emits api_retry', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: 'server overloaded, try again' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'api_retry')
  })

  test('rate-limit error additionally emits rate_limit', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: 'rate limit exceeded (429)' } },
      SID,
      freshUsage(),
      freshState()
    )
    const types = out.map((c) => c.type)
    assert.ok(types.includes('api_retry'))
    assert.ok(types.includes('rate_limit'))
  })

  test('permanent error emits error', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: 'invalid api key' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'error')
    assert.equal(out[0].error, 'invalid api key')
  })
})

describe('normalizeOpenCodeEvent — context delta gating', () => {
  test('updates token usage and emits context_usage_update past 2% delta', () => {
    const usage = freshUsage()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.updated',
        properties: {
          usage: { inputTokens: 10000, contextWindowSize: 100000, outputTokens: 50 }
        }
      },
      SID,
      usage,
      freshState()
    )
    assert.equal(usage.input, 10000)
    assert.equal(usage.output, 50)
    const update = out.find((c) => c.type === 'context_usage_update')
    assert.ok(update)
    assert.equal(update!.contextUsageUpdate!.percentage, 10)
  })

  test('sub-2% delta from last percentage is suppressed', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.updated',
        properties: { usage: { inputTokens: 10000, contextWindowSize: 100000 } }
      },
      SID,
      freshUsage(),
      freshState({ lastContextPercentage: 9 }) // 10% vs 9% = 1% delta < 2%
    )
    assert.equal(
      out.find((c) => c.type === 'context_usage_update'),
      undefined
    )
  })
})

describe('normalizeOpenCodeEvent — session filtering', () => {
  test('foreign (non-child) session events are dropped', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { sessionID: 'other-session', part: { type: 'text', content: 'x' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('child session text is re-tagged as subagent_progress', () => {
    const state = freshState()
    state.childSessions.set(SID, new Set(['child-1']))
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { sessionID: 'child-1', part: { type: 'text', content: 'sub work' } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].type, 'subagent_progress')
    assert.ok(out[0].content!.includes('sub work'))
  })

  test('child session idle emits subagent_complete', () => {
    const state = freshState()
    state.childSessions.set(SID, new Set(['child-1']))
    const out = normalizeOpenCodeEvent(
      { type: 'session.idle', properties: { sessionID: 'child-1' } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].type, 'subagent_complete')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

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

// ── Expanded coverage (Round 4) ──

describe('normalizeOpenCodeEvent — handleTextPart edge cases', () => {
  test('thinking→text boundary WITHOUT hasPriorText does NOT emit turn_boundary', () => {
    const state = freshState({ lastPartType: 'thinking', hasPriorText: false })
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'text', content: 'first text' } } },
      SID,
      freshUsage(),
      state
    )
    // Should only have the text chunk, no turn_boundary
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
  })

  test('empty text content returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'text', content: '' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('text part sets lastPartType to text and hasPriorText to true', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'text', content: 'hi' } } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(state.lastPartType, 'text')
    assert.equal(state.hasPriorText, true)
  })
})

describe('normalizeOpenCodeEvent — handleToolInvocationPart edge cases', () => {
  test('partial state with args emits tool_progress', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool-invocation',
            state: 'partial',
            toolName: 'Bash',
            toolCallId: 't3',
            args: { command: 'ls -la' }
          }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    const progress = out.find((c) => c.type === 'tool_progress')
    assert.ok(progress, 'should emit tool_progress for partial state')
    assert.equal(progress!.toolName, 'Bash')
  })

  test('result state with missing toolName uses "unknown"', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool-invocation',
            state: 'result',
            toolCallId: 't4',
            result: 'done'
          }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    const toolResult = out.find((c) => c.type === 'tool_result')
    assert.ok(toolResult)
    assert.equal(toolResult!.toolName, 'unknown')
  })
})

describe('normalizeOpenCodeEvent — handleThinkingPart edge cases', () => {
  test('empty thinking content returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'thinking', content: '' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('reasoning type maps to thinking', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'reasoning', content: 'pondering' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'thinking')
    assert.equal(out[0].content, 'pondering')
  })
})

describe('normalizeOpenCodeEvent — handleStructuredOutputPart', () => {
  test('uses .result fallback when .content is missing', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'structured_output', result: { key: 'value' }, schemaName: 'test' }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'structured_output')
    assert.ok(out[0].content!.includes('key'))
  })

  test('returns [] when no content/data/result', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'structured-output' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })
})

describe('normalizeOpenCodeEvent — handleSessionUpdated edge cases', () => {
  test('finishReason=length emits compact_boundary', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.updated',
        properties: {
          finishReason: 'length',
          usage: { inputTokens: 50000, contextWindowSize: 200000 }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    const boundary = out.find((c) => c.type === 'compact_boundary')
    assert.ok(boundary, 'should emit compact_boundary on finishReason=length')
  })

  test('zero contextWindowSize suppresses context_usage_update', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.updated',
        properties: { usage: { inputTokens: 100, contextWindowSize: 0 } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(
      out.find((c) => c.type === 'context_usage_update'),
      undefined
    )
  })
})

describe('normalizeOpenCodeEvent — handleSessionError edge cases', () => {
  test('missing error property returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })
})

describe('normalizeOpenCodeEvent — handleSessionCompacted', () => {
  test('with usage data emits context_usage_update with real values', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.compacted',
        properties: {
          usage: { inputTokens: 30000, contextWindowSize: 200000, cacheReadInputTokens: 5000, cacheCreationInputTokens: 1000 }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    const update = out.find((c) => c.type === 'context_usage_update')
    assert.ok(update)
    assert.equal(update!.contextUsageUpdate!.contextWindowSize, 200000)
  })

  test('without usage data emits estimated 30% fallback', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.compacted', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    const update = out.find((c) => c.type === 'context_usage_update')
    assert.ok(update)
    assert.equal(update!.contextUsageUpdate!.percentage, 30)
  })
})

describe('normalizeOpenCodeEvent — handleSessionIdle edge cases', () => {
  test('unknown finishReason passes through as-is', () => {
    const state = freshState({ lastFinishReason: 'custom_reason' })
    const out = normalizeOpenCodeEvent(
      { type: 'session.idle', properties: {} },
      SID,
      freshUsage(),
      state
    )
    const finishChunk = out.find((c) => c.content?.includes('finishReason:'))
    assert.ok(finishChunk)
    assert.ok(finishChunk!.content!.includes('custom_reason'))
  })

  test('no lastFinishReason → only idle status emitted', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.idle', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].content, 'idle')
  })
})

describe('normalizeOpenCodeEvent — handleSessionStatus edge cases', () => {
  test('unknown status passes through as-is', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: 'custom_status' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].content, 'custom_status')
  })

  test('null/missing status returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })
})

describe('normalizeOpenCodeEvent — handleSessionCreated edge cases', () => {
  test('missing childId returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.created', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('uses parentID when provided, falls back to sessionId', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      { type: 'session.created', properties: { id: 'child-1', parentID: 'parent-x' } },
      SID,
      freshUsage(),
      state
    )
    // Should track under parentID, not SID
    assert.ok(state.childSessions.has('parent-x'))
    assert.ok(state.childSessions.get('parent-x')!.has('child-1'))
  })

  test('falls back to sessionId when no parentID', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      { type: 'session.created', properties: { id: 'child-2' } },
      SID,
      freshUsage(),
      state
    )
    assert.ok(state.childSessions.has(SID))
    assert.ok(state.childSessions.get(SID)!.has('child-2'))
  })
})

describe('normalizeOpenCodeEvent — child session re-tagging', () => {
  test('child session tool_use is re-tagged as subagent_progress', () => {
    const state = freshState()
    state.childSessions.set(SID, new Set(['child-1']))
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child-1',
          part: { type: 'tool-invocation', state: 'call', toolName: 'Read', toolCallId: 't5' }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.ok(out.length > 0)
    assert.equal(out[0].type, 'subagent_progress')
  })

  test('child session deleted emits subagent_complete', () => {
    const state = freshState()
    state.childSessions.set(SID, new Set(['child-1']))
    const out = normalizeOpenCodeEvent(
      { type: 'session.deleted', properties: { sessionID: 'child-1' } },
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

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

  test('sub-2% delta from last percentage is emitted (no gating)', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.updated',
        properties: { usage: { inputTokens: 10000, contextWindowSize: 100000 } }
      },
      SID,
      freshUsage(),
      freshState({ lastContextPercentage: 9 }) // Was 10% vs 9% = 1% delta < 2%
    )
    const update = out.find((c) => c.type === 'context_usage_update')
    assert.ok(update)
    assert.equal(update!.contextUsageUpdate!.percentage, 10)
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
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', content: 'first text' } }
      },
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

// ── R5: Modern SDK ToolPart (type: 'tool') ──

describe('normalizeOpenCodeEvent — handleToolPart (modern SDK)', () => {
  test('pending→running→completed emits exactly 1 tool_use + 1 tool_result', () => {
    const state = freshState()

    // pending (no input yet) → nothing emitted
    const out1 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: { status: 'pending' }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out1, [], 'pending without input should emit nothing')

    // running (input present) → tool_use
    const out2 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: { status: 'running', input: { command: 'ls -la' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out2.length, 1)
    assert.equal(out2[0].type, 'tool_use')
    assert.equal(out2[0].toolName, 'bash')
    assert.equal(out2[0].toolId, 'call-1')
    assert.ok(out2[0].toolInput!.includes('ls -la'))

    // completed → tool_result + tool_use_summary (no second tool_use)
    const out3 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: {
              status: 'completed',
              input: { command: 'ls -la' },
              output: 'hello.ts\nindex.ts'
            }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const types3 = out3.map((c) => c.type)
    assert.ok(types3.includes('tool_result'), 'completed should emit tool_result')
    assert.ok(!types3.includes('tool_use'), 'completed should NOT emit second tool_use')
    const result = out3.find((c) => c.type === 'tool_result')!
    assert.equal(result.toolName, 'bash')
    assert.equal(result.content, 'hello.ts\nindex.ts')
  })

  test('error status emits tool_use + tool_result with error content', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read',
            callID: 'call-err',
            state: {
              status: 'error',
              input: { file_path: '/nonexistent' },
              error: 'ENOENT: no such file'
            }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const toolUse = out.find((c) => c.type === 'tool_use')!
    assert.ok(toolUse, 'error state should still emit tool_use')
    assert.equal(toolUse.toolName, 'read')

    const toolResult = out.find((c) => c.type === 'tool_result')!
    assert.ok(toolResult, 'error state should emit tool_result')
    assert.ok(toolResult.content!.includes('ENOENT'))
  })

  test('pending with input does NOT emit tool_use (R6-A2: pending args are incomplete)', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'write',
            callID: 'call-p',
            state: { status: 'pending', input: { file_path: 'test.ts', content: 'hi' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out, [], 'pending should never emit tool_use even with input')
  })

  test('missing tool/callID/state returns []', () => {
    const state = freshState()
    // Missing tool
    const out1 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'tool', callID: 'c', state: { status: 'running' } } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out1, [])

    // Missing callID
    const out2 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'tool', tool: 'bash', state: { status: 'running' } } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out2, [])

    // Missing state
    const out3 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'tool', tool: 'bash', callID: 'c' } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out3, [])
  })

  test('completed with no output emits tool_result with empty string', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-empty',
            state: { status: 'completed', input: { command: 'true' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const result = out.find((c) => c.type === 'tool_result')!
    assert.ok(result)
    assert.equal(result.content, '""')
  })

  test('sets lastPartType to tool on first tool_use emission', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-lpt',
            state: { status: 'running', input: { command: 'echo' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(state.lastPartType, 'tool')
  })

  test('string input is passed through as-is (not double-stringified)', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-str',
            state: { status: 'running', input: 'ls -la' }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].toolInput, 'ls -la')
  })
})

describe('normalizeOpenCodeEvent — state persistence (R6-A1)', () => {
  test('dedupe sets survive across multiple events (same state object)', () => {
    const state = freshState()

    // First event: running → emits tool_use
    const out1 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-persist',
            state: { status: 'running', input: { command: 'echo hi' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out1.length, 1)
    assert.equal(out1[0].type, 'tool_use')

    // Second event with same callID: completed → emits tool_result but NOT a second tool_use
    const out2 = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-persist',
            state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi' }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const types2 = out2.map((c) => c.type)
    assert.ok(types2.includes('tool_result'), 'completed should emit tool_result')
    assert.ok(!types2.includes('tool_use'), 'should NOT re-emit tool_use for same callID')
  })

  test('session.idle clears dedupe sets for bounded memory', () => {
    const state = freshState()
    state.emittedToolUse = new Set(['call-1', 'call-2'])
    state.emittedToolResult = new Set(['call-1'])

    normalizeOpenCodeEvent({ type: 'session.idle', properties: {} }, SID, freshUsage(), state)

    assert.equal(state.emittedToolUse!.size, 0, 'emittedToolUse should be cleared on idle')
    assert.equal(state.emittedToolResult!.size, 0, 'emittedToolResult should be cleared on idle')
  })
})

describe('normalizeOpenCodeEvent — legacy tool-invocation still works', () => {
  test('tool-invocation call still emits tool_use (backward compat)', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool-invocation', state: 'call', toolName: 'Bash', toolCallId: 'legacy-1' }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'tool_use')
    assert.equal(out[0].toolName, 'Bash')
  })

  test('tool-invocation result still emits tool_result (backward compat)', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool-invocation',
            state: 'result',
            toolName: 'Bash',
            toolCallId: 'legacy-2',
            result: 'output',
            args: { command: 'echo hi' }
          }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.ok(out.some((c) => c.type === 'tool_result'))
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
      {
        type: 'message.part.updated',
        properties: { part: { type: 'reasoning', content: 'pondering' } }
      },
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

  test('R8: empty object error falls back to JSON.stringify', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: { data: { code: 'VISION_UNSUPPORTED' } } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'error')
    assert.ok(out[0].error!.includes('VISION_UNSUPPORTED'), 'should contain the error detail')
    assert.ok(out[0].error!.length > 0, 'error text should not be empty')
  })

  test('R8: error with empty message string falls back to JSON', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: { data: { message: '' } } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'error')
    assert.ok(out[0].error!.length > 0, 'error text should not be empty')
    assert.ok(out[0].error! !== '', 'should not produce empty error')
  })

  test('R8: error with whitespace-only message falls back', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: { message: '   ' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.ok(out[0].error!.trim().length > 0, 'should produce non-whitespace error')
  })

  test('R8: completely empty error object produces descriptive placeholder', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: {} } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].error, 'OpenCode session error (no message)')
  })

  test('R8: non-empty string error passes through unchanged', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.error', properties: { error: 'Connection refused' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].error, 'Connection refused')
  })
})

describe('normalizeOpenCodeEvent — handleSessionCompacted', () => {
  test('with usage data emits context_usage_update with real values', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.compacted',
        properties: {
          usage: {
            inputTokens: 30000,
            contextWindowSize: 200000,
            cacheReadInputTokens: 5000,
            cacheCreationInputTokens: 1000
          }
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

  test('object status is JSON-stringified, not [object Object]', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: { state: 'thinking' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    // JSON string doesn't match statusMap keys, passes through as-is
    assert.ok(out[0].content!.includes('"state"'))
    assert.ok(!out[0].content!.includes('[object Object]'))
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

// ── message.part.delta (V2 streaming) ──

describe('normalizeOpenCodeEvent — message.part.delta', () => {
  test('text delta emits a text chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: 'hello world' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
    assert.equal(out[0].content, 'hello world')
  })

  test('reasoning delta emits a thinking chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'reasoning', delta: 'let me think' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'thinking')
    assert.equal(out[0].content, 'let me think')
  })

  test('thinking field also maps to thinking chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'thinking', delta: 'pondering' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'thinking')
  })

  test('thinking→text delta emits turn_boundary then text', () => {
    const state = freshState({ lastPartType: 'thinking', hasPriorText: true })
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: 'answer' } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out.length, 2)
    assert.equal(out[0].type, 'turn_boundary')
    assert.equal(out[1].type, 'text')
    assert.equal(out[1].content, 'answer')
  })

  test('empty delta returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: '' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('missing delta returns []', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('unknown field returns [] (no crash)', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'image', delta: 'data...' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('text delta sets lastPartType and hasPriorText', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: 'hi' } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(state.lastPartType, 'text')
    assert.equal(state.hasPriorText, true)
  })

  test('reasoning delta sets lastPartType to thinking', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'reasoning', delta: 'hmm' } },
      SID,
      freshUsage(),
      state
    )
    assert.equal(state.lastPartType, 'thinking')
  })
})

// ── session.next.* V2 event bus ──

describe('normalizeOpenCodeEvent — session.next.* handlers', () => {
  test('session.next.agent.switched emits status chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.agent.switched', properties: { agent: 'coder' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    assert.equal(out[0].content, 'agent_switched:coder')
  })

  test('session.next.agent.switched uses name fallback', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.agent.switched', properties: { name: 'reviewer' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].content, 'agent_switched:reviewer')
  })

  test('session.next.model.switched emits status chunk', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.model.switched', properties: { model: 'claude-sonnet-4' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    assert.equal(out[0].content, 'model_switched:claude-sonnet-4')
  })

  test('session.next.agent.switched handles object agent property', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.agent.switched',
        properties: { agent: { name: 'DaVinci', id: 'dav-1' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].content, 'agent_switched:DaVinci')
  })

  test('session.next.model.switched handles object model property', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.model.switched',
        properties: { model: { id: 'claude-sonnet-4', provider: 'anthropic' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].content, 'model_switched:claude-sonnet-4')
  })

  test('session.diff emits session_state, not text', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.diff', properties: { diff: '--- a/file.ts\n+++ b/file.ts' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out[0].type, 'session_state')
    assert.ok(out[0].content!.startsWith('session_diff:'))
  })

  test('session.next.step.ended updates token usage', () => {
    const usage = freshUsage()
    normalizeOpenCodeEvent(
      {
        type: 'session.next.step.ended',
        properties: {
          usage: { inputTokens: 500, outputTokens: 100 }
        }
      },
      SID,
      usage,
      freshState()
    )
    assert.equal(usage.input, 500)
    assert.equal(usage.output, 100)
  })

  test('session.next.step.ended without usage is a no-op', () => {
    const usage = freshUsage()
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.step.ended', properties: {} },
      SID,
      usage,
      freshState()
    )
    assert.deepEqual(out, [])
    assert.equal(usage.input, 0)
  })

  test('session.next.text.delta is a no-op (covered by message.part.delta)', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.text.delta', properties: { delta: 'text' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('session.next.tool.called without callID returns [] (handled by V2 handler)', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.tool.called', properties: { tool: 'Bash' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('session.next.compaction.started is a no-op', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.compaction.started', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('session.next.moved is a no-op', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.next.moved', properties: {} },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })
})

// ── Control signal filtering (CONTROL-SIGNAL-FILTER-02) ──

describe('normalizeOpenCodeEvent — control signal filtering in text deltas', () => {
  test('message.part.delta with {"type":"busy"} text is dropped', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: '{"type":"busy"}' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('message.part.delta with {"type":"idle"} text is dropped', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: '{"type":"idle"}' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('message.part.delta with {"type":"ready"} text is dropped', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: '{"type":"ready"}' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('message.part.delta with {"type":"processing"} text is dropped', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: '{"type":"processing"}' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('control signal with whitespace padding is still dropped', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: '  { "type" : "busy" }  ' }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('legitimate text containing "busy" is NOT dropped', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'text', delta: 'The server is busy.' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
  })

  test('reasoning delta with control signal content is NOT dropped (only text field filtered)', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'message.part.delta', properties: { field: 'reasoning', delta: '{"type":"busy"}' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'thinking')
  })
})

describe('normalizeOpenCodeEvent — control signal filtering in text parts', () => {
  test('message.part.updated text with {"type":"busy"} is dropped', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', content: '{"type":"busy"}' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('message.part.updated text with {"type":"idle"} is dropped', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', content: '{"type":"idle"}' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })

  test('legitimate text in part.updated is NOT dropped', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', content: 'Hello, how can I help?' } }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
    assert.equal(out[0].content, 'Hello, how can I help?')
  })
})

describe('normalizeOpenCodeEvent — busy status mapping', () => {
  test('session.status busy maps to thinking', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: 'busy' } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    assert.equal(out[0].content, 'thinking')
  })
})

describe('normalizeOpenCodeEvent — object status extraction', () => {
  test('session.status with {type:"busy"} object → maps to thinking', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: { type: 'busy' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    assert.equal(out[0].content, 'thinking')
  })

  test('session.status with {type:"idle"} object → maps to idle', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: { type: 'idle' } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    assert.equal(out[0].content, 'idle')
  })

  test('session.status with object without type field → JSON-stringified', () => {
    const out = normalizeOpenCodeEvent(
      { type: 'session.status', properties: { status: { code: 42 } } },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'status')
    // Falls through to JSON.stringify since there's no .type string field
    assert.equal(out[0].content, '{"code":42}')
  })
})

// ── R7: V2 session.next.tool.* handlers ──

describe('normalizeOpenCodeEvent — V2 session.next.tool.called', () => {
  test('session.next.tool.called emits tool_use (deduped)', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: {
          tool: 'Bash',
          callID: 'v2-call-1',
          input: { command: 'echo hello' }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'tool_use')
    assert.equal(out[0].toolName, 'Bash')
    assert.equal(out[0].toolId, 'v2-call-1')
    assert.ok(out[0].toolInput!.includes('echo hello'))
  })

  test('duplicate callID is deduped (no second tool_use)', () => {
    const state = freshState()
    // First call
    normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { tool: 'Bash', callID: 'v2-dup', input: { command: 'ls' } }
      },
      SID,
      freshUsage(),
      state
    )
    // Second call with same callID
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { tool: 'Bash', callID: 'v2-dup', input: { command: 'ls' } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out, [])
  })

  test('property name fallbacks (name instead of tool, id instead of callID)', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { name: 'Read', id: 'v2-fb-1', args: { file_path: 'foo.ts' } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].toolName, 'Read')
    assert.equal(out[0].toolId, 'v2-fb-1')
  })

  test('missing callID returns []', () => {
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { tool: 'Bash' }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.deepEqual(out, [])
  })
})

describe('normalizeOpenCodeEvent — V2 session.next.tool.success', () => {
  test('success emits tool_result + tool_use_summary', () => {
    const state = freshState()
    // Pre-emit tool_use via called
    normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { tool: 'Bash', callID: 'v2-s1', input: { command: 'echo hi' } }
      },
      SID,
      freshUsage(),
      state
    )
    // Now success
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.success',
        properties: {
          tool: 'Bash',
          callID: 'v2-s1',
          output: 'hi',
          input: { command: 'echo hi' }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const types = out.map((c) => c.type)
    assert.ok(types.includes('tool_result'))
    // Should NOT re-emit tool_use (already emitted by called)
    assert.ok(!types.includes('tool_use'))
    const result = out.find((c) => c.type === 'tool_result')!
    assert.equal(result.content, 'hi')
  })

  test('success without prior called also emits tool_use', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.success',
        properties: {
          tool: 'Read',
          callID: 'v2-s2',
          output: 'file content',
          input: { file_path: 'x.ts' }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const types = out.map((c) => c.type)
    assert.ok(types.includes('tool_use'), 'should emit tool_use when called was not seen')
    assert.ok(types.includes('tool_result'))
  })

  test('duplicate callID is deduped (no second tool_result)', () => {
    const state = freshState()
    normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.success',
        properties: { tool: 'Bash', callID: 'v2-s-dup', output: 'hi' }
      },
      SID,
      freshUsage(),
      state
    )
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.success',
        properties: { tool: 'Bash', callID: 'v2-s-dup', output: 'hi' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out, [])
  })
})

describe('normalizeOpenCodeEvent — V2 session.next.tool.failed', () => {
  test('failed emits tool_result with error content', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.failed',
        properties: {
          tool: 'Read',
          callID: 'v2-f1',
          error: 'ENOENT: no such file'
        }
      },
      SID,
      freshUsage(),
      state
    )
    const toolUse = out.find((c) => c.type === 'tool_use')
    assert.ok(toolUse, 'should also emit tool_use')
    const result = out.find((c) => c.type === 'tool_result')!
    assert.ok(result.content!.includes('ENOENT'))
  })

  test('failed with no error uses default message', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.failed',
        properties: { tool: 'Bash', callID: 'v2-f2' }
      },
      SID,
      freshUsage(),
      state
    )
    const result = out.find((c) => c.type === 'tool_result')!
    assert.ok(result.content!.includes('Tool execution failed'))
  })
})

describe('normalizeOpenCodeEvent — V2/V1 cross-bus dedupe', () => {
  test('V1 tool part + V2 tool.called for same callID emits once', () => {
    const state = freshState()

    // V1 fires first (message.part.updated with type: 'tool')
    const v1out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'Bash',
            callID: 'cross-1',
            state: { status: 'running', input: { command: 'ls' } }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(v1out.length, 1)
    assert.equal(v1out[0].type, 'tool_use')

    // V2 fires for the same callID
    const v2out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.called',
        properties: { tool: 'Bash', callID: 'cross-1', input: { command: 'ls' } }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(v2out, [], 'V2 should be deduped since V1 already emitted')
  })

  test('V2 tool.success + V1 completed for same callID emits result once', () => {
    const state = freshState()

    // V2 success fires first
    const v2out = normalizeOpenCodeEvent(
      {
        type: 'session.next.tool.success',
        properties: { tool: 'Bash', callID: 'cross-2', output: 'done' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.ok(v2out.some((c) => c.type === 'tool_result'))

    // V1 completed fires for same callID
    const v1out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'Bash',
            callID: 'cross-2',
            state: { status: 'completed', input: { command: 'ls' }, output: 'done' }
          }
        }
      },
      SID,
      freshUsage(),
      state
    )
    // V1 should NOT re-emit tool_result (already deduped)
    assert.ok(!v1out.some((c) => c.type === 'tool_result'), 'V1 should be deduped for tool_result')
  })
})

// ── R7: Inline <think> block routing ──

describe('normalizeOpenCodeEvent — inline <think> tag routing (R7)', () => {
  test('text delta with <think> block routes content to thinking', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: {
          field: 'text',
          delta: '<think>Let me reason about this</think>The answer is 4'
        }
      },
      SID,
      freshUsage(),
      state
    )
    const thinking = out.find((c) => c.type === 'thinking')
    assert.ok(thinking, 'should emit thinking chunk')
    assert.equal(thinking!.content, 'Let me reason about this')
    const text = out.find((c) => c.type === 'text')
    assert.ok(text, 'should emit text chunk')
    assert.equal(text!.content, 'The answer is 4')
  })

  test('think tag split across two deltas', () => {
    const state = freshState()

    // First delta: opens the think block
    const out1 = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: '<think>Starting to' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out1.length, 1)
    assert.equal(out1[0].type, 'thinking')
    assert.equal(out1[0].content, 'Starting to')
    assert.equal(state.inThinkBlock, true)

    // Second delta: closes the think block + regular text
    const out2 = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: ' think about it</think>Here is the answer' }
      },
      SID,
      freshUsage(),
      state
    )
    const thinking2 = out2.find((c) => c.type === 'thinking')
    assert.ok(thinking2)
    assert.equal(thinking2!.content, ' think about it')
    const text2 = out2.find((c) => c.type === 'text')
    assert.ok(text2)
    assert.equal(text2!.content, 'Here is the answer')
    assert.equal(state.inThinkBlock, false)
  })

  test('no think tags — text passes through unchanged', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: 'Just regular text' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
    assert.equal(out[0].content, 'Just regular text')
  })

  test('think tag in message.part.updated text part also routes', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', content: '<think>reasoning here</think>Final answer' }
        }
      },
      SID,
      freshUsage(),
      state
    )
    const thinking = out.find((c) => c.type === 'thinking')
    assert.ok(thinking)
    assert.equal(thinking!.content, 'reasoning here')
    const text = out.find((c) => c.type === 'text')
    assert.ok(text)
    assert.equal(text!.content, 'Final answer')
  })

  test('thinking→text boundary emits turn_boundary after think block ends', () => {
    const state = freshState({ hasPriorText: true })

    // First: a think block sets lastPartType to 'thinking'
    normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: '<think>reasoning</think>' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(state.lastPartType, 'thinking')

    // Second: regular text should trigger turn_boundary
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: 'The answer' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out[0].type, 'turn_boundary')
    assert.equal(out[1].type, 'text')
  })

  test('only <think> open tag — remaining content is thinking', () => {
    const state = freshState()
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: '<think>deep thoughts' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'thinking')
    assert.equal(state.inThinkBlock, true)
  })

  test('only </think> close tag — exits think mode', () => {
    const state = freshState({ inThinkBlock: true })
    const out = normalizeOpenCodeEvent(
      {
        type: 'message.part.delta',
        properties: { field: 'text', delta: '</think>' }
      },
      SID,
      freshUsage(),
      state
    )
    assert.deepEqual(out, []) // no content between tags
    assert.equal(state.inThinkBlock, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for stream-normalizer — the core generator that converts raw
 * NDJSON messages into StreamChunk events.
 *
 * Uses real ToolTracker + TokenAccountant instances (no mocks). The
 * normalizeMessage generator is pure-ish: it reads/mutates ToolTracker state
 * and accumulates TokenAccountant, but produces no side effects beyond
 * yielded chunks. electron-log is import-safe under tsx.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { normalizeMessage } from '../executor-utils/stream-normalizer'
import type { StreamState } from '../executor-utils/stream-normalizer'
import { ToolTracker } from '../executor-utils/tool-tracker'
import { TokenAccountant } from '../executor-utils/token-accountant'

/** Collect all chunks from the generator into an array. */
function collect(
  msg: Record<string, unknown>,
  tools?: ToolTracker,
  tokens?: TokenAccountant,
  state?: Partial<StreamState>
) {
  const t = tools ?? new ToolTracker()
  const tk = tokens ?? new TokenAccountant()
  const s: StreamState = { streamedTextLength: 0, ...state }
  return [...normalizeMessage(msg, t, tk, s, '/workspace')]
}

/** Helper: create a default StreamState. */
function makeState(overrides: Partial<StreamState> = {}): StreamState {
  return { streamedTextLength: 0, ...overrides }
}

// ── parse_error ──────────────────────────────────────────────────────────────

describe('normalizeMessage — parse_error', () => {
  test('yields error chunk for parse_error type', () => {
    const chunks = collect({ type: 'parse_error', error: 'bad json', raw: '{invalid' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'error')
    assert.ok(chunks[0].error?.includes('Stream parse error'))
  })
})

// ── system/init ──────────────────────────────────────────────────────────────

describe('normalizeMessage — system/init', () => {
  test('captures sessionId from system/init', () => {
    const state = makeState()
    const tools = new ToolTracker()
    const tokens = new TokenAccountant()
    const chunks = [...normalizeMessage(
      { type: 'system', subtype: 'init', session_id: 'sess-123', mcp_servers: [] },
      tools, tokens, state, '/workspace'
    )]
    assert.equal(chunks.length, 0, 'init yields no chunks')
    assert.equal(state.sessionId, 'sess-123')
  })

  test('logs MCP server status without yielding chunks', () => {
    const state = makeState()
    const chunks = [...normalizeMessage(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        mcp_servers: [
          { name: 'code-graph', status: 'connected' },
          { name: 'claude.ai Gmail', status: 'failed' }
        ]
      },
      new ToolTracker(), new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 0)
  })
})

// ── system/task_started, task_progress, task_notification (SubAgent) ─────────

describe('normalizeMessage — SubAgent lifecycle', () => {
  test('task_started yields subagent_start', () => {
    const chunks = collect({
      type: 'system', subtype: 'task_started',
      description: 'Analyzing code', task_id: 'task-1', task_type: 'CodeReview'
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'subagent_start')
    assert.equal(chunks[0].content, 'Analyzing code')
    assert.equal(chunks[0].toolId, 'task-1')
    assert.equal(chunks[0].toolName, 'CodeReview')
  })

  test('task_started with no task_type defaults to Agent', () => {
    const chunks = collect({
      type: 'system', subtype: 'task_started',
      description: 'desc', task_id: 'task-2'
    })
    assert.equal(chunks[0].toolName, 'Agent')
  })

  test('task_progress yields subagent_progress', () => {
    const chunks = collect({
      type: 'system', subtype: 'task_progress',
      summary: 'Found 3 issues', task_id: 'task-1', last_tool_name: 'Grep'
    })
    assert.equal(chunks[0].type, 'subagent_progress')
    assert.equal(chunks[0].content, 'Found 3 issues')
    assert.equal(chunks[0].toolName, 'Grep')
  })

  test('task_progress uses description as fallback content', () => {
    const chunks = collect({
      type: 'system', subtype: 'task_progress',
      description: 'Fallback desc', task_id: 'task-1'
    })
    assert.equal(chunks[0].content, 'Fallback desc')
  })

  test('task_notification yields subagent_complete', () => {
    const chunks = collect({
      type: 'system', subtype: 'task_notification',
      summary: 'Done', task_id: 'task-1', status: 'completed'
    })
    assert.equal(chunks[0].type, 'subagent_complete')
    assert.equal(chunks[0].toolInput, 'completed')
  })
})

// ── assistant ────────────────────────────────────────────────────────────────

describe('normalizeMessage — assistant', () => {
  test('registers tool IDs from assistant message content', () => {
    const tools = new ToolTracker()
    const chunks = [...normalizeMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read' },
            { type: 'text', text: 'hello' }
          ]
        }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 0, 'assistant yields no chunks')
    assert.equal(tools.resolve('tu-1'), 'Read')
  })

  test('handles assistant with no message content gracefully', () => {
    const chunks = collect({ type: 'assistant' })
    assert.equal(chunks.length, 0)
  })
})

// ── stream_event/content_block_delta ─────────────────────────────────────────

describe('normalizeMessage — stream_event/content_block_delta', () => {
  test('text_delta yields text chunk and updates state', () => {
    const tools = new ToolTracker()
    const state = makeState()
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
      },
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(chunks[0].content, 'Hello')
    assert.equal(state.streamedTextLength, 5)
    assert.equal(tools.hasPriorContent, true)
    assert.equal(tools.hasPriorText, true)
  })

  test('thinking_delta yields thinking chunk', () => {
    const chunks = collect({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm...' } }
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'thinking')
    assert.equal(chunks[0].content, 'Hmm...')
  })

  test('json_delta without schema yields text chunk', () => {
    const tools = new ToolTracker()
    const state = makeState()
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'json_delta', json: '{"a":1}' } }
      },
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(chunks[0].content, '{"a":1}')
    assert.equal(state.streamedTextLength, 7)
  })

  test('json_delta with currentSchemaName yields structured_output chunk', () => {
    const tools = new ToolTracker()
    tools.currentSchemaName = 'plan_output'
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'json_delta', json: '{"x":1}' } }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'structured_output')
    assert.deepEqual(chunks[0].structuredOutput, { data: '{"x":1}', schemaName: 'plan_output' })
  })

  test('empty event is ignored', () => {
    const chunks = collect({ type: 'stream_event' })
    assert.equal(chunks.length, 0)
  })
})

// ── stream_event/content_block_start ─────────────────────────────────────────

describe('normalizeMessage — stream_event/content_block_start', () => {
  test('tool_use block yields tool_use chunk and registers tool', () => {
    const tools = new ToolTracker()
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tu-5', name: 'Bash', input: {} }
        }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'tool_use')
    assert.equal(chunks[0].toolName, 'Bash')
    assert.equal(chunks[0].toolId, 'tu-5')
    assert.equal(tools.lastBlockType, 'tool_use')
    assert.equal(tools.hasPriorContent, true)
  })

  test('thinking block sets lastBlockType to thinking', () => {
    const tools = new ToolTracker()
    collect({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } }
    }, tools)
    assert.equal(tools.lastBlockType, 'thinking')
    assert.equal(tools.currentSchemaName, null)
  })

  test('text block after thinking with hasPriorText yields turn_boundary', () => {
    const tools = new ToolTracker()
    tools.lastBlockType = 'thinking'
    tools.hasPriorText = true
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'turn_boundary')
    assert.equal(tools.hasPriorText, false, 'hasPriorText should be reset after boundary')
    assert.equal(tools.lastBlockType, 'text')
  })

  test('text block after thinking without hasPriorText does NOT yield boundary', () => {
    const tools = new ToolTracker()
    tools.lastBlockType = 'thinking'
    tools.hasPriorText = false
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 0)
    assert.equal(tools.lastBlockType, 'text')
  })

  test('tool_use block sets currentSchemaName from name', () => {
    const tools = new ToolTracker()
    collect({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu-6', name: 'plan_schema', input: {} }
      }
    }, tools)
    assert.equal(tools.currentSchemaName, 'plan_schema')
  })
})

// ── stream_event/message_start ───────────────────────────────────────────────

describe('normalizeMessage — stream_event/message_start', () => {
  test('emits turn_boundary when hasPriorText is true', () => {
    const tools = new ToolTracker()
    tools.hasPriorText = true
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 } }
        }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'turn_boundary')
    assert.equal(tools.hasPriorText, false)
  })

  test('does NOT emit turn_boundary when hasPriorText is false', () => {
    const tools = new ToolTracker()
    tools.hasPriorText = false
    tools.hasPriorContent = true // has content but no text
    const tokens = new TokenAccountant()
    const chunks = [...normalizeMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 50 } }
        }
      },
      tools, tokens, makeState(), '/ws'
    )]
    assert.equal(chunks.length, 0)
    assert.equal(tokens.getSummary().input, 50)
  })

  test('accumulates token usage from message_start', () => {
    const tokens = new TokenAccountant()
    collect({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { usage: { input_tokens: 200, cache_read_input_tokens: 100 } }
      }
    }, undefined, tokens)
    const s = tokens.getSummary()
    assert.equal(s.input, 200)
    assert.equal(s.cacheReadInputTokens, 100)
  })
})

// ── stream_event/message_delta ───────────────────────────────────────────────

describe('normalizeMessage — stream_event/message_delta', () => {
  test('accumulates output tokens', () => {
    const tokens = new TokenAccountant()
    collect({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 42 } }
    }, undefined, tokens)
    assert.equal(tokens.getSummary().output, 42)
  })
})

// ── user (tool_result) ───────────────────────────────────────────────────────

describe('normalizeMessage — user/tool_result', () => {
  test('yields tool_result chunks with resolved tool name', () => {
    const tools = new ToolTracker()
    tools.register('tu-10', 'Read', 'src/app.ts')
    const chunks = [...normalizeMessage(
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu-10',
            content: 'file contents here'
          }]
        }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'tool_result')
    assert.equal(chunks[0].toolName, 'Read')
    assert.equal(chunks[0].toolInput, 'src/app.ts')
    assert.equal(chunks[0].content, 'file contents here')
    // consume should have removed the mapping
    assert.equal(tools.resolve('tu-10'), 'Unknown')
  })

  test('handles array content blocks in tool_result', () => {
    const tools = new ToolTracker()
    tools.register('tu-11', 'Grep')
    const chunks = [...normalizeMessage(
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu-11',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'image', data: 'binary' },
              { type: 'text', text: 'line2' }
            ]
          }]
        }
      },
      tools, new TokenAccountant(), makeState(), '/ws'
    )]
    assert.equal(chunks[0].content, 'line1\nline2')
  })

  test('handles user message with no content', () => {
    const chunks = collect({ type: 'user', message: {} })
    assert.equal(chunks.length, 0)
  })
})

// ── result ───────────────────────────────────────────────────────────────────

describe('normalizeMessage — result', () => {
  test('yields text when no prior content was streamed', () => {
    const tools = new ToolTracker()
    const state = makeState()
    const chunks = [...normalizeMessage(
      { type: 'result', result: 'Final answer' },
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(chunks[0].content, 'Final answer')
    assert.equal(state.resultText, 'Final answer')
  })

  test('result-tail-recovery emits missed tail when streamedLength < resultLength', () => {
    const tools = new ToolTracker()
    tools.hasPriorContent = true
    const state = makeState({ streamedTextLength: 5 })
    const chunks = [...normalizeMessage(
      { type: 'result', result: 'Hello, World!' },
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(chunks[0].content, ', World!') // missed tail
    assert.equal(state.streamedTextLength, 13)
  })

  test('no text emitted when result matches streamed length', () => {
    const tools = new ToolTracker()
    tools.hasPriorContent = true
    const state = makeState({ streamedTextLength: 10 })
    const chunks = [...normalizeMessage(
      { type: 'result', result: '0123456789' }, // exactly 10 chars
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 0)
  })

  test('error result with is_error=true yields error chunk', () => {
    const chunks = collect({
      type: 'result', subtype: 'error_max_turns', is_error: true, result: ''
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'error')
    assert.ok(chunks[0].error?.includes('max turns reached'))
  })

  test('error_max_budget_usd yields budget cap message', () => {
    const chunks = collect({
      type: 'result', subtype: 'error_max_budget_usd', is_error: true
    })
    assert.ok(chunks[0].error?.includes('budget cap exceeded'))
  })

  test('error_max_structured_output_retries yields schema validation message', () => {
    const chunks = collect({
      type: 'result', subtype: 'error_max_structured_output_retries', is_error: true
    })
    assert.ok(chunks[0].error?.includes('structured output schema validation failed'))
  })

  test('generic error subtype yields the subtype in the message', () => {
    const chunks = collect({
      type: 'result', subtype: 'some_custom_error', is_error: true
    })
    assert.ok(chunks[0].error?.includes('some_custom_error'))
  })

  test('captures terminal_reason, session_title, and origin', () => {
    const state = makeState()
    const chunks = [...normalizeMessage(
      {
        type: 'result',
        result: 'done',
        terminal_reason: 'blocking_limit',
        session_title: 'My Session',
        origin: 'user_prompt'
      },
      new ToolTracker(), new TokenAccountant(), state, '/ws'
    )]
    assert.equal(state.terminalReason, 'blocking_limit')
    assert.equal(state.sessionTitle, 'My Session')
    assert.equal(state.resultOrigin, 'user_prompt')
  })

  test('sessionTitle camelCase variant is also captured', () => {
    const state = makeState()
    collect({
      type: 'result', result: 'done', sessionTitle: 'CamelTitle'
    }, undefined, undefined, state)
    // Re-run with proper state
    const tools = new ToolTracker()
    const s = makeState()
    const chunks = [...normalizeMessage(
      { type: 'result', result: 'done', sessionTitle: 'CamelTitle' },
      tools, new TokenAccountant(), s, '/ws'
    )]
    assert.equal(s.sessionTitle, 'CamelTitle')
  })

  test('structured_output fallback when result is empty', () => {
    const state = makeState()
    const chunks = [...normalizeMessage(
      { type: 'result', structured_output: { plan: 'test' } },
      new ToolTracker(), new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(state.resultText, '{"plan":"test"}')
  })

  test('structured_output string fallback', () => {
    const state = makeState()
    const chunks = [...normalizeMessage(
      { type: 'result', structured_output: 'raw text output' },
      new ToolTracker(), new TokenAccountant(), state, '/ws'
    )]
    assert.equal(state.resultText, 'raw text output')
  })

  test('blank-bubble detection — no text at all', () => {
    const tools = new ToolTracker()
    tools.hasPriorContent = true
    const state = makeState({ streamedTextLength: 0 })
    // Should not throw — just logs the blank bubble warning
    const chunks = [...normalizeMessage(
      { type: 'result' },
      tools, new TokenAccountant(), state, '/ws'
    )]
    assert.equal(chunks.length, 0)
  })

  test('sets token usage from result', () => {
    const tokens = new TokenAccountant()
    collect({
      type: 'result', result: 'done',
      usage: { input_tokens: 500, output_tokens: 100 }
    }, undefined, tokens)
    const s = tokens.getSummary()
    assert.equal(s.input, 500)
    assert.equal(s.output, 100)
  })
})

// ── tool_progress ────────────────────────────────────────────────────────────

describe('normalizeMessage — tool_progress', () => {
  test('yields tool_progress chunk', () => {
    const chunks = collect({
      type: 'tool_progress',
      tool_use_id: 'tu-20',
      tool_name: 'Bash',
      elapsed_time_seconds: 15
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'tool_progress')
    assert.equal(chunks[0].toolId, 'tu-20')
    assert.equal(chunks[0].toolName, 'Bash')
    assert.equal(chunks[0].elapsedSeconds, 15)
    assert.equal(chunks[0].content, '15s')
  })
})

// ── rate_limit_event ─────────────────────────────────────────────────────────

describe('normalizeMessage — rate_limit_event', () => {
  test('yields rate_limit chunk with info', () => {
    const chunks = collect({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        utilization: 0.85,
        resetsAt: 1234567890,
        rateLimitType: 'token'
      }
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'rate_limit')
    assert.deepEqual(chunks[0].rateLimit, {
      status: 'allowed_warning',
      utilization: 0.85,
      resetsAt: 1234567890,
      rateLimitType: 'token'
    })
  })

  test('no chunk when rate_limit_info is missing', () => {
    const chunks = collect({ type: 'rate_limit_event' })
    assert.equal(chunks.length, 0)
  })
})

// ── system/api_retry ─────────────────────────────────────────────────────────

describe('normalizeMessage — system/api_retry', () => {
  test('yields api_retry chunk', () => {
    const chunks = collect({
      type: 'system', subtype: 'api_retry',
      attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: 429
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'api_retry')
    assert.deepEqual(chunks[0].retryInfo, {
      attempt: 2, maxRetries: 5, retryDelayMs: 1000, errorStatus: 429
    })
  })
})

// ── system/compact_boundary ──────────────────────────────────────────────────

describe('normalizeMessage — system/compact_boundary', () => {
  test('yields compact_boundary chunk', () => {
    const chunks = collect({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'size', pre_tokens: 50000 }
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'compact_boundary')
    assert.ok(chunks[0].content?.includes('size'))
    assert.ok(chunks[0].content?.includes('50000'))
  })

  test('handles missing compact_metadata gracefully', () => {
    const chunks = collect({ type: 'system', subtype: 'compact_boundary' })
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].content?.includes('auto'))
  })
})

// ── system/status ────────────────────────────────────────────────────────────

describe('normalizeMessage — system/status', () => {
  test('yields session_state chunk', () => {
    const chunks = collect({ type: 'system', subtype: 'status', status: 'working' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'session_state')
    assert.equal(chunks[0].content, 'working')
  })

  test('defaults to idle when status is null', () => {
    const chunks = collect({ type: 'system', subtype: 'status', status: null })
    assert.equal(chunks[0].content, 'idle')
  })
})

// ── prompt_suggestion ────────────────────────────────────────────────────────

describe('normalizeMessage — prompt_suggestion', () => {
  test('yields prompt_suggestion chunk', () => {
    const chunks = collect({ type: 'prompt_suggestion', suggestion: 'Try this' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'prompt_suggestion')
    assert.equal(chunks[0].content, 'Try this')
  })
})

// ── system/files_persisted ───────────────────────────────────────────────────

describe('normalizeMessage — system/files_persisted', () => {
  test('yields files_persisted chunk with mapped fields', () => {
    const chunks = collect({
      type: 'system', subtype: 'files_persisted',
      files: [{ filename: 'app.ts', file_id: 'f-1' }]
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'files_persisted')
    assert.deepEqual(chunks[0].persistedFiles, [{ filename: 'app.ts', fileId: 'f-1' }])
  })
})

// ── tool_use_summary ─────────────────────────────────────────────────────────

describe('normalizeMessage — tool_use_summary', () => {
  test('yields tool_use_summary chunk', () => {
    const chunks = collect({ type: 'tool_use_summary', summary: 'Read 3 files' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'tool_use_summary')
    assert.equal(chunks[0].content, 'Read 3 files')
  })
})

// ── system/hook lifecycle ────────────────────────────────────────────────────

describe('normalizeMessage — system/hook lifecycle', () => {
  test('hook_started yields hook_lifecycle with phase=started', () => {
    const chunks = collect({
      type: 'system', subtype: 'hook_started',
      hook_id: 'h1', hook_name: 'lint', hook_event: 'pre-commit'
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'hook_lifecycle')
    assert.equal(chunks[0].hookInfo?.phase, 'started')
    assert.equal(chunks[0].hookInfo?.hookName, 'lint')
  })

  test('hook_progress yields phase=progress', () => {
    const chunks = collect({
      type: 'system', subtype: 'hook_progress',
      hook_id: 'h1', hook_name: 'lint', hook_event: 'pre-commit'
    })
    assert.equal(chunks[0].hookInfo?.phase, 'progress')
  })

  test('hook_response yields phase=response with outcome', () => {
    const chunks = collect({
      type: 'system', subtype: 'hook_response',
      hook_id: 'h1', hook_name: 'lint', hook_event: 'pre-commit',
      output: 'ok', outcome: 'success'
    })
    assert.equal(chunks[0].hookInfo?.phase, 'response')
    assert.equal(chunks[0].hookInfo?.output, 'ok')
    assert.equal(chunks[0].hookInfo?.outcome, 'success')
  })
})

// ── system/session_state_changed ─────────────────────────────────────────────

describe('normalizeMessage — system/session_state_changed', () => {
  test('yields session_state chunk', () => {
    const chunks = collect({
      type: 'system', subtype: 'session_state_changed', state: 'paused'
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'session_state')
    assert.equal(chunks[0].content, 'paused')
  })
})

// ── auth_status ──────────────────────────────────────────────────────────────

describe('normalizeMessage — auth_status', () => {
  test('yields auth_status with error message', () => {
    const chunks = collect({ type: 'auth_status', error: 'invalid token' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'auth_status')
    assert.ok(chunks[0].content?.includes('Auth error'))
  })

  test('yields auth_status with authenticating message when no error', () => {
    const chunks = collect({ type: 'auth_status' })
    assert.equal(chunks[0].content, 'Authenticating...')
  })
})

// ── system/elicitation_complete ──────────────────────────────────────────────

describe('normalizeMessage — system/elicitation_complete', () => {
  test('yields session_state with MCP server name', () => {
    const chunks = collect({
      type: 'system', subtype: 'elicitation_complete',
      mcp_server_name: 'Google Drive'
    })
    assert.equal(chunks[0].type, 'session_state')
    assert.ok(chunks[0].content?.includes('Google Drive'))
  })
})

// ── system/local_command_output ──────────────────────────────────────────────

describe('normalizeMessage — system/local_command_output', () => {
  test('yields text chunk from local command output', () => {
    const chunks = collect({
      type: 'system', subtype: 'local_command_output', content: 'ls output here'
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(chunks[0].content, 'ls output here')
  })

  test('no chunk when content is empty', () => {
    const chunks = collect({ type: 'system', subtype: 'local_command_output' })
    assert.equal(chunks.length, 0)
  })
})

// ── Generic usage accumulation ───────────────────────────────────────────────

describe('normalizeMessage — generic usage accumulation', () => {
  test('accumulates usage from non-result message types', () => {
    const tokens = new TokenAccountant()
    collect({
      type: 'some_other_type',
      usage: { input_tokens: 10, output_tokens: 5 }
    }, undefined, tokens)
    const s = tokens.getSummary()
    assert.equal(s.input, 10)
    assert.equal(s.output, 5)
  })
})

// ── Unknown type warning ─────────────────────────────────────────────────────

describe('normalizeMessage — unknown type', () => {
  test('yields no chunks for unknown types (logged as warning)', () => {
    const chunks = collect({ type: 'totally_unknown_type' })
    assert.equal(chunks.length, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

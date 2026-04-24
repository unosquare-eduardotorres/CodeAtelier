/**
 * ChatProtocol builder tests — verifies every IPC chat message builder.
 *
 * These builders are the single source of truth for message shapes sent over
 * CHAT_MESSAGE_CHUNK / CHAT_MESSAGE_COMPLETE. A bug here silently corrupts
 * renderer message rendering, so every builder is exercised:
 *   - required fields are always present
 *   - optional fields are conditionally included only when provided
 *   - literal discriminator fields (chunk: '', turnBoundary: true) are correct
 *
 * Run: tsx src/main/ipc/__tests__/chat-protocol.test.ts
 */

import assert from 'node:assert/strict'
import {
  createTextChunk,
  createToolActivityChunk,
  createTurnBoundary,
  createCompactNeeded,
  createCompleteMessage
} from '../chat-protocol'
import { test, describe, summary } from '../../services/__tests__/test-harness'

describe('createTextChunk', () => {
  test('returns required fields only when optionals omitted', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: 'hello',
      role: 'generalist'
    })
    assert.deepEqual(msg, {
      conversationId: 'c1',
      chunk: 'hello',
      role: 'generalist'
    })
    assert.equal('requestId' in msg, false)
    assert.equal('phase' in msg, false)
    assert.equal('specialist' in msg, false)
    assert.equal('taskId' in msg, false)
  })

  test('includes requestId when provided', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: 'hi',
      role: 'generalist',
      requestId: 'req-9'
    })
    assert.equal(msg.requestId, 'req-9')
  })

  test('includes phase when provided', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: 'hi',
      role: 'generalist',
      phase: 'da-vinci-responding'
    })
    assert.equal(msg.phase, 'da-vinci-responding')
  })

  test('includes specialist+taskId for specialist messages', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: 'hi from specialist',
      role: 'specialist',
      specialist: 'frontend-architect',
      taskId: 'task-42'
    })
    assert.equal(msg.role, 'specialist')
    assert.equal(msg.specialist, 'frontend-architect')
    assert.equal(msg.taskId, 'task-42')
  })

  test('omits empty string text by setting chunk to provided value', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: '',
      role: 'generalist'
    })
    assert.equal(msg.chunk, '', 'empty text is preserved — caller decides semantics')
  })

  test('does not include requestId when empty string passed', () => {
    const msg = createTextChunk({
      conversationId: 'c1',
      text: 'x',
      role: 'generalist',
      requestId: ''
    })
    assert.equal('requestId' in msg, false, 'falsy requestId treated as absent')
  })
})

describe('createToolActivityChunk', () => {
  test('always sets chunk to empty string', () => {
    const msg = createToolActivityChunk({
      conversationId: 'c1',
      role: 'generalist',
      toolActivity: { id: 'tool-1', toolName: 'Read' }
    })
    assert.equal(msg.chunk, '')
  })

  test('embeds toolActivity object intact', () => {
    const activity = { id: 'tool-1', toolName: 'Bash', status: 'running' as const }
    const msg = createToolActivityChunk({
      conversationId: 'c1',
      role: 'specialist',
      toolActivity: activity,
      specialist: 'dx-specialist',
      taskId: 'task-7'
    })
    assert.deepEqual(msg.toolActivity, activity)
    assert.equal(msg.specialist, 'dx-specialist')
    assert.equal(msg.taskId, 'task-7')
  })

  test('omits optionals when not provided', () => {
    const msg = createToolActivityChunk({
      conversationId: 'c1',
      role: 'generalist',
      toolActivity: { id: 't', toolName: 'Read' }
    })
    assert.equal('specialist' in msg, false)
    assert.equal('taskId' in msg, false)
    assert.equal('requestId' in msg, false)
  })
})

describe('createTurnBoundary', () => {
  test('sets turnBoundary: true and chunk: empty string', () => {
    const msg = createTurnBoundary({
      conversationId: 'c1',
      role: 'generalist',
      turnId: 'turn-5'
    })
    assert.equal(msg.turnBoundary, true)
    assert.equal(msg.chunk, '')
    assert.equal(msg.turnId, 'turn-5')
  })

  test('propagates specialist context when role=specialist', () => {
    // TurnBoundaryMessage's spread includes specialist/taskId at runtime, but
    // the exported type intentionally omits them. Cast through unknown to
    // inspect those fields when they are set by the builder.
    const msg = createTurnBoundary({
      conversationId: 'c1',
      role: 'specialist',
      turnId: 'turn-1',
      specialist: 'data-architect',
      taskId: 'task-3'
    }) as unknown as {
      role: string
      specialist?: string
      taskId?: string
    }
    assert.equal(msg.role, 'specialist')
    assert.equal(msg.specialist, 'data-architect')
    assert.equal(msg.taskId, 'task-3')
  })
})

describe('createCompactNeeded', () => {
  test('wraps compactNeeded payload and leaves chunk empty', () => {
    const msg = createCompactNeeded({
      conversationId: 'c1',
      role: 'generalist',
      compactNeeded: { level: 'warning', inputTokens: 120000 }
    })
    assert.equal(msg.chunk, '')
    assert.deepEqual(msg.compactNeeded, { level: 'warning', inputTokens: 120000 })
  })

  test('includes requestId when provided', () => {
    const msg = createCompactNeeded({
      conversationId: 'c1',
      role: 'generalist',
      requestId: 'req-77',
      compactNeeded: { level: 'critical', inputTokens: 180000 }
    })
    assert.equal(msg.requestId, 'req-77')
  })
})

describe('createCompleteMessage', () => {
  test('requires conversationId + messageId and omits other optionals', () => {
    const msg = createCompleteMessage({
      conversationId: 'c1',
      messageId: 'm-1'
    })
    assert.deepEqual(msg, { conversationId: 'c1', messageId: 'm-1' })
    assert.equal('requestId' in msg, false)
    assert.equal('phase' in msg, false)
    assert.equal('taskId' in msg, false)
    assert.equal('isHandoff' in msg, false)
  })

  test('propagates all optional fields when provided', () => {
    const msg = createCompleteMessage({
      conversationId: 'c1',
      messageId: 'm-1',
      requestId: 'req-1',
      phase: 'pipeline-complete',
      taskId: 'task-2',
      isHandoff: true
    })
    assert.equal(msg.conversationId, 'c1')
    assert.equal(msg.messageId, 'm-1')
    assert.equal(msg.requestId, 'req-1')
    assert.equal(msg.phase, 'pipeline-complete')
    assert.equal(msg.taskId, 'task-2')
    assert.equal(msg.isHandoff, true)
  })

  test('isHandoff=false is preserved (not treated as "unset")', () => {
    const msg = createCompleteMessage({
      conversationId: 'c1',
      messageId: 'm-1',
      isHandoff: false
    })
    assert.equal(msg.isHandoff, false)
    assert.equal('isHandoff' in msg, true, 'explicit false must round-trip')
  })

  test('isHandoff=undefined is omitted entirely', () => {
    const msg = createCompleteMessage({
      conversationId: 'c1',
      messageId: 'm-1',
      isHandoff: undefined
    })
    assert.equal('isHandoff' in msg, false)
  })
})

describe('ChatProtocol — cross-cutting invariants', () => {
  test('all chunk builders set role to the exact value passed', () => {
    const text = createTextChunk({ conversationId: 'c', text: 't', role: 'specialist' })
    const tool = createToolActivityChunk({
      conversationId: 'c',
      role: 'specialist',
      toolActivity: { id: '1', toolName: 'Read' }
    })
    const boundary = createTurnBoundary({ conversationId: 'c', role: 'specialist', turnId: 't1' })
    const compact = createCompactNeeded({
      conversationId: 'c',
      role: 'specialist',
      compactNeeded: { level: 'warning', inputTokens: 1 }
    })
    assert.equal(text.role, 'specialist')
    assert.equal(tool.role, 'specialist')
    assert.equal(boundary.role, 'specialist')
    assert.equal(compact.role, 'specialist')
  })

  test('conversationId is always present', () => {
    const builders = [
      createTextChunk({ conversationId: 'c', text: '', role: 'generalist' }),
      createToolActivityChunk({
        conversationId: 'c',
        role: 'generalist',
        toolActivity: { id: '1', toolName: 'Read' }
      }),
      createTurnBoundary({ conversationId: 'c', role: 'generalist', turnId: 't1' }),
      createCompactNeeded({
        conversationId: 'c',
        role: 'generalist',
        compactNeeded: { level: 'warning', inputTokens: 1 }
      }),
      createCompleteMessage({ conversationId: 'c', messageId: 'm' })
    ]
    for (const b of builders) {
      assert.equal(b.conversationId, 'c')
    }
  })
})

// When run directly, print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}

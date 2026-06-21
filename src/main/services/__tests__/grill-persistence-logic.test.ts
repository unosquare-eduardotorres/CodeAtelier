/**
 * Unit tests for Grill persistence controller pure logic — message buffer
 * accumulation, tool activity merging, status payload construction.
 *
 * Phase 14, Track 9a — grill-persistence.controller.ts (~350 lines at ~25%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic ──

interface MessageEntry {
  type: 'agent' | 'user'
  content: string
  toolActivities: Array<Record<string, unknown>>
}

/**
 * Replicated message buffer accumulation logic
 * (grill-persistence.controller.ts:139-170).
 */
function accumulateMessageChunk(
  buffer: MessageEntry[],
  chunkData: { content?: string; toolActivity?: Record<string, unknown> }
): void {
  if (chunkData.content) {
    const lastMsg = buffer[buffer.length - 1]
    if (lastMsg && lastMsg.type === 'agent') {
      lastMsg.content = (lastMsg.content ?? '') + chunkData.content
    } else {
      buffer.push({ type: 'agent', content: chunkData.content, toolActivities: [] })
    }
  }

  if (chunkData.toolActivity) {
    const lastMsg = buffer[buffer.length - 1]
    if (!lastMsg || lastMsg.type !== 'agent') {
      buffer.push({ type: 'agent', content: '', toolActivities: [] })
    }
    const target = buffer[buffer.length - 1]

    const existingIdx = target.toolActivities.findIndex(
      (ta) => ta.id === chunkData.toolActivity!.id
    )
    if (existingIdx >= 0) {
      target.toolActivities[existingIdx] = {
        ...target.toolActivities[existingIdx],
        ...chunkData.toolActivity
      }
    } else {
      target.toolActivities.push(chunkData.toolActivity)
    }
  }
}

/**
 * Replicated status payload construction
 * (grill-persistence.controller.ts:310-316).
 */
function createGrillStatusPayload(session: {
  status: string
  ideaId?: string
  trackId?: string
  currentScore?: number
}): Record<string, unknown> {
  return {
    status: session.status,
    ideaId: session.ideaId,
    trackId: session.trackId,
    score: session.currentScore
  }
}

/**
 * Replicated batch key generation.
 */
function batchKey(workspaceId: string, advisorRole: string): string {
  return `${workspaceId}:${advisorRole}`
}

// ── Tests ──

describe('Grill Persistence — message buffer accumulation', () => {
  test('text_chunk_into_empty_buffer_creates_new_entry', () => {
    const buffer: MessageEntry[] = []
    accumulateMessageChunk(buffer, { content: 'Hello' })
    assert.equal(buffer.length, 1)
    assert.equal(buffer[0].type, 'agent')
    assert.equal(buffer[0].content, 'Hello')
  })

  test('append_text_to_existing_agent_message', () => {
    const buffer: MessageEntry[] = [
      { type: 'agent', content: 'Hello', toolActivities: [] }
    ]
    accumulateMessageChunk(buffer, { content: ' world' })
    assert.equal(buffer.length, 1)
    assert.equal(buffer[0].content, 'Hello world')
  })

  test('new_entry_after_user_message', () => {
    const buffer: MessageEntry[] = [
      { type: 'user', content: 'Question', toolActivities: [] }
    ]
    accumulateMessageChunk(buffer, { content: 'Answer' })
    assert.equal(buffer.length, 2)
    assert.equal(buffer[1].type, 'agent')
    assert.equal(buffer[1].content, 'Answer')
  })

  test('tool_activity_added_to_last_agent_message', () => {
    const buffer: MessageEntry[] = [
      { type: 'agent', content: 'text', toolActivities: [] }
    ]
    accumulateMessageChunk(buffer, {
      toolActivity: { id: 'tool-1', name: 'Read', status: 'running' }
    })
    assert.equal(buffer[0].toolActivities.length, 1)
    assert.equal(buffer[0].toolActivities[0].id, 'tool-1')
  })

  test('tool_activity_merged_by_id', () => {
    const buffer: MessageEntry[] = [
      { type: 'agent', content: '', toolActivities: [
        { id: 'tool-1', name: 'Read', status: 'running' }
      ]}
    ]
    accumulateMessageChunk(buffer, {
      toolActivity: { id: 'tool-1', status: 'complete', result: 'data' }
    })
    assert.equal(buffer[0].toolActivities.length, 1)
    assert.equal(buffer[0].toolActivities[0].status, 'complete')
    assert.equal(buffer[0].toolActivities[0].result, 'data')
    assert.equal(buffer[0].toolActivities[0].name, 'Read') // preserved from original
  })

  test('multiple_tool_activities_tracked_separately', () => {
    const buffer: MessageEntry[] = [
      { type: 'agent', content: '', toolActivities: [] }
    ]
    accumulateMessageChunk(buffer, { toolActivity: { id: 'tool-1', name: 'Read' } })
    accumulateMessageChunk(buffer, { toolActivity: { id: 'tool-2', name: 'Glob' } })
    assert.equal(buffer[0].toolActivities.length, 2)
  })

  test('tool_activity_creates_agent_entry_if_none', () => {
    const buffer: MessageEntry[] = []
    accumulateMessageChunk(buffer, { toolActivity: { id: 'tool-1', name: 'Read' } })
    assert.equal(buffer.length, 1)
    assert.equal(buffer[0].type, 'agent')
  })
})

describe('Grill Persistence — status payload construction', () => {
  test('maps_session_fields_to_payload', () => {
    const payload = createGrillStatusPayload({
      status: 'evaluating',
      ideaId: 'idea-123',
      trackId: 'security',
      currentScore: 7.5
    })
    assert.equal(payload.status, 'evaluating')
    assert.equal(payload.ideaId, 'idea-123')
    assert.equal(payload.trackId, 'security')
    assert.equal(payload.score, 7.5)
  })

  test('handles_undefined_optional_fields', () => {
    const payload = createGrillStatusPayload({ status: 'pending' })
    assert.equal(payload.status, 'pending')
    assert.equal(payload.ideaId, undefined)
    assert.equal(payload.score, undefined)
  })
})

describe('Batch key generation', () => {
  test('combines_workspaceId_and_role', () => {
    assert.equal(batchKey('ws-123', 'contrarian'), 'ws-123:contrarian')
  })

  test('different_inputs_produce_different_keys', () => {
    assert.notEqual(batchKey('ws-1', 'contrarian'), batchKey('ws-2', 'contrarian'))
    assert.notEqual(batchKey('ws-1', 'executor'), batchKey('ws-1', 'contrarian'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

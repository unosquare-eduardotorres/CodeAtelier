/**
 * Unit tests for ipc/chunk-router.ts — tool-activity accumulation/merge via
 * getAndClearToolActivities, synchronous chunk dispatch (status / error /
 * rate_limit / session_state) through a mock BrowserWindow, and the safeSend
 * destroyed-window guard.
 *
 * The text path (33ms TextDeltaBatcher timer) is covered by the batcher's own
 * suite and intentionally not re-asserted here.
 */
import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { test, describe, summaryAsync, createSpy } from './../../services/__tests__/test-harness'
import { routeChunk, getAndClearToolActivities, type ChunkRouterContext } from '../chunk-router'
import type { StreamChunk } from '../../services'
import { IPC_CHANNELS } from '../../../shared/constants'

type SendSpy = ReturnType<typeof createSpy<[string, unknown], void>>

function mockWindow(opts: { destroyed?: boolean } = {}): { window: BrowserWindow; send: SendSpy } {
  const send = createSpy<[string, unknown], void>()
  const window = {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: { send }
  } as unknown as BrowserWindow
  return { window, send }
}

function ctx(conversationId: string, window: BrowserWindow): ChunkRouterContext {
  return {
    mainWindow: window,
    conversationId,
    role: 'da-vinci',
    contentAccumulator: { value: '' }
  }
}

describe('chunk-router › getAndClearToolActivities', () => {
  test('empty conversation → []', () => {
    assert.deepEqual(getAndClearToolActivities('no-such-conv'), [])
  })

  test('merges tool_use(running) + tool_result(completed) by id, preserving startedAt', () => {
    const { window } = mockWindow()
    const c = ctx('conv-merge', window)

    routeChunk(c, { type: 'tool_use', toolId: 'tool-A', toolName: 'Read' } as StreamChunk)
    routeChunk(c, { type: 'tool_result', toolId: 'tool-A', toolName: 'Read', content: 'ok' } as StreamChunk)

    const activities = getAndClearToolActivities('conv-merge')
    assert.equal(activities.length, 1, 'two chunks with the same id merge into one entry')
    assert.equal(activities[0].status, 'completed')
    // tool_result carries startedAt:0; the merge must keep the running chunk's startedAt.
    assert.ok(activities[0].startedAt > 0, 'earliest (running) startedAt is preserved')
    assert.ok(activities[0].completedAt && activities[0].completedAt > 0)
  })

  test('clears the store after read — a second call returns []', () => {
    const { window } = mockWindow()
    const c = ctx('conv-clear', window)
    routeChunk(c, { type: 'tool_use', toolId: 'tool-X', toolName: 'Grep' } as StreamChunk)
    assert.equal(getAndClearToolActivities('conv-clear').length, 1)
    assert.deepEqual(getAndClearToolActivities('conv-clear'), [])
  })
})

describe('chunk-router › routeChunk synchronous dispatch', () => {
  test('rate_limit → SDK_RATE_LIMIT send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-rl', window), {
      type: 'rate_limit',
      rateLimit: { status: 'allowed_warning', utilization: 80 }
    } as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.SDK_RATE_LIMIT)
  })

  test('session_state → SDK_SESSION_STATE send carrying state', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-ss', window), {
      type: 'session_state',
      content: 'compacting'
    } as StreamChunk)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.SDK_SESSION_STATE)
    assert.equal((send.lastCall?.[1] as { state?: string }).state, 'compacting')
  })

  test('error → CHAT_MESSAGE_CHUNK send + accumulates into contentAccumulator', () => {
    const { window, send } = mockWindow()
    const c = ctx('c-err', window)
    routeChunk(c, { type: 'error', error: 'boom' } as StreamChunk)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
    assert.match(c.contentAccumulator.value, /\*\*Error:\*\* boom/)
  })

  test('status with real content → CHAT_MESSAGE_CHUNK send', () => {
    const { window, send } = mockWindow()
    const c = ctx('c-status', window)
    routeChunk(c, { type: 'status', content: 'Indexing files' } as StreamChunk)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
    assert.match(c.contentAccumulator.value, /Indexing files/)
  })

  test('status "heartbeat" is suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-hb', window), { type: 'status', content: 'heartbeat' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('unknown chunk type is ignored without throwing or sending', () => {
    const { window, send } = mockWindow()
    assert.doesNotThrow(() =>
      routeChunk(ctx('c-unknown', window), { type: 'totally_bogus' } as unknown as StreamChunk)
    )
    assert.equal(send.callCount, 0)
  })
})

describe('chunk-router › safeSend destroyed-window guard', () => {
  test('does not send (and does not throw) when the window is destroyed', () => {
    const { window, send } = mockWindow({ destroyed: true })
    assert.doesNotThrow(() =>
      routeChunk(ctx('c-dead', window), {
        type: 'session_state',
        content: 'x'
      } as StreamChunk)
    )
    assert.equal(send.callCount, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

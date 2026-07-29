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
    role: 'specialist',
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
    routeChunk(c, {
      type: 'tool_result',
      toolId: 'tool-A',
      toolName: 'Read',
      content: 'ok'
    } as StreamChunk)

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

// ── Expanded coverage (Round 4) ──

describe('chunk-router › handleText edge cases', () => {
  test('empty content → no send (early return)', () => {
    const { window } = mockWindow()
    const c = ctx('c-empty-text', window)
    routeChunk(c, { type: 'text', content: '' } as StreamChunk)
    // Text batching might not send immediately, but accumulator should be unchanged
    assert.equal(c.contentAccumulator.value, '')
  })

  test('undefined content → no accumulation', () => {
    const { window } = mockWindow()
    const c = ctx('c-undef-text', window)
    routeChunk(c, { type: 'text' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, '')
  })
})

describe('chunk-router › handleThinking edge cases', () => {
  test('empty thinking content → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-empty-think', window), { type: 'thinking', content: '' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('undefined thinking content → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-undef-think', window), { type: 'thinking' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })
})

describe('chunk-router › handleStatus edge cases', () => {
  test('empty string status content → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-empty-status', window), { type: 'status', content: '' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })
})

describe('chunk-router › handleStatus suppression', () => {
  test('agent_switched: prefix → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-agent', window), { type: 'status', content: 'agent_switched:davinci' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('model_switched: prefix → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-model', window), { type: 'status', content: 'model_switched:claude-sonnet-4' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('idle status → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-idle', window), { type: 'status', content: 'idle' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('finishReason: prefix → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-finish', window), { type: 'status', content: 'finishReason:completed' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('thinking/reviewing/writing/failed → suppressed', () => {
    const { window, send } = mockWindow()
    for (const value of ['thinking', 'reviewing', 'writing', 'failed']) {
      routeChunk(ctx(`c-${value}`, window), { type: 'status', content: value } as StreamChunk)
    }
    assert.equal(send.callCount, 0)
  })

  test('non-metadata status → still rendered', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-custom', window), { type: 'status', content: 'processing your request' } as StreamChunk)
    assert.equal(send.callCount, 1)
  })
})

describe('chunk-router › handleSessionState size guard', () => {
  test('normal-sized session_state → forwarded', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-state', window), { type: 'session_state', content: 'session_diff:small' } as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.SDK_SESSION_STATE)
  })

  test('oversized session_state → truncated and still forwarded', () => {
    const { window, send } = mockWindow()
    const huge = 'x'.repeat(1_100_000)
    routeChunk(ctx('c-big-state', window), { type: 'session_state', content: huge } as StreamChunk)
    assert.equal(send.callCount, 1)
    const payload = send.lastCall?.[1] as { state: string }
    assert.equal(payload.state.length, 1_000_000)
  })
})

describe('chunk-router › handleFilesPersisted', () => {
  test('sends SDK_FILES_PERSISTED with files payload', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-files', window), {
      type: 'files_persisted',
      persistedFiles: ['a.ts', 'b.ts']
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.SDK_FILES_PERSISTED)
  })
})

describe('chunk-router › handleTodoUpdate', () => {
  test('missing todoUpdate → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-no-todo', window), { type: 'todo_update' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('with todoUpdate → sends chunk', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-todo', window), {
      type: 'todo_update',
      todoUpdate: { action: 'add', text: 'Fix bug' }
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
  })
})

describe('chunk-router › handleLspDiagnostics', () => {
  test('missing lspDiagnostics → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-no-lsp', window), { type: 'lsp_diagnostics' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('with diagnostics → sends SDK_LSP_DIAGNOSTICS', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-lsp', window), {
      type: 'lsp_diagnostics',
      lspDiagnostics: [{ file: 'a.ts', line: 1, severity: 'error', message: 'bad' }]
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.SDK_LSP_DIAGNOSTICS)
  })
})

describe('chunk-router › isStatusLabel coverage (via subagent handlers)', () => {
  test('subagent_progress with status-label-only → no text emit, still sends tool activity', () => {
    const { window } = mockWindow()
    const c = ctx('c-sub-status', window)
    routeChunk(c, {
      type: 'subagent_progress',
      content: 'running task',
      toolId: 'sub-1',
      toolName: 'Agent'
    } as unknown as StreamChunk)
    // Short status label (< 30 chars, starts with 'running') should NOT accumulate as text
    assert.equal(c.contentAccumulator.value, '')
  })

  test('subagent_progress with prose text → accumulates + sends text chunk', () => {
    const { window } = mockWindow()
    const c = ctx('c-sub-prose', window)
    const longContent =
      'I am analyzing the codebase for potential improvements in the authentication module.'
    routeChunk(c, {
      type: 'subagent_progress',
      content: longContent,
      toolId: 'sub-2',
      toolName: 'Agent'
    } as unknown as StreamChunk)
    assert.ok(c.contentAccumulator.value.includes('analyzing'))
  })
})

describe('chunk-router › handleSubagentComplete', () => {
  test('toolInput=completed → status completed', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-sub-done', window), {
      type: 'subagent_complete',
      content: 'Done with analysis',
      toolInput: 'completed',
      toolId: 'sub-3'
    } as unknown as StreamChunk)
    // Should have sent at least one chunk
    assert.ok(send.callCount >= 1)
  })

  test('toolInput != completed → status error', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-sub-err', window), {
      type: 'subagent_complete',
      content: 'Failed to complete the task due to timeout',
      toolInput: 'failed',
      toolId: 'sub-4'
    } as unknown as StreamChunk)
    assert.ok(send.callCount >= 1)
  })
})

// ── Control signal filtering (CONTROL-SIGNAL-FILTER-01) ──

describe('chunk-router › handleText control signal filtering', () => {
  test('{"type":"busy"} text chunk is dropped (no accumulation, no send)', () => {
    const { window, send } = mockWindow()
    const c = ctx('c-busy', window)
    routeChunk(c, { type: 'text', content: '{"type":"busy"}' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, '')
    // No IPC send (text batcher may not flush immediately, but accumulator is untouched)
    assert.equal(send.callCount, 0)
  })

  test('{"type":"idle"} text chunk is dropped', () => {
    const { window } = mockWindow()
    const c = ctx('c-idle-text', window)
    routeChunk(c, { type: 'text', content: '{"type":"idle"}' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, '')
  })

  test('{"type":"ready"} and {"type":"processing"} are also dropped', () => {
    const { window } = mockWindow()
    const c = ctx('c-ready-proc', window)
    routeChunk(c, { type: 'text', content: '{"type":"ready"}' } as StreamChunk)
    routeChunk(c, { type: 'text', content: '{"type":"processing"}' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, '')
  })

  test('control signal with whitespace padding is still dropped', () => {
    const { window } = mockWindow()
    const c = ctx('c-ws', window)
    routeChunk(c, { type: 'text', content: '  { "type" : "busy" }  ' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, '')
  })

  test('legitimate text containing "busy" is NOT dropped', () => {
    const { window } = mockWindow()
    const c = ctx('c-legit', window)
    routeChunk(c, { type: 'text', content: 'The server is busy processing your request.' } as StreamChunk)
    assert.equal(c.contentAccumulator.value, 'The server is busy processing your request.')
  })

  test('JSON embedded in larger text is NOT dropped', () => {
    const { window } = mockWindow()
    const c = ctx('c-embed', window)
    const content = 'Here is the status: {"type":"busy"} and more text'
    routeChunk(c, { type: 'text', content } as StreamChunk)
    assert.equal(c.contentAccumulator.value, content)
  })
})

describe('chunk-router › handleStatus busy suppression', () => {
  test('busy status → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-busy-status', window), { type: 'status', content: 'busy' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('status chunk with JSON content {"type":"busy"} → suppressed via regex', () => {
    const { window, send } = mockWindow()
    routeChunk(
      ctx('c-json-busy-status', window),
      { type: 'status', content: '{"type":"busy"}' } as StreamChunk
    )
    assert.equal(send.callCount, 0)
  })

  test('status chunk with JSON content {"type":"idle"} → suppressed via regex', () => {
    const { window, send } = mockWindow()
    routeChunk(
      ctx('c-json-idle-status', window),
      { type: 'status', content: '{"type":"idle"}' } as StreamChunk
    )
    assert.equal(send.callCount, 0)
  })
})

describe('chunk-router › handlePhaseProgress', () => {
  test('missing phaseProgress → no send', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-no-phase', window), { type: 'phase_progress' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('with phaseProgress → sends CHAT_MESSAGE_CHUNK with payload', () => {
    const { window, send } = mockWindow()
    const progress = {
      planId: 'plan-123',
      phaseId: 2,
      phaseTitle: 'Implementing API routes',
      status: 'in_progress' as const,
      totalPhases: 5,
      message: 'Working on route handlers'
    }
    routeChunk(ctx('c-phase', window), {
      type: 'phase_progress',
      phaseProgress: progress
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
    assert.equal(send.lastCall?.[0], IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
    const payload = send.lastCall?.[1] as Record<string, unknown>
    assert.deepEqual(payload.phaseProgress, progress)
    assert.equal(payload.chunk, '')
  })

  test('phaseProgress with null planId → sends correctly', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-null-plan', window), {
      type: 'phase_progress',
      phaseProgress: {
        planId: null,
        phaseId: 1,
        phaseTitle: 'Setup',
        status: 'started',
        totalPhases: 3
      }
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
  })

  test('phaseProgress with task-level fields → passes them through', () => {
    const { window, send } = mockWindow()
    const progress = {
      planId: 'plan-456',
      phaseId: 2,
      phaseTitle: 'Auth endpoints',
      status: 'in_progress' as const,
      totalPhases: 4,
      taskId: '2-1',
      taskTitle: 'Add login endpoint',
      taskStatus: 'running' as const,
      totalTasks: 3
    }
    routeChunk(ctx('c-task-progress', window), {
      type: 'phase_progress',
      phaseProgress: progress
    } as unknown as StreamChunk)
    assert.equal(send.callCount, 1)
    const payload = send.lastCall?.[1] as Record<string, unknown>
    const pp = payload.phaseProgress as typeof progress
    assert.equal(pp.taskId, '2-1')
    assert.equal(pp.taskTitle, 'Add login endpoint')
    assert.equal(pp.taskStatus, 'running')
    assert.equal(pp.totalTasks, 3)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

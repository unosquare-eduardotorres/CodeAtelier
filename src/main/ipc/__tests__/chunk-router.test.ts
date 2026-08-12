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
import {
  routeChunk,
  getAndClearToolActivities,
  capEditDiffBudget,
  type ChunkRouterContext
} from '../chunk-router'
import type { ToolActivity } from '../../../shared/types'
import type { StreamChunk } from '../../services'
import { IPC_CHANNELS } from '../../../shared/constants'
import { trySetupTestDb, seedConversation } from '../../db/repositories/__tests__/db-test-helper'
import { planRepository } from '../../db/repositories/plan.repository'
import type { StructuredPlan } from '../../../shared/types'

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
    routeChunk(ctx('c-agent', window), {
      type: 'status',
      content: 'agent_switched:davinci'
    } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('model_switched: prefix → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-model', window), {
      type: 'status',
      content: 'model_switched:claude-sonnet-4'
    } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('idle status → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-idle', window), { type: 'status', content: 'idle' } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('finishReason: prefix → suppressed (no send)', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-finish', window), {
      type: 'status',
      content: 'finishReason:completed'
    } as StreamChunk)
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
    routeChunk(ctx('c-custom', window), {
      type: 'status',
      content: 'processing your request'
    } as StreamChunk)
    assert.equal(send.callCount, 1)
  })
})

describe('chunk-router › handleSessionState size guard', () => {
  test('normal-sized session_state → forwarded', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-state', window), {
      type: 'session_state',
      content: 'session_diff:small'
    } as StreamChunk)
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
    routeChunk(c, {
      type: 'text',
      content: 'The server is busy processing your request.'
    } as StreamChunk)
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
    routeChunk(ctx('c-json-busy-status', window), {
      type: 'status',
      content: '{"type":"busy"}'
    } as StreamChunk)
    assert.equal(send.callCount, 0)
  })

  test('status chunk with JSON content {"type":"idle"} → suppressed via regex', () => {
    const { window, send } = mockWindow()
    routeChunk(ctx('c-json-idle-status', window), {
      type: 'status',
      content: '{"type":"idle"}'
    } as StreamChunk)
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

// ── Task derivation from observed tool activity (TASK-DERIVE-01) ──
//
// Regression coverage for the audit finding that this path was dead code:
// toolInput on the CLI backend is a human-readable summary string, not JSON,
// so extractStructuredMeta's JSON.parse(toolInput) always threw and filePath
// was never populated. This exercises the real fix — toolInputRaw — end to
// end: a Write tool_result with a plan-matching path must derive task
// completion in the DB and emit a synthetic phaseProgress chunk.
{
  const dbEnv = trySetupTestDb()

  describe('chunk-router › derivePlanTaskFromFileActivity (task derivation)', () => {
    if (!dbEnv) {
      test('Write tool_result with plan-matching path derives task completion', () => {}, {
        skipReason: 'no DB'
      })
      return
    }
    const { wsId } = dbEnv

    function makeStructuredPlan(): StructuredPlan {
      return {
        title: 'Derivation Test Plan',
        summary: 'test',
        phases: [
          {
            id: 1,
            title: 'Phase One',
            complexity: 2,
            risk: 'low',
            description: '',
            files: [{ file: 'src/a.ts', change: 'Add A' }]
          }
        ]
      }
    }

    test('Write tool_result with plan-matching path derives task completion', () => {
      const conversationId = seedConversation(dbEnv.db, wsId, 'Derivation conv')
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: conversationId,
        title: 'Derivation Test Plan',
        summary: 'test',
        structuredPlan: makeStructuredPlan(),
        linkedConversationId: conversationId
      })

      const { window, send } = mockWindow()
      routeChunk(ctx(conversationId, window), {
        type: 'tool_result',
        toolId: 'tool-write-1',
        toolName: 'Write',
        toolInputRaw: JSON.stringify({ file_path: 'src/a.ts' }),
        content: 'File written'
      } as unknown as StreamChunk)

      // A phaseProgress chunk with taskStatus 'complete' must have been sent —
      // this is what fails today if toolInputRaw isn't wired end to end.
      const calls = send.calls ?? []
      const phaseProgressCall = calls.find((c) => (c[1] as Record<string, unknown>)?.phaseProgress)
      assert.ok(phaseProgressCall, 'expected a CHAT_MESSAGE_CHUNK send carrying phaseProgress')
      const pp = (phaseProgressCall![1] as Record<string, unknown>).phaseProgress as Record<
        string,
        unknown
      >
      assert.equal(pp.taskId, '1-0')
      assert.equal(pp.taskStatus, 'complete')
      assert.equal(pp.phaseId, 1)

      // And it must be persisted — not just emitted — so it survives reload.
      const progress = planRepository.getPhaseProgress(plan.id)
      const phase1 = progress.find((p) => p.phaseId === 1)
      assert.ok(phase1, 'phase 1 progress must be persisted')
      assert.equal(phase1?.tasks?.find((t) => t.taskId === '1-0')?.status, 'complete')
    })

    test('Read tool_result (not write/edit) does not derive task completion', () => {
      const conversationId = seedConversation(dbEnv.db, wsId, 'Derivation conv 2')
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: conversationId,
        title: 'Derivation Test Plan 2',
        summary: 'test',
        structuredPlan: makeStructuredPlan(),
        linkedConversationId: conversationId
      })

      const { window, send } = mockWindow()
      routeChunk(ctx(conversationId, window), {
        type: 'tool_result',
        toolId: 'tool-read-1',
        toolName: 'Read',
        toolInputRaw: JSON.stringify({ file_path: 'src/a.ts' }),
        content: 'file contents'
      } as unknown as StreamChunk)

      const progress = planRepository.getPhaseProgress(plan.id)
      assert.equal(progress.length, 0, 'a Read must not derive/persist any task progress')
      assert.equal(
        (send.calls ?? []).some((c) => (c[1] as Record<string, unknown>)?.phaseProgress),
        false
      )
    })

    test('phase auto-finalizes to completed once every DECLARED task settles — never on a partial subset', () => {
      const conversationId = seedConversation(dbEnv.db, wsId, 'Finalize conv')
      const twoTaskPlan: StructuredPlan = {
        title: 'Two-task phase',
        summary: 'test',
        phases: [
          {
            id: 1,
            title: 'Phase One',
            complexity: 2,
            risk: 'low',
            description: '',
            files: [
              { file: 'src/a.ts', change: 'Add A' },
              { file: 'src/b.ts', change: 'Add B' }
            ]
          }
        ]
      }
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: conversationId,
        title: 'Two-task phase',
        summary: 'test',
        structuredPlan: twoTaskPlan,
        linkedConversationId: conversationId
      })

      const { window: w1 } = mockWindow()
      routeChunk(ctx(conversationId, w1), {
        type: 'tool_result',
        toolId: 'tool-a',
        toolName: 'Write',
        toolInputRaw: JSON.stringify({ file_path: 'src/a.ts' }),
        content: 'ok'
      } as unknown as StreamChunk)

      // Only 1 of 2 declared tasks done — phase must NOT be finalized yet.
      let phase1 = planRepository.getPhaseProgress(plan.id).find((p) => p.phaseId === 1)
      assert.equal(
        phase1?.status,
        'in_progress',
        'phase must stay in_progress with an unsettled declared task remaining'
      )

      const { window: w2, send: send2 } = mockWindow()
      routeChunk(ctx(conversationId, w2), {
        type: 'tool_result',
        toolId: 'tool-b',
        toolName: 'Write',
        toolInputRaw: JSON.stringify({ file_path: 'src/b.ts' }),
        content: 'ok'
      } as unknown as StreamChunk)

      // Both declared tasks now settled — phase must auto-finalize.
      phase1 = planRepository.getPhaseProgress(plan.id).find((p) => p.phaseId === 1)
      assert.equal(phase1?.status, 'completed')
      assert.equal(phase1?.tasks?.find((t) => t.taskId === '1-0')?.status, 'complete')
      assert.equal(phase1?.tasks?.find((t) => t.taskId === '1-1')?.status, 'complete')

      const pp = (send2.calls ?? []).find((c) => (c[1] as Record<string, unknown>)?.phaseProgress)
      const ppStatus = (
        (pp?.[1] as Record<string, unknown>)?.phaseProgress as Record<string, unknown>
      )?.status
      assert.equal(ppStatus, 'completed', 'the emitted phaseProgress chunk must reflect completed')
    })
  })
}

describe('chunk-router › capEditDiffBudget', () => {
  function activity(id: string, diffChars: number): ToolActivity {
    const half = 'x'.repeat(diffChars / 2)
    return {
      id,
      toolName: 'Edit',
      status: 'completed',
      startedAt: 0,
      editDiffs: [{ oldString: half, newString: half }]
    }
  }

  test('under budget keeps every diff', () => {
    const out = capEditDiffBudget([activity('a', 100), activity('b', 100)], 1_000)
    assert.equal(out[0].editDiffs?.length, 1)
    assert.equal(out[1].editDiffs?.length, 1)
  })

  test('over budget drops the OLDEST diffs and records the omission', () => {
    const out = capEditDiffBudget([activity('old', 100), activity('new', 100)], 150)
    assert.equal(out[0].editDiffs, undefined, 'oldest activity loses its diffs')
    assert.equal(out[0].editDiffsOmitted, 1)
    assert.equal(out[1].editDiffs?.length, 1, 'newest activity keeps its diffs')
  })

  test('activity rows themselves are never dropped', () => {
    const out = capEditDiffBudget([activity('a', 100), activity('b', 100)], 0)
    assert.equal(out.length, 2)
    assert.equal(out[0].toolName, 'Edit')
  })

  test('accumulates an existing editDiffsOmitted count', () => {
    const a = { ...activity('a', 100), editDiffsOmitted: 3 }
    const out = capEditDiffBudget([a], 0)
    assert.equal(out[0].editDiffsOmitted, 4)
  })

  test('activities without diffs pass through untouched', () => {
    const plain: ToolActivity = { id: 'p', toolName: 'Read', status: 'completed', startedAt: 0 }
    const out = capEditDiffBudget([plain], 0)
    assert.deepEqual(out[0], plain)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

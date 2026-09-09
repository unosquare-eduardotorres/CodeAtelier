/**
 * control-actions-server.ts — real tool-handler coverage.
 *
 * The registered control-actions-server.test only exercised adjacent helper
 * modules (ask-user-registry, tool-auto-approve, mode-broadcast,
 * idle-wait-guard); the server module itself sat at 0%. These tests capture
 * the module-scope McpServer.tool registrations and drive the real handlers
 * with no IPC socket — emit paths render, blocking paths (ask_user, the
 * permission ask branch) are proven to wait rather than auto-timeout.
 *
 * Run: tsx src/main/mcp-servers/__tests__/control-actions-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

setupElectronStub()

// Build mode so permission_prompt's auto-approve branch is reachable; mode is
// captured at module scope from the environment.
process.env.CONVERSATION_MODE = 'build'
delete process.env.IPC_SOCKET_PATH // no socket — emitEvent takes the log-only path

const capture = patchToolCapture()
try {
  delete require.cache[require.resolve('../control-actions-server')]
  require('../control-actions-server')
} finally {
  capture.restore()
}

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

/** Resolves to true when `promise` is still pending after `ms`. */
async function stillPendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const sentinel = Symbol('pending')
  const raced = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected'
    ),
    new Promise((resolve) => setTimeout(() => resolve(sentinel), ms))
  ])
  return raced === sentinel
}

describe('control-actions-server — tool registration', () => {
  test('four tools register', () => {
    assert.deepEqual(capture.names, [
      'emit_plan',
      'ask_user',
      'emit_phase_progress',
      'permission_prompt'
    ])
  })
})

describe('control-actions-server — emit_plan', () => {
  test('a minimal plan is accepted and confirmed', async () => {
    const out = textOf(
      await invokeTool(capture, 'emit_plan', {
        title: 'Stabilize uploads',
        summary: 'Retry multipart uploads on 5xx.'
      })
    )
    assert.ok(out.includes('Stabilize uploads'), out)
    assert.ok(out.includes('emitted successfully'), out)
  })

  test('a full plan with phases and risks is accepted', async () => {
    const out = textOf(
      await invokeTool(capture, 'emit_plan', {
        type: 'bug',
        title: 'Fix retry storm',
        summary: 'Cap retries with jittered backoff.',
        goal: 'Zero retry storms under 5xx bursts',
        phases: [
          {
            id: 1,
            title: 'Add backoff',
            complexity: 3,
            risk: 'low',
            description: 'Jittered exponential backoff in the retry client.'
          }
        ],
        risks: [{ risk: 'Latency regression', severity: 'medium', mitigation: 'Cap total wait' }]
      })
    )
    assert.ok(out.includes('Fix retry storm'), out)
  })

  test('a plan without a title is rejected by the schema', async () => {
    await assert.rejects(
      () => invokeTool(capture, 'emit_plan', { summary: 'no title' } as never),
      (err: any) => /title/.test(String(err?.message ?? err))
    )
  })
})

describe('control-actions-server — emit_phase_progress', () => {
  test('phase-level progress is confirmed with its status', async () => {
    const out = textOf(
      await invokeTool(capture, 'emit_phase_progress', {
        planTitle: 'Stabilize uploads',
        phaseId: 1,
        phaseTitle: 'Backoff',
        status: 'completed',
        totalPhases: 3
      })
    )
    assert.ok(out.includes('Backoff'), out)
    assert.ok(out.includes('completed'), out)
  })

  test('task-level fields are accepted', async () => {
    const out = textOf(
      await invokeTool(capture, 'emit_phase_progress', {
        planTitle: 'Stabilize uploads',
        phaseId: 2,
        phaseTitle: 'Tests',
        status: 'in_progress',
        totalPhases: 3,
        taskId: 't-1',
        taskTitle: 'Add flake test',
        taskStatus: 'running',
        totalTasks: 4
      })
    )
    assert.ok(out.includes('Tests'), out)
  })

  test('an unknown status is rejected by the schema', async () => {
    await assert.rejects(
      () =>
        invokeTool(capture, 'emit_phase_progress', {
          planTitle: 'x',
          phaseId: 1,
          phaseTitle: 'y',
          status: 'paused',
          totalPhases: 1
        } as never),
      (err: any) => /status/.test(String(err?.message ?? err))
    )
  })
})

describe('control-actions-server — permission_prompt', () => {
  test('a pure idle-wait command is denied before anything else', async () => {
    const out = textOf(
      await invokeTool(capture, 'permission_prompt', {
        tool_name: 'Bash',
        input: { command: 'sleep 999' }
      })
    )
    const parsed = JSON.parse(out)
    assert.equal(parsed.behavior, 'deny', out)
    assert.ok(parsed.message?.length > 0, 'deny must carry a message the model can act on')
  })

  test('a safe read auto-approves in build mode (no UI roundtrip)', async () => {
    const out = textOf(
      await invokeTool(capture, 'permission_prompt', {
        tool_name: 'Read',
        input: { file_path: '/repo/src/index.ts' }
      })
    )
    const parsed = JSON.parse(out)
    assert.equal(parsed.behavior, 'allow', out)
    assert.deepEqual(parsed.updatedInput, { file_path: '/repo/src/index.ts' })
  })

  test('a dangerous command in build mode asks the user and waits (no auto-deny)', async () => {
    await runExclusive(async () => {
      const pending = invokeTool(capture, 'permission_prompt', {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/thing' },
        tool_use_id: 'tu-1'
      })
      // With no IPC socket the response can never arrive — the handler must
      // keep waiting instead of denying on the user's behalf.
      assert.ok(
        await stillPendingAfter(pending, 150),
        'permission_prompt must block until a response or socket teardown — no auto-deny'
      )
    })
  })
})

describe('control-actions-server — ask_user', () => {
  test('questions are enriched and the tool blocks for the answer (no auto-timeout)', async () => {
    await runExclusive(async () => {
      const pending = invokeTool(capture, 'ask_user', {
        questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }] }]
      })
      assert.ok(
        await stillPendingAfter(pending, 150),
        'ask_user must block until the user answers or the socket tears down'
      )
    })
  })

  test('a payload without questions is rejected by the schema', async () => {
    await assert.rejects(
      () => invokeTool(capture, 'ask_user', {} as never),
      (err: any) => /questions/.test(String(err?.message ?? err))
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

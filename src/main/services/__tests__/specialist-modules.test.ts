/**
 * Unit tests for specialist orchestration modules:
 * - Semaphore (concurrency control)
 * - ExecutionTracer (structured tracing)
 * - SpecialistHookRunner (lifecycle hooks)
 * - MessageBus (inter-agent communication)
 * - Scheduling strategies (pluggable task prioritization)
 * - Structured output (JSON extraction + validation)
 */
import assert from 'node:assert/strict'

import { Semaphore } from '../specialist/semaphore'
import { ExecutionTracer } from '../specialist/trace'
import type { TraceEvent } from '../specialist/trace'
import { SpecialistHookRunner } from '../specialist/hooks'
import type { BeforeRunContext, AfterRunResult } from '../specialist/hooks'
import { MessageBus } from '../specialist/message-bus'
import { createScheduler, CompositeScheduler } from '../specialist/scheduling'
import type { AgentCapability, SchedulingContext } from '../specialist/scheduling'
import {
  extractJSON,
  validateInvestigationReport,
  validateSchema,
  validateWithSchema,
  InvestigationReportSchema,
  buildFallbackReport
} from '../specialist/structured-output'
import { z } from 'zod'
import type { DecomposedTask } from '../../../shared/types'

let passed = 0
let failed = 0

const asyncTests: Promise<void>[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result instanceof Promise) {
      asyncTests.push(
        result
          .then(() => {
            console.log(`  ✓ ${name}`)
            passed++
          })
          .catch((err) => {
            console.error(`  ✗ ${name}`)
            console.error(`    ${(err as Error).message}`)
            failed++
          })
      )
    } else {
      console.log(`  ✓ ${name}`)
      passed++
    }
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// Helper to make a task
function makeTask(
  id: string,
  specialist: string,
  description: string,
  dependsOn: string[] = []
): DecomposedTask {
  return { id, specialist, description, dependsOn }
}

// ── Semaphore ──────────────────────────────────────────────────

describe('Semaphore', () => {
  test('allows up to maxConcurrency acquisitions', async () => {
    const sem = new Semaphore(2)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    assert.equal(sem.active, 2)
    assert.equal(sem.available, false)
    r1()
    assert.equal(sem.active, 1)
    assert.equal(sem.available, true)
    r2()
    assert.equal(sem.active, 0)
  })

  test('queues when at capacity', async () => {
    const sem = new Semaphore(1)
    const r1 = await sem.acquire()
    let acquired = false
    const p2 = sem.acquire().then((release) => {
      acquired = true
      return release
    })
    assert.equal(sem.waiting, 1)
    assert.equal(acquired, false)
    r1() // release first — should unblock p2
    const r2 = await p2
    assert.equal(acquired, true)
    assert.equal(sem.active, 1)
    r2()
  })

  test('double release is idempotent', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release() // should not crash or go negative
    assert.equal(sem.active, 0)
  })

  test('drain clears waiters', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    sem.acquire() // queued
    sem.acquire() // queued
    assert.equal(sem.waiting, 2)
    sem.drain()
    assert.equal(sem.waiting, 0)
  })

  test('throws on invalid maxConcurrency', () => {
    assert.throws(() => new Semaphore(0), /must be >= 1/)
  })
})

// ── ExecutionTracer ────────────────────────────────────────────

describe('ExecutionTracer', () => {
  test('emits run start and end events', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('test run')
    tracer.endRun(runId)

    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'run_start')
    assert.equal(events[0].runId, runId)
    assert.equal(events[1].type, 'run_end')
    assert.equal(typeof events[1].durationMs, 'number')
  })

  test('tracks spans with timing', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('test')
    const span = tracer.startSpan(runId, 'specialist_start', {
      agentId: 'frontend-architect',
      taskId: 'task-1'
    })
    tracer.endSpan(span, {
      tokenUsage: { input: 1000, output: 500 },
      message: 'completed'
    })
    tracer.endRun(runId)

    // run_start, specialist_start, specialist_end, run_end
    assert.equal(events.length, 4)
    assert.equal(events[2].type, 'specialist_end')
    assert.equal(events[2].agentId, 'frontend-architect')
    assert.equal(events[2].tokenUsage?.input, 1000)
    assert.ok((events[2].durationMs ?? 0) >= 0)
  })

  test('unsubscribe removes listener', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    const unsub = tracer.onTrace((e) => events.push(e))

    tracer.startRun('test1')
    assert.equal(events.length, 1)

    unsub()
    tracer.startRun('test2')
    assert.equal(events.length, 1) // no new events
  })

  test('hasListeners reports correctly', () => {
    const tracer = new ExecutionTracer()
    assert.equal(tracer.hasListeners, false)
    const unsub = tracer.onTrace(() => {})
    assert.equal(tracer.hasListeners, true)
    unsub()
    assert.equal(tracer.hasListeners, false)
  })

  test('listener errors do not crash the pipeline', () => {
    const tracer = new ExecutionTracer()
    tracer.onTrace(() => {
      throw new Error('listener crash')
    })
    // Should not throw
    tracer.startRun('test')
  })
})

// ── SpecialistHookRunner ───────────────────────────────────────

describe('SpecialistHookRunner', () => {
  test('beforeRun hooks can modify context', async () => {
    const runner = new SpecialistHookRunner()
    runner.register('architect', {
      beforeRun: (ctx) => {
        ctx.systemPrompt += '\nExtra: be thorough'
      }
    })

    const context: BeforeRunContext = {
      task: makeTask('t1', 'architect', 'Design API'),
      mode: 'plan',
      systemPrompt: 'You are an architect.',
      fullPrompt: 'Design an API',
      cwd: '/workspace',
      model: 'claude-sonnet',
      attempt: 0
    }

    await runner.runBeforeRun('architect', context)
    assert.ok(context.systemPrompt.includes('Extra: be thorough'))
  })

  test('global hooks run before per-agent hooks', async () => {
    const runner = new SpecialistHookRunner()
    const order: string[] = []

    runner.registerGlobal({
      beforeRun: () => {
        order.push('global')
      }
    })
    runner.register('dev', {
      beforeRun: () => {
        order.push('per-agent')
      }
    })

    await runner.runBeforeRun('dev', {
      task: makeTask('t1', 'dev', 'Build feature'),
      mode: 'build',
      systemPrompt: '',
      fullPrompt: '',
      cwd: '/ws',
      model: 'sonnet',
      attempt: 0
    })

    assert.deepEqual(order, ['global', 'per-agent'])
  })

  test('afterRun errors are caught', async () => {
    const runner = new SpecialistHookRunner()
    runner.register('dev', {
      afterRun: () => {
        throw new Error('hook crash')
      }
    })

    // Should not throw
    await runner.runAfterRun('dev', {
      task: makeTask('t1', 'dev', 'Build'),
      output: 'done',
      success: true,
      tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      durationMs: 1000,
      toolCallCount: 5,
      attempt: 0
    })
  })

  test('unregister removes hooks', async () => {
    const runner = new SpecialistHookRunner()
    let called = false
    const unreg = runner.register('dev', {
      beforeRun: () => {
        called = true
      }
    })

    unreg()
    await runner.runBeforeRun('dev', {
      task: makeTask('t1', 'dev', 'Build'),
      mode: 'build',
      systemPrompt: '',
      fullPrompt: '',
      cwd: '/ws',
      model: 'sonnet',
      attempt: 0
    })

    assert.equal(called, false)
  })
})

// ── MessageBus ─────────────────────────────────────────────────

describe('MessageBus', () => {
  test('send delivers to recipient', () => {
    const bus = new MessageBus()
    bus.send({ from: 'architect', to: 'developer', type: 'context', content: 'Use React Query' })

    const unread = bus.getUnread('developer')
    assert.equal(unread.length, 1)
    assert.equal(unread[0].content, 'Use React Query')
    assert.equal(unread[0].from, 'architect')
  })

  test('broadcast reaches all except sender', () => {
    const bus = new MessageBus()
    bus.broadcast({ from: 'reviewer', type: 'finding', content: 'Missing tests' })

    const devUnread = bus.getUnread('developer')
    const reviewerUnread = bus.getUnread('reviewer')

    assert.equal(devUnread.length, 1)
    assert.equal(reviewerUnread.length, 0) // Sender doesn't see own broadcast
  })

  test('getUnread marks as read', () => {
    const bus = new MessageBus()
    bus.send({ from: 'a', to: 'b', type: 'context', content: 'hello' })

    const first = bus.getUnread('b')
    assert.equal(first.length, 1)

    const second = bus.getUnread('b')
    assert.equal(second.length, 0) // Already read
  })

  test('getConversation returns bidirectional history', () => {
    const bus = new MessageBus()
    bus.send({ from: 'a', to: 'b', type: 'context', content: 'msg1' })
    bus.send({ from: 'b', to: 'a', type: 'feedback', content: 'msg2' })

    const convo = bus.getConversation('a', 'b')
    assert.equal(convo.length, 2)
  })

  test('subscribe receives live messages', () => {
    const bus = new MessageBus()
    const received: string[] = []
    bus.subscribe('dev', (msg) => received.push(msg.content))

    bus.send({ from: 'arch', to: 'dev', type: 'context', content: 'live msg' })
    assert.equal(received.length, 1)
    assert.equal(received[0], 'live msg')
  })

  test('reset clears all state', () => {
    const bus = new MessageBus()
    bus.send({ from: 'a', to: 'b', type: 'context', content: 'msg' })
    bus.reset()
    assert.equal(bus.messageCount, 0)
    assert.equal(bus.getUnread('b').length, 0)
  })
})

// ── Scheduling Strategies ──────────────────────────────────────

describe('Scheduling: dependency-first', () => {
  test('prioritizes tasks with more downstream dependents', () => {
    const scheduler = createScheduler('dependency-first')

    const tasks = [
      makeTask('root', 'arch', 'Design API'),
      makeTask('child1', 'dev', 'Implement routes', ['root']),
      makeTask('child2', 'dev', 'Implement models', ['root']),
      makeTask('leaf', 'test', 'Write tests', ['child1', 'child2'])
    ]

    const context: SchedulingContext = {
      pendingTasks: tasks,
      activeTasks: new Set(),
      completedTasks: new Set(),
      agents: []
    }

    const ranked = scheduler.rankTasks(context)
    // Only root should be ready (no deps met for others)
    assert.equal(ranked.length, 1)
    assert.equal(ranked[0].task.id, 'root')
    assert.ok(ranked[0].score > 0) // root has 3 downstream tasks
  })
})

describe('Scheduling: capability-match', () => {
  test('scores agents by keyword relevance', () => {
    const scheduler = createScheduler('capability-match')

    const task = makeTask('t1', 'developer', 'Build React frontend component')
    const agents: AgentCapability[] = [
      { agentId: 'developer', keywords: ['react', 'frontend', 'component'], activeTaskCount: 0, maxConcurrent: 2 },
      { agentId: 'architect', keywords: ['api', 'design', 'architecture'], activeTaskCount: 0, maxConcurrent: 2 }
    ]

    const selected = scheduler.selectAgent(task, agents)
    // Developer should be kept (already assigned and has matching keywords)
    assert.equal(selected, undefined) // undefined means "keep current"
  })
})

describe('Scheduling: least-busy', () => {
  test('selects agent with lowest load', () => {
    const scheduler = createScheduler('least-busy')

    const task = makeTask('t1', 'dev1', 'Build feature')
    const agents: AgentCapability[] = [
      { agentId: 'dev1', keywords: [], activeTaskCount: 3, maxConcurrent: 4 },
      { agentId: 'dev2', keywords: [], activeTaskCount: 1, maxConcurrent: 4 }
    ]

    const selected = scheduler.selectAgent(task, agents)
    assert.equal(selected, 'dev2')
  })
})

describe('CompositeScheduler', () => {
  test('blends multiple strategies', () => {
    const scheduler = new CompositeScheduler([
      { name: 'capability-match', weight: 0.7 },
      { name: 'least-busy', weight: 0.3 }
    ])

    const tasks = [makeTask('t1', 'dev', 'Build React app')]
    const agents: AgentCapability[] = [
      { agentId: 'dev', keywords: ['react'], activeTaskCount: 0, maxConcurrent: 4 }
    ]

    const context: SchedulingContext = {
      pendingTasks: tasks,
      activeTasks: new Set(),
      completedTasks: new Set(),
      agents
    }

    const ranked = scheduler.rankTasks(context)
    assert.equal(ranked.length, 1)
    assert.ok(ranked[0].reason.includes('composite'))
  })
})

// ── Structured Output ──────────────────────────────────────────

describe('extractJSON', () => {
  test('extracts from code fence', () => {
    const text = 'Some text\n```json\n{"key":"value"}\n```\nMore text'
    const result = extractJSON(text)
    assert.ok(result)
    assert.equal(result.strategy, 'code-fence')
    assert.equal(JSON.parse(result.json).key, 'value')
  })

  test('extracts from investigation-report fence', () => {
    const text = '```investigation-report\n{"problem":"test"}\n```'
    const result = extractJSON(text)
    assert.ok(result)
    assert.equal(result.strategy, 'code-fence')
  })

  test('falls back to bracket matching', () => {
    const text = 'The result is: {"key":"value"} which means...'
    const result = extractJSON(text)
    assert.ok(result)
    assert.equal(result.strategy, 'bracket-match')
  })

  test('falls back to direct parse for pure JSON', () => {
    // bracket-match and direct-parse both work for raw JSON —
    // bracket-match fires first since it finds { }
    const text = '{"key":"value"}'
    const result = extractJSON(text)
    assert.ok(result)
    assert.ok(result.strategy === 'bracket-match' || result.strategy === 'direct-parse')
    assert.equal(JSON.parse(result.json).key, 'value')
  })

  test('returns null for non-JSON text', () => {
    const text = 'No JSON here, just plain text.'
    const result = extractJSON(text)
    assert.equal(result, null)
  })
})

describe('validateInvestigationReport', () => {
  test('validates a correct report', () => {
    const json = JSON.stringify({
      problem: 'NullRef in TokenService',
      rootCause: 'user.Role is null',
      proposedFix: 'Add null check',
      filesAffected: [{ path: 'src/TokenService.cs', reason: 'Missing null check' }],
      impact: 'high',
      impactReason: 'Causes 500 on auth'
    })
    const text = `\`\`\`investigation-report\n${json}\n\`\`\``
    const result = validateInvestigationReport(text)
    assert.ok(result.success)
    if (result.success) {
      assert.equal(result.data.problem, 'NullRef in TokenService')
      assert.equal(result.data.impact, 'high')
      assert.equal(result.strategy, 'code-fence')
    }
  })

  test('rejects report with missing fields', () => {
    const json = JSON.stringify({ problem: 'test' }) // missing most fields
    const text = `\`\`\`json\n${json}\n\`\`\``
    const result = validateInvestigationReport(text)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.length > 0)
      assert.ok(result.errors.some((e) => e.includes('rootCause')))
    }
  })

  test('rejects invalid impact level', () => {
    const json = JSON.stringify({
      problem: 'test',
      rootCause: 'x',
      proposedFix: 'y',
      filesAffected: [],
      impact: 'extreme', // invalid
      impactReason: 'z'
    })
    const result = validateInvestigationReport(json)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.includes('impact')))
    }
  })

  test('returns failure for non-JSON input', () => {
    const result = validateInvestigationReport('This is just plain text with no JSON')
    assert.equal(result.success, false)
  })
})

describe('buildFallbackReport', () => {
  test('preserves valid fields from partial data', () => {
    const partial = { problem: 'Known problem', impact: 'high' }
    const report = buildFallbackReport(partial, 'Parse error')
    assert.equal(report.problem, 'Known problem')
    assert.equal(report.impact, 'high')
    assert.equal(report.rootCause, 'Parse error')
  })

  test('fills defaults for missing fields', () => {
    const report = buildFallbackReport(null, 'No data')
    assert.equal(report.impact, 'medium')
    assert.ok(report.problem.includes('could not be fully parsed'))
  })
})

describe('validateSchema', () => {
  test('validates correct data', () => {
    const errors = validateSchema(
      { name: 'test', count: 42 },
      { name: { type: 'string' }, count: { type: 'number' } }
    )
    assert.equal(errors.length, 0)
  })

  test('catches missing required fields', () => {
    const errors = validateSchema(
      { name: 'test' },
      { name: { type: 'string' }, count: { type: 'number' } }
    )
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('count'))
  })

  test('allows optional fields', () => {
    const errors = validateSchema(
      { name: 'test' },
      { name: { type: 'string' }, count: { type: 'number', required: false } }
    )
    assert.equal(errors.length, 0)
  })

  test('validates enum values', () => {
    const errors = validateSchema(
      { level: 'extreme' },
      { level: { type: 'string', enum: ['low', 'medium', 'high'] } }
    )
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('extreme'))
  })
})

// ── False-positive protection (Issue #1 / #2 regression tests) ──

describe('extractJSON: specificity', () => {
  test('prefers investigation-report fence over json fence', () => {
    const text = [
      '```json',
      '{"key":"wrong"}',
      '```',
      '```investigation-report',
      '{"key":"correct"}',
      '```'
    ].join('\n')
    const result = extractJSON(text)
    assert.ok(result)
    assert.equal(JSON.parse(result.json).key, 'correct')
  })

  test('does not match bare ``` fences (too greedy)', () => {
    // Bare code fences without json/investigation-report language tag should NOT match code-fence strategy
    const text = '```\n{"key":"sneaky"}\n```'
    const result = extractJSON(text)
    // Should fall through to bracket-match, not code-fence
    assert.ok(result)
    assert.equal(result.strategy, 'bracket-match')
  })

  test('investigation-report fence works standalone', () => {
    const text = '```investigation-report\n{"problem":"test","rootCause":"x","proposedFix":"y","filesAffected":[],"impact":"high","impactReason":"z"}\n```'
    const result = extractJSON(text)
    assert.ok(result)
    assert.equal(result.strategy, 'code-fence')
  })
})

describe('validateInvestigationReport: false-positive protection', () => {
  test('does not false-positive on random JSON with matching field names', () => {
    // A build-mode specialist emits JSON that happens to have investigation-like fields
    const output = '```json\n{"problem":"x","rootCause":"y","proposedFix":"z","filesAffected":[],"impact":"high","impactReason":"w"}\n```'
    // Validation should succeed (it's valid JSON with all required fields) — but in context,
    // the isInvestigationTask guard in specialist-pool.service.ts prevents this from running.
    // This test documents that extractJSON does NOT distinguish investigation from generic JSON.
    const result = validateInvestigationReport(output)
    // It will succeed because the JSON has all required fields — the guard is upstream.
    assert.equal(result.success, true)
    // The key protection is the isInvestigationTask guard, not the validator itself.
  })

  test('correctly validates report from investigation-report fence', () => {
    const report = JSON.stringify({
      problem: 'Null pointer in auth handler',
      rootCause: 'user.session can be null after timeout',
      proposedFix: 'Add null check before accessing session.token',
      filesAffected: [{ path: 'src/auth.ts', reason: 'Missing null check' }],
      impact: 'critical',
      impactReason: 'Causes 500 error for all requests after session timeout'
    })
    const output = `Here is my investigation:\n\`\`\`investigation-report\n${report}\n\`\`\`\nThat concludes my findings.`
    const result = validateInvestigationReport(output)
    assert.ok(result.success)
    if (result.success) {
      assert.equal(result.data.impact, 'critical')
      assert.equal(result.strategy, 'code-fence')
    }
  })
})

// ── Trace lifecycle (Issue #7 / #9 regression tests) ──

describe('ExecutionTracer: lifecycle', () => {
  test('startRun → startSpan → endSpan → endRun produces correct event sequence', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('lifecycle test')
    const span = tracer.startSpan(runId, 'specialist_start', {
      agentId: 'test-agent',
      taskId: 'task-1',
      message: 'Starting test agent'
    })
    const durationMs = tracer.endSpan(span, {
      tokenUsage: { input: 500, output: 200, cacheRead: 100 },
      message: 'Done'
    })
    tracer.endRun(runId, { tasksCompleted: 1 })

    // Verify event sequence
    assert.equal(events.length, 4)
    assert.equal(events[0].type, 'run_start')
    assert.equal(events[1].type, 'specialist_start')
    assert.equal(events[2].type, 'specialist_end')
    assert.equal(events[3].type, 'run_end')

    // Verify correlation
    assert.ok(events.every((e) => e.runId === runId))

    // Verify span timing
    assert.equal(typeof durationMs, 'number')
    assert.ok(durationMs >= 0)
    assert.equal(events[2].durationMs, durationMs)

    // Verify token usage propagation
    assert.equal(events[2].tokenUsage?.input, 500)
    assert.equal(events[2].tokenUsage?.output, 200)
    assert.equal(events[2].tokenUsage?.cacheRead, 100)

    // Verify run_end metadata
    assert.equal(events[3].metadata?.tasksCompleted, 1)
    // eventCount is captured before the run_end event is recorded (3 prior events + run_end itself = 4 total in listener)
    assert.equal(events[3].metadata?.eventCount, 3)
    assert.ok((events[3].durationMs ?? 0) >= 0)
  })

  test('endSpan returns durationMs for consistent afterRun reporting', () => {
    const tracer = new ExecutionTracer()
    const runId = tracer.startRun('duration test')
    const span = tracer.startSpan(runId, 'specialist_start', { agentId: 'agent-1' })

    // endSpan should return a number
    const duration = tracer.endSpan(span, { message: 'done' })
    assert.equal(typeof duration, 'number')
    assert.ok(duration >= 0)

    tracer.endRun(runId)
  })

  test('endSpan type guard falls back for non-paired event types', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('type guard test')
    // Use a non-paired type (task_retry has no task_retry_end)
    const span = tracer.startSpan(runId, 'task_retry', { taskId: 'task-1' })
    tracer.endSpan(span)
    tracer.endRun(runId)

    // The endSpan event should fall back to 'error' type since 'task_retry' → 'task_retry_end' is not a valid end type
    // Find the fallback event (not run_start, not task_retry, not run_end)
    const endEvent = events.find((e) => e.type === 'error')
    assert.ok(endEvent, 'Expected fallback error event for non-paired span type')
  })
})

// ── Semaphore fairness (Issue #3) ──

describe('Semaphore: fairness', () => {
  test('FIFO ordering of waiters', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const r1 = await sem.acquire()

    // Queue three waiters — they should resolve in FIFO order
    const p2 = sem.acquire().then((r) => { order.push(2); return r })
    const p3 = sem.acquire().then((r) => { order.push(3); return r })
    const p4 = sem.acquire().then((r) => { order.push(4); return r })

    assert.equal(sem.waiting, 3)

    // Release first — should unblock in order
    r1()
    const r2 = await p2
    r2()
    const r3 = await p3
    r3()
    const r4 = await p4
    r4()

    assert.deepEqual(order, [2, 3, 4])
  })
})

// ── Hook tool observation (Issue #5) ──

describe('SpecialistHookRunner: tool hooks', () => {
  test('fireToolCall and fireToolResult deliver to registered hooks', () => {
    const runner = new SpecialistHookRunner()
    const toolCalls: string[] = []
    const toolResults: string[] = []

    runner.register('dev', {
      onToolCall: (ctx) => toolCalls.push(ctx.toolName),
      onToolResult: (ctx) => toolResults.push(ctx.toolName)
    })

    const task = makeTask('t1', 'dev', 'Build feature')
    runner.fireToolCall('dev', { task, toolName: 'Read', toolCallIndex: 1 })
    runner.fireToolResult('dev', { task, toolName: 'Read', toolCallIndex: 1 })
    runner.fireToolCall('dev', { task, toolName: 'Write', toolCallIndex: 2 })

    assert.deepEqual(toolCalls, ['Read', 'Write'])
    assert.deepEqual(toolResults, ['Read'])
  })

  test('tool hooks errors are swallowed (never crash pipeline)', () => {
    const runner = new SpecialistHookRunner()
    runner.register('dev', {
      onToolCall: () => { throw new Error('crash') },
      onToolResult: () => { throw new Error('crash') }
    })

    const task = makeTask('t1', 'dev', 'Build feature')
    // Should not throw
    runner.fireToolCall('dev', { task, toolName: 'Read', toolCallIndex: 1 })
    runner.fireToolResult('dev', { task, toolName: 'Read', toolCallIndex: 1 })
  })
})

// ── Semaphore.run() ───────────────────────────────────────────

describe('Semaphore: run() auto-release', () => {
  test('run() auto-releases on success', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(async () => 'hello')
    assert.equal(result, 'hello')
    assert.equal(sem.active, 0) // released
  })

  test('run() auto-releases on error', async () => {
    const sem = new Semaphore(1)
    try {
      await sem.run(async () => { throw new Error('boom') })
    } catch { /* expected */ }
    assert.equal(sem.active, 0) // still released on error
  })

  test('run() supports concurrency queuing', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const p1 = sem.run(async () => { order.push(1) })
    const p2 = sem.run(async () => { order.push(2) })
    const p3 = sem.run(async () => { order.push(3) })

    await Promise.all([p1, p2, p3])
    assert.deepEqual(order, [1, 2, 3])
    assert.equal(sem.active, 0)
  })
})

// ── Zod Validation ────────────────────────────────────────────

describe('InvestigationReportSchema (Zod)', () => {
  test('validates a correct report', () => {
    const data = {
      problem: 'NullRef in TokenService',
      rootCause: 'user.Role is null',
      proposedFix: 'Add null check',
      filesAffected: [{ path: 'src/TokenService.cs', reason: 'Missing null check' }],
      impact: 'high' as const,
      impactReason: 'Causes 500 on auth'
    }
    const result = InvestigationReportSchema.safeParse(data)
    assert.ok(result.success)
  })

  test('rejects empty required fields', () => {
    const data = {
      problem: '',
      rootCause: 'x',
      proposedFix: 'y',
      filesAffected: [],
      impact: 'low',
      impactReason: 'z'
    }
    const result = InvestigationReportSchema.safeParse(data)
    assert.equal(result.success, false)
  })

  test('rejects invalid impact level', () => {
    const data = {
      problem: 'test',
      rootCause: 'x',
      proposedFix: 'y',
      filesAffected: [],
      impact: 'extreme',
      impactReason: 'z'
    }
    const result = InvestigationReportSchema.safeParse(data)
    assert.equal(result.success, false)
  })

  test('rejects missing fields', () => {
    const data = { problem: 'only this' }
    const result = InvestigationReportSchema.safeParse(data)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.error.issues.length > 0)
    }
  })
})

describe('validateWithSchema (generic Zod validator)', () => {
  test('validates correct data', () => {
    const schema = z.object({ name: z.string(), count: z.number() })
    const result = validateWithSchema({ name: 'test', count: 42 }, schema)
    assert.ok(result.success)
    if (result.success) {
      assert.equal(result.data.name, 'test')
      assert.equal(result.data.count, 42)
    }
  })

  test('rejects invalid data with field-level errors', () => {
    const schema = z.object({ name: z.string(), count: z.number() })
    const result = validateWithSchema({ name: 123, count: 'not a number' }, schema)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.length >= 2)
      assert.ok(result.errors.some(e => e.includes('name')))
      assert.ok(result.errors.some(e => e.includes('count')))
    }
  })
})

// ── Scheduling Integration ────────────────────────────────────

describe('Scheduling: dependency-first respects completedTasks', () => {
  test('unlocks downstream tasks when dependencies complete', () => {
    const scheduler = createScheduler('dependency-first')

    const tasks = [
      makeTask('root', 'arch', 'Design API'),
      makeTask('child1', 'dev', 'Implement routes', ['root']),
      makeTask('child2', 'dev', 'Implement models', ['root']),
      makeTask('leaf', 'test', 'Write tests', ['child1', 'child2'])
    ]

    // After root completes, child1 and child2 should be ready
    const context: SchedulingContext = {
      pendingTasks: tasks.slice(1), // root is done, removed from pending
      activeTasks: new Set(),
      completedTasks: new Set(['root']),
      agents: []
    }

    const ranked = scheduler.rankTasks(context)
    // child1 and child2 should be ready (their dependency 'root' is completed)
    assert.equal(ranked.length, 2)
    const readyIds = ranked.map(r => r.task.id).sort()
    assert.deepEqual(readyIds, ['child1', 'child2'])
  })

  test('leaf tasks only unlock when all deps complete', () => {
    const scheduler = createScheduler('dependency-first')

    const tasks = [
      makeTask('child1', 'dev', 'Implement routes', ['root']),
      makeTask('child2', 'dev', 'Implement models', ['root']),
      makeTask('leaf', 'test', 'Write tests', ['child1', 'child2'])
    ]

    // Only child1 completed — leaf should NOT be ready
    const context: SchedulingContext = {
      pendingTasks: tasks.slice(1), // child2 and leaf still pending
      activeTasks: new Set(),
      completedTasks: new Set(['root', 'child1']),
      agents: []
    }

    const ranked = scheduler.rankTasks(context)
    // Only child2 should be ready (leaf needs both child1 AND child2)
    assert.equal(ranked.length, 1)
    assert.equal(ranked[0].task.id, 'child2')
  })
})

// ── MessageBus: dependency injection ──────────────────────────

describe('MessageBus: dependency messages for prompt injection', () => {
  test('getUnread returns dependency messages for specialist', () => {
    const bus = new MessageBus()

    // Simulate a completed task broadcasting its output
    bus.broadcast({
      from: 'architect',
      type: 'dependency',
      content: 'API design: use REST with versioning',
      taskId: 'task-1',
      metadata: { status: 'completed' }
    })

    // Developer specialist picks up the message
    const unread = bus.getUnread('developer')
    assert.equal(unread.length, 1)
    assert.equal(unread[0].type, 'dependency')
    assert.equal(unread[0].from, 'architect')
    assert.ok(unread[0].content.includes('REST'))

    // Second read returns empty (already read)
    const unread2 = bus.getUnread('developer')
    assert.equal(unread2.length, 0)
  })

  test('sender does not receive own broadcast', () => {
    const bus = new MessageBus()
    bus.broadcast({
      from: 'architect',
      type: 'dependency',
      content: 'output',
      taskId: 'task-1'
    })

    const unread = bus.getUnread('architect')
    assert.equal(unread.length, 0)
  })
})

// ── Trace Bridge ──────────────────────────────────────────────

describe('Trace bridge: event mapping', () => {
  test('specialist_start and specialist_end events are emitted correctly', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('bridge test')
    const span = tracer.startSpan(runId, 'specialist_start', {
      agentId: 'frontend-architect',
      taskId: 'task-1',
      metadata: { conversationId: 'conv-123', model: 'sonnet' }
    })

    tracer.endSpan(span, {
      tokenUsage: { input: 1000, output: 500 },
      message: 'Completed'
    })
    tracer.endRun(runId)

    // Verify specialist_start event has metadata for bridge
    const startEvent = events.find(e => e.type === 'specialist_start')
    assert.ok(startEvent)
    assert.equal(startEvent?.metadata?.conversationId, 'conv-123')
    assert.equal(startEvent?.metadata?.model, 'sonnet')
    assert.equal(startEvent?.agentId, 'frontend-architect')

    // Verify specialist_end event has token usage for bridge
    const endEvent = events.find(e => e.type === 'specialist_end')
    assert.ok(endEvent)
    assert.equal(endEvent?.tokenUsage?.input, 1000)
    assert.equal(endEvent?.tokenUsage?.output, 500)
    assert.ok(!endEvent?.metadata?.error) // success path
  })

  test('specialist_end with error metadata for failure path', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('error bridge test')
    const span = tracer.startSpan(runId, 'specialist_start', {
      agentId: 'dev',
      taskId: 'task-2',
      metadata: { conversationId: 'conv-456' }
    })

    tracer.endSpan(span, {
      error: 'SDK timeout after 10 minutes',
      tokenUsage: { input: 500, output: 100 }
    })
    tracer.endRun(runId)

    const endEvent = events.find(e => e.type === 'specialist_end')
    assert.ok(endEvent)
    assert.equal(endEvent?.metadata?.error, 'SDK timeout after 10 minutes')
  })

  test('task_retry event carries attempt metadata', () => {
    const tracer = new ExecutionTracer()
    const events: TraceEvent[] = []
    tracer.onTrace((e) => events.push(e))

    const runId = tracer.startRun('retry test')
    tracer.traceEvent(runId, 'task_retry', {
      agentId: 'dev',
      taskId: 'task-3',
      message: 'Retry 1/2 in 2000ms',
      metadata: { attempt: 1, error: 'Rate limited', conversationId: 'conv-789' }
    })
    tracer.endRun(runId)

    const retryEvent = events.find(e => e.type === 'task_retry')
    assert.ok(retryEvent)
    assert.equal(retryEvent?.metadata?.attempt, 1)
    assert.equal(retryEvent?.metadata?.error, 'Rate limited')
    assert.equal(retryEvent?.metadata?.conversationId, 'conv-789')
  })
})

// ── Summary ────────────────────────────────────────────────────

// Wait for all async tests to complete before printing summary
Promise.all(asyncTests).then(() => {
  console.log(`\n─────────────────────────────────`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})

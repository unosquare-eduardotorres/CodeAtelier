/**
 * Graceful turn cancel — CLIExecutor.interrupt() and the cancel path that
 * prefers it over a process kill.
 *
 * Protocol facts these tests encode were measured against claude 2.1.228:
 *   • an interrupt is acked in-band and the turn ends with a `result` whose
 *     subtype is `error_during_execution` (is_error: true),
 *   • the process stays alive and answers the next stdin message,
 * so a honoured interrupt must NOT kill, must NOT poison, and must NOT surface
 * the result's error flag to the user.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from './test-harness'
import { setupFullMock } from './setup-full-mock'

setupFullMock()

const { CLIExecutor } = require('../cli-executor')
const { AgentSessionService } = require('../agent-session.service')
const { AgentRecoveryManager } = require('../agent-recovery-manager')

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FakeProcess extends EventEmitter {
  killed: boolean
  exitCode: number | null
  pid: number
  stdin: { write: (chunk: string) => boolean; end: () => void }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: string) => boolean
  writes: string[]
}

/** Minimal stand-in for a live `claude` child process. */
function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.writes = []
  proc.killed = false
  proc.exitCode = null
  proc.pid = 4242
  proc.stdin = {
    write: (chunk: string): boolean => {
      proc.writes.push(chunk)
      return true
    },
    end: (): void => {}
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = (): boolean => {
    proc.killed = true
    proc.exitCode = 0
    setImmediate(() => proc.emit('exit', 0, 'SIGTERM'))
    return true
  }
  return proc
}

/** Hand-fed NDJSON iterator — stands in for the parsed stdout stream. */
function createFakeIterator(): {
  push: (msg: Record<string, unknown>) => void
  iterator: AsyncGenerator<Record<string, unknown>>
} {
  const queue: Record<string, unknown>[] = []
  let wake: (() => void) | null = null
  const iterator = {
    async next(): Promise<IteratorResult<Record<string, unknown>>> {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      return { value: queue.shift()!, done: false }
    },
    async return(): Promise<IteratorResult<Record<string, unknown>>> {
      return { value: undefined as never, done: true }
    }
  } as unknown as AsyncGenerator<Record<string, unknown>>

  return {
    push: (msg): void => {
      queue.push(msg)
      const w = wake
      wake = null
      w?.()
    },
    iterator
  }
}

const baseOptions = {
  prompt: 'hello',
  systemPrompt: 'sys',
  model: 'claude-haiku-4-5',
  cwd: '/tmp',
  permissionMode: 'bypassPermissions' as const,
  continueSession: true
}

/** The turn-ending frame the CLI emits when it honours an interrupt. */
const interruptedResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  session_id: 'sess-1'
}

/** The ack shape observed on claude 2.1.228. */
const ackFor = (requestId: string, subtype: 'success' | 'error' = 'success'): Record<string, unknown> => ({
  type: 'control_response',
  response:
    subtype === 'success'
      ? { subtype, request_id: requestId, response: { still_queued: [] } }
      : { subtype, request_id: requestId, error: 'unknown control request subtype' }
})

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start a turn on a fake process/iterator and park it on the first read.
 * Returns the collected chunks (still filling) and the live executor.
 */
function startTurn(): {
  executor: any
  proc: FakeProcess
  feed: ReturnType<typeof createFakeIterator>
  chunks: any[]
  done: Promise<void>
} {
  const executor = new CLIExecutor()
  const proc = createFakeProcess()
  const feed = createFakeIterator()
  executor.cliProcess = proc
  executor.ndjsonIterator = feed.iterator
  // A live process that has reported back after the previous turn — the state
  // execute() requires to write this turn's prompt to stdin.
  executor.cliReadyForInput = true

  const chunks: any[] = []
  const done = (async () => {
    for await (const chunk of executor.execute(baseOptions)) chunks.push(chunk)
  })()

  return { executor, proc, feed, chunks, done }
}

/** The request_id of the interrupt control_request written to stdin. */
function interruptRequestId(proc: FakeProcess): string {
  const written = findInterruptWrite(proc)
  assert.ok(written, 'an interrupt control_request was written')
  return written!.request_id as string
}

/** The interrupt control_request written to stdin, if any. */
function findInterruptWrite(proc: FakeProcess): Record<string, any> | undefined {
  return proc.writes
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((msg) => msg?.type === 'control_request' && msg?.request?.subtype === 'interrupt')
}

// ── interrupt() ─────────────────────────────────────────────────────────────

describe('CLIExecutor.interrupt', () => {
  test('no-ops when no process is running', async () => {
    const executor = new CLIExecutor()
    assert.equal(await executor.interrupt(), false)
    assert.equal(executor.isInterruptPending(), false)
  })

  test('no-ops between turns — nothing to cancel', async () => {
    const executor = new CLIExecutor()
    const proc = createFakeProcess()
    executor.cliProcess = proc
    executor.cliReadyForInput = true

    assert.equal(await executor.interrupt(), false)
    assert.equal(proc.writes.length, 0, 'must not write to stdin when idle')
  })

  test('writes an interrupt control_request and resolves true on the turn result', async () => {
    const { executor, proc, feed, done } = startTurn()
    await tick()

    const pending = executor.interrupt()
    assert.equal(executor.isInterruptPending(), true)

    const written = findInterruptWrite(proc)
    assert.ok(written, 'interrupt control_request written to stdin')
    assert.ok(
      typeof written!.request_id === 'string' && written!.request_id.startsWith('int_'),
      'request carries a correlatable id'
    )

    feed.push(interruptedResult)
    assert.equal(await pending, true, 'resolves graceful once the turn ends')
    await done

    assert.equal(executor.isInterruptPending(), false)
    assert.equal(proc.killed, false, 'the process is left alive and reusable')
    assert.equal(executor.cliReadyForInput, true, 'ready for the next stdin message')
  })

  test('a honoured interrupt surfaces no error chunk', async () => {
    const { executor, feed, chunks, done } = startTurn()
    await tick()

    const pending = executor.interrupt()
    feed.push(interruptedResult)
    await pending
    await done

    assert.equal(
      chunks.filter((c) => c.type === 'error').length,
      0,
      'the is_error result is the requested outcome, not a failure to report'
    )
  })

  test('the same result WITHOUT an interrupt still reports an error', async () => {
    const { feed, chunks, done } = startTurn()
    await tick()

    feed.push(interruptedResult)
    await done

    const errors = chunks.filter((c) => c.type === 'error')
    assert.equal(errors.length, 1, 'an unrequested failure must still surface')
    assert.match(errors[0].error, /Execution stopped/)
  })

  test('resolves false when the CLI never unwinds', async () => {
    const { executor, done, feed } = startTurn()
    await tick()

    assert.equal(await executor.interrupt(30), false)
    assert.equal(executor.isInterruptPending(), false)

    // Release the parked read so the generator can finish.
    feed.push({ type: 'result', subtype: 'success', is_error: false })
    await done
  })

  test('a second request joins the first instead of issuing another', async () => {
    const { executor, proc, feed, done } = startTurn()
    await tick()

    const first = executor.interrupt()
    const second = executor.interrupt()
    feed.push(interruptedResult)

    assert.equal(await first, true)
    assert.equal(await second, true)
    await done

    const interrupts = proc.writes.filter((line) => line.includes('"interrupt"'))
    assert.equal(interrupts.length, 1, 'only one control_request on the wire')
  })

  test('an error ack escalates immediately instead of waiting out the deadline', async () => {
    const { executor, proc, feed, done } = startTurn()
    await tick()

    // A deadline long enough that only the ack itself can settle this.
    const pending = executor.interrupt(60_000)
    feed.push(ackFor(interruptRequestId(proc), 'error'))

    try {
      const settled = await Promise.race([pending, tick(300).then(() => 'unsettled' as const)])
      assert.equal(settled, false, 'a rejected interrupt is answered, not waited out')
    } finally {
      // Release the parked read even on failure — a regression must report, not hang.
      feed.push({ type: 'result', subtype: 'success', is_error: false })
      await done
    }
  })

  test('a success ack buys time past the capability deadline', async () => {
    const { executor, proc, feed, done } = startTurn()
    await tick()

    // 40ms would expire almost immediately; the ack proves the CLI understood
    // the request, so the wait becomes about teardown, not capability.
    const pending = executor.interrupt(40)
    feed.push(ackFor(interruptRequestId(proc)))
    await tick(120)

    try {
      assert.equal(executor.isInterruptPending(), true, 'still waiting after the ack deadline')
    } finally {
      feed.push(interruptedResult)
      await Promise.race([pending, tick(500)])
      await done
    }
    assert.equal(await pending, true)
  })

  test('an ack for a different request is ignored', async () => {
    const { executor, feed, done } = startTurn()
    await tick()

    const pending = executor.interrupt(40)
    feed.push(ackFor('int_someone_else'))

    try {
      const settled = await Promise.race([pending, tick(400).then(() => 'unsettled' as const)])
      assert.equal(settled, false, 'a foreign ack must not extend our deadline')
    } finally {
      feed.push({ type: 'result', subtype: 'success', is_error: false })
      await done
    }
  })

  test('wasTurnGracefullyCancelled reports the outcome of the turn just ended', async () => {
    const first = startTurn()
    await tick()
    assert.equal(first.executor.wasTurnGracefullyCancelled(), false, 'nothing cancelled yet')

    const pending = first.executor.interrupt()
    first.feed.push(interruptedResult)
    await pending
    await first.done
    assert.equal(first.executor.wasTurnGracefullyCancelled(), true)

    // The flag belongs to a turn, not to the executor: the next turn starts clean.
    const chunks: any[] = []
    const next = (async () => {
      for await (const chunk of first.executor.execute(baseOptions)) chunks.push(chunk)
    })()
    await tick()
    assert.equal(first.executor.wasTurnGracefullyCancelled(), false, 'reset for the new turn')
    first.feed.push({ type: 'result', subtype: 'success', is_error: false })
    await next
  })

  test('killProcess settles a pending interrupt as non-graceful', async () => {
    const { executor, feed, done } = startTurn()
    await tick()

    // A timeout long enough that only the kill itself can settle this.
    const pending = executor.interrupt(60_000)
    await executor.killProcess()

    try {
      // Settled by the kill, not by eventually hitting the escalation timer —
      // the caller is already escalating and must not wait on it.
      assert.equal(executor.isInterruptPending(), false, 'settled by the kill')
      const settled = await Promise.race([pending, tick(200).then(() => 'unsettled' as const)])
      assert.equal(settled, false, 'a killed turn never ended gracefully')
    } finally {
      // Release the parked read even when an assertion above failed, so a
      // regression reports as a failure instead of hanging the suite.
      feed.push(interruptedResult)
      await done
    }
  })
})

// ── The cancel path ─────────────────────────────────────────────────────────

function createMockAdapter(): Record<string, unknown> {
  return {
    role: 'specialist',
    agentId: 'test-specialist',
    buildSystemPrompt: () => 'sys',
    getGoalCondition: () => null,
    getGoalMode: () => null,
    buildMcpConfig: () => ({ tools: [] }),
    getControlCallbacks: () => ({ onPlan: () => {}, onAskUser: () => {} }),
    buildControlCallbacks: () => ({ onPlan: () => {}, onAskUser: () => {} }),
    detectIntents: () => [],
    refreshFeatureFlags: () => {},
    buildPrompts: () => ({ systemPrompt: 'sys', effectiveMessage: 'msg' }),
    onSendSuccess: () => {},
    onSessionStop: () => {},
    emitDetectedIntents: () => {}
  }
}

/** A session wired to one conversation whose CLI executor is `executor`. */
function createSession(executor: Record<string, unknown>): {
  session: any
  abortController: AbortController
} {
  const session = new AgentSessionService(createMockAdapter() as any)
  const abortController = new AbortController()
  session.executorBackend = 'cli'
  session.cliExecutors.set('conv-1', executor)
  session.activeStreams.set('conv-1', { abortController, accumulatedText: 'partial' })
  return { session, abortController }
}

describe('AgentSessionService.cancelCurrentQuery — CLI backend', () => {
  test('a honoured interrupt neither aborts nor kills', async () => {
    let killed = false
    const executor = {
      isAlive: () => true,
      interrupt: async (): Promise<boolean> => true,
      killProcess: async (): Promise<void> => {
        killed = true
      }
    }
    const { session, abortController } = createSession(executor)

    session.cancelCurrentQuery('conv-1')
    await tick(10)

    assert.equal(killed, false, 'the process must survive a graceful cancel')
    assert.equal(abortController.signal.aborted, false, 'aborting would kill the child')
    assert.ok(
      session.activeStreams.get('conv-1')?.abortController,
      'the turn is left to finalise through its normal path'
    )
  })

  test('an ignored interrupt escalates to abort + kill', async () => {
    let killed = false
    const executor = {
      isAlive: () => true,
      interrupt: async (): Promise<boolean> => false,
      killProcess: async (): Promise<void> => {
        killed = true
      }
    }
    const { session, abortController } = createSession(executor)

    session.cancelCurrentQuery('conv-1')
    await tick(10)

    assert.equal(killed, true, 'falls back to the kill path')
    assert.equal(abortController.signal.aborted, true)
  })

  test('a throwing interrupt still escalates', async () => {
    let killed = false
    const executor = {
      isAlive: () => true,
      interrupt: async (): Promise<boolean> => {
        throw new Error('stdin closed')
      },
      killProcess: async (): Promise<void> => {
        killed = true
      }
    }
    const { session, abortController } = createSession(executor)

    session.cancelCurrentQuery('conv-1')
    await tick(10)

    assert.equal(killed, true)
    assert.equal(abortController.signal.aborted, true)
  })

  test('the cancelled turn is flagged for the post-turn pipeline', async () => {
    const executor = {
      isAlive: () => true,
      interrupt: async (): Promise<boolean> => true,
      killProcess: async (): Promise<void> => {}
    }
    const { session } = createSession(executor)

    session.cancelCurrentQuery('conv-1')
    await tick(10)

    assert.equal(
      session.activeStreams.get('conv-1')?.cancelledByUser,
      true,
      'executeStream reads this to skip continuation work'
    )
  })

  test('cancelling with no conversation id interrupts instead of killing everything', async () => {
    const killed: string[] = []
    const interrupted: string[] = []
    const makeExecutor = (id: string): Record<string, unknown> => ({
      isAlive: () => true,
      interrupt: async (): Promise<boolean> => {
        interrupted.push(id)
        return true
      },
      killProcess: async (): Promise<void> => {
        killed.push(id)
      }
    })

    const session = new AgentSessionService(createMockAdapter() as any)
    session.executorBackend = 'cli'
    const controllers = new Map<string, AbortController>()
    for (const id of ['conv-1', 'conv-2']) {
      session.cliExecutors.set(id, makeExecutor(id))
      const ac = new AbortController()
      controllers.set(id, ac)
      session.activeStreams.set(id, { abortController: ac, accumulatedText: '' })
    }

    // The renderer passes `activeConversation?.id` — undefined when the chat was
    // switched or closed mid-stream. That must not cost every live session.
    session.cancelCurrentQuery()
    await tick(10)

    assert.deepEqual(interrupted.sort(), ['conv-1', 'conv-2'])
    assert.deepEqual(killed, [], 'no executor is killed on a stop-all')
    for (const id of ['conv-1', 'conv-2']) {
      assert.equal(controllers.get(id)!.signal.aborted, false, `${id} not aborted`)
      assert.equal(session.activeStreams.get(id)?.cancelledByUser, true, `${id} flagged`)
    }
  })

  test('a dead executor takes the plain abort path', async () => {
    let interruptCalls = 0
    const executor = {
      isAlive: () => false,
      interrupt: async (): Promise<boolean> => {
        interruptCalls++
        return true
      },
      killProcess: async (): Promise<void> => {}
    }
    const { session, abortController } = createSession(executor)

    session.cancelCurrentQuery('conv-1')
    await tick(10)

    assert.equal(interruptCalls, 0, 'nothing to interrupt when the process is gone')
    assert.equal(abortController.signal.aborted, true)
  })
})

// ── The post-turn pipeline ──────────────────────────────────────────────────

/**
 * finalizeStream with the private continuation steps stubbed, so the test
 * observes which steps a cancelled turn is allowed to reach.
 */
function createRecoveryManager(): {
  manager: any
  calls: string[]
  params: Record<string, unknown>
} {
  const calls: string[] = []
  const manager = new AgentRecoveryManager({
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    circuitBreaker: { isBroken: false, count: 0 },
    activeStreams: new Map([['conv-1', { accumulatedText: '', accumulatedTextBaseline: 0 }]])
  })
  manager.handleOverloadOrMaxTurns = async (): Promise<'continue'> => {
    calls.push('auto-continue')
    return 'continue'
  }
  manager.attemptStreamRecovery = async (): Promise<void> => {
    calls.push('recovery-nudge')
  }
  manager.captureSummaryAndIntents = (): void => {
    calls.push('complete')
  }

  const params = {
    conversationId: 'conv-1',
    systemPrompt: 'sys',
    isBuildMode: false,
    recoveryDepth: 0,
    timedOut: false,
    streamState: { messageStopReceived: true, planModeToolBlock: true },
    mcpResult: { mcpServers: {} },
    llmProvider: 'claude'
  }

  return { manager, calls, params }
}

describe('AgentRecoveryManager.finalizeStream — user-cancelled turns', () => {
  test('a normal turn still runs auto-continue and the recovery nudge', async () => {
    const { manager, calls, params } = createRecoveryManager()
    await manager.finalizeStream(params)
    assert.deepEqual(calls, ['auto-continue', 'recovery-nudge', 'complete'])
  })

  test('a cancelled turn completes without starting another turn', async () => {
    const { manager, calls, params } = createRecoveryManager()
    await manager.finalizeStream({ ...params, userCancelled: true })
    assert.deepEqual(
      calls,
      ['complete'],
      'neither continuation path may dispatch work after a Stop'
    )
  })
})

// ── Abandoned permission prompts ────────────────────────────────────────────

describe('AgentSessionService — permissions abandoned by a cancelled turn', () => {
  test('an abandoned prompt is denied over the bridge, not just in the UI', () => {
    const session = new AgentSessionService(createMockAdapter() as any)
    const sent: Array<[string, boolean]> = []
    session.ipcBridge = {
      sendPermissionResponse: (requestId: string, approved: boolean): void => {
        sent.push([requestId, approved])
      }
    }
    const resolved: string[] = []
    session.on('permissionResolved', (evt: { requestId: string }) => resolved.push(evt.requestId))

    const executor = session.getOrCreateCliExecutor('conv-1')
    // What the executor does when a turn finalizes with a prompt outstanding.
    executor.onHumanDecisionsCleared!(['req-1', 'req-2'], 'turn finalized')

    assert.deepEqual(resolved, ['req-1', 'req-2'], 'the UI prompt is released')
    assert.deepEqual(
      sent,
      [
        ['req-1', false],
        ['req-2', false]
      ],
      'the MCP handler is answered so it does not sit on the socket forever'
    )
  })

  test('a missing bridge is not fatal', () => {
    const session = new AgentSessionService(createMockAdapter() as any)
    session.ipcBridge = null
    const executor = session.getOrCreateCliExecutor('conv-1')
    executor.onHumanDecisionsCleared!(['req-1'], 'CLI process killed')
  })
})

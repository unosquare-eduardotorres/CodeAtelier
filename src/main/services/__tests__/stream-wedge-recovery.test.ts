/**
 * Regression tests for the two wedge bugs.
 *
 * Bug A — executor parked forever.
 *   The read loop suspends the wall-clock timeout while an ask_user/elicitation
 *   tool is pending, because a human may legitimately take any amount of time.
 *   Nothing else bounded that wait, so if the CLI process died while the prompt
 *   was outstanding the loop parked on `iterator.next()` indefinitely — silent,
 *   holding the conversation lock. Every read now races an exit signal.
 *
 * Bug C — the wall clock running while a human decides.
 *   A permission prompt reaches the CLI out of band (--permission-prompt-tool
 *   over the IPC bridge), never as a tool_use on the NDJSON stream, so the only
 *   thing the executor can see pending is the *gated* tool. The read therefore
 *   sat on the 10-minute tool-result budget and tore the turn down while the
 *   user was still deciding. The budget is now a ticking countdown that only
 *   decrements while no human decision is outstanding.
 *
 * Bug B — conversation busy state outliving its stream.
 *   "Busy" is three separate pieces of state (lock, state machine, lifecycle).
 *   acquireStreamLock rejected on their union while both stall watchdogs tested
 *   only `streamingLocks`, so a conversation left non-idle in the state machine
 *   with its lock released blocked every send with no timer able to recover it.
 *
 * Runs via run-tests.ts / run-all.ts (they install the electron stub before
 * importing test files — ESM imports here hoist above any local stub call).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { conversationStateMachine } from '../conversation-state-machine'
import { lifecycleRegistry } from '../conversation-lifecycle'
import { CLIExecutor } from '../cli-executor'

// ══════════════════════════════════════════════════════════════════════════════
// Bug A — the exit signal bounds every read
// ══════════════════════════════════════════════════════════════════════════════

/** Type overlay exposing the executor's private wait plumbing. */
interface ExecutorInternal {
  armExitSignal(): void
  disarmExitSignal(reason: string): void
  raceRead(
    read: Promise<IteratorResult<Record<string, unknown>>>,
    timeoutMs: number | null,
    timeoutMessage: string
  ): Promise<IteratorResult<Record<string, unknown>>>
  beginHumanDecision(requestId: string): void
  endHumanDecision(requestId: string): void
  clearHumanDecisions(reason: string): void
  hasHumanDecisionPending(): boolean
  onHumanDecisionsCleared: ((requestIds: string[], reason: string) => void) | null
}

function internals(): ExecutorInternal {
  return new CLIExecutor() as unknown as ExecutorInternal
}

/** A read that never settles — models a dead CLI that never closes stdout. */
function neverSettles(): Promise<IteratorResult<Record<string, unknown>>> {
  return new Promise(() => {})
}

/**
 * True if `p` is still pending after a full event-loop turn. `setImmediate`
 * resolves on the check phase, so a genuinely pending promise always loses the
 * race — deterministic, unlike a wall-clock sleep.
 */
async function stillPending(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => false,
      () => false
    ),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))
  ])
}

describe('CLIExecutor exit signal', () => {
  test('untimed_read_still_rejects_when_process_exits', async () => {
    // This is the exact ask_user shape: timeoutMs === null. Before the fix this
    // await had no escape at all and parked for the life of the process.
    const exec = internals()
    exec.armExitSignal()

    const read = exec.raceRead(neverSettles(), null, '')
    exec.disarmExitSignal('CLI process exited (code=1 signal=null) while awaiting output')

    await assert.rejects(read, /CLI process exited/)
  })

  test('untimed_read_does_not_settle_while_process_lives', async () => {
    // The human-input wait must stay open while the process is alive — the fix
    // must not smuggle a wall-clock limit back onto human input.
    const exec = internals()
    exec.armExitSignal()

    const read = exec.raceRead(neverSettles(), null, '')
    assert.equal(
      await stillPending(read),
      true,
      'untimed read must remain pending while the process is alive'
    )

    exec.disarmExitSignal('cleanup')
    await read.catch(() => {})
  })

  test('timed_read_rejects_on_timeout', async () => {
    const exec = internals()
    exec.armExitSignal()
    await assert.rejects(
      exec.raceRead(neverSettles(), 20, 'CLI tool result timeout — boom'),
      /CLI tool result timeout/
    )
    exec.disarmExitSignal('cleanup')
  })

  test('exit_signal_beats_a_long_timeout', async () => {
    // A dead process must not make the user wait out the full 10-minute
    // tool-result timeout before the stream unwinds.
    const exec = internals()
    exec.armExitSignal()
    const read = exec.raceRead(neverSettles(), 600_000, 'tool timeout')
    exec.disarmExitSignal('CLI process exited (code=0 signal=null) while awaiting output')
    await assert.rejects(read, /CLI process exited/)
  })

  test('normal_read_resolves_and_is_unaffected', async () => {
    const exec = internals()
    exec.armExitSignal()
    const value = { type: 'result' }
    const result = await exec.raceRead(Promise.resolve({ done: false, value }), 5_000, 'nope')
    assert.equal(result.done, false)
    assert.deepEqual(result.value, value)
    exec.disarmExitSignal('cleanup')
  })

  test('rearming_settles_the_previous_signal', async () => {
    // A stale signal from a prior process must never reject a future turn.
    const exec = internals()
    exec.armExitSignal()
    const stale = exec.raceRead(neverSettles(), null, '')
    exec.armExitSignal() // new process spawned
    await assert.rejects(stale, /superseded by new process/)

    // The freshly armed signal is independent and still pending.
    const fresh = exec.raceRead(neverSettles(), null, '')
    assert.equal(await stillPending(fresh), true)
    exec.disarmExitSignal('cleanup')
    await fresh.catch(() => {})
  })

  test('unraced_exit_signal_does_not_throw_unhandled', async () => {
    // armExitSignal attaches a sink; without it a process that exits while no
    // read is in flight would surface an unhandled rejection in main.
    const exec = internals()
    exec.armExitSignal()
    exec.disarmExitSignal('exited with nobody listening')
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(true, 'no unhandled rejection surfaced')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Bug C — the wall clock must not run while a human is deciding
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A permission prompt is invoked out of band (--permission-prompt-tool over the
 * IPC bridge), never as a tool_use on the NDJSON stream. ToolTracker therefore
 * sees only the *gated* tool (Bash/Edit/Write) and the read sits on the 10-min
 * tool-result budget — which expired mid-deliberation and killed the turn.
 *
 * These tests use millisecond budgets: raceRead clamps its tick to the budget,
 * so a 30ms budget ticks every 30ms and a 300ms wait is ten expiries' worth.
 */
async function stillPendingAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(
      () => false,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms))
  ])
}

describe('CLIExecutor human-decision suspension', () => {
  test('budget does not burn while a permission decision is outstanding', async () => {
    const exec = internals()
    exec.armExitSignal()
    exec.beginHumanDecision('req-1')

    const read = exec.raceRead(neverSettles(), 30, 'tool timeout')
    assert.equal(
      await stillPendingAfter(read, 300),
      true,
      'a 30ms budget must survive 300ms while the user is deciding'
    )

    exec.disarmExitSignal('cleanup')
    await read.catch(() => {})
  })

  test('budget resumes once the decision is answered', async () => {
    const exec = internals()
    exec.armExitSignal()
    exec.beginHumanDecision('req-1')

    const read = exec.raceRead(neverSettles(), 20, 'tool timeout')
    assert.equal(await stillPendingAfter(read, 120), true, 'precondition: suspended')

    exec.endHumanDecision('req-1')
    await assert.rejects(read, /tool timeout/, 'the budget must resume, not be cancelled')
    exec.disarmExitSignal('cleanup')
  })

  test('a dead process still unwinds a suspended read', async () => {
    // The whole point of suspending rather than disabling: this must not
    // recreate the lost-tool-result deadlock the exit signal was added for.
    const exec = internals()
    exec.armExitSignal()
    exec.beginHumanDecision('req-1')

    const read = exec.raceRead(neverSettles(), 600_000, 'tool timeout')
    exec.disarmExitSignal('CLI process exited (code=null signal=SIGTERM) while awaiting output')
    await assert.rejects(read, /CLI process exited/)
  })

  test('clearHumanDecisions leaves no residue for the next turn', async () => {
    const exec = internals()
    exec.armExitSignal()
    exec.beginHumanDecision('req-1')
    exec.clearHumanDecisions('turn finalized')
    assert.equal(exec.hasHumanDecisionPending(), false)

    // A stale entry would have suspended this unrelated read forever.
    await assert.rejects(exec.raceRead(neverSettles(), 20, 'tool timeout'), /tool timeout/)
    exec.disarmExitSignal('cleanup')
  })

  test('begin is idempotent and end ignores unknown ids', async () => {
    const exec = internals()
    exec.beginHumanDecision('req-1')
    exec.beginHumanDecision('req-1')
    exec.endHumanDecision('req-unknown')
    assert.equal(exec.hasHumanDecisionPending(), true)

    // One end for one begin — a duplicated begin must not need two ends.
    exec.endHumanDecision('req-1')
    assert.equal(exec.hasHumanDecisionPending(), false)
  })

  test('abandoned decisions are announced so the UI can stop waiting', () => {
    // The renderer only ever learns an outcome from its own click, so a prompt
    // dropped at teardown must be reported or the card freezes on "waiting".
    const exec = internals()
    const seen: Array<{ ids: string[]; reason: string }> = []
    exec.onHumanDecisionsCleared = (ids, reason) => seen.push({ ids, reason })

    exec.beginHumanDecision('req-1')
    exec.beginHumanDecision('req-2')
    exec.clearHumanDecisions('turn finalized')

    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].ids.sort(), ['req-1', 'req-2'])
    assert.equal(seen[0].reason, 'turn finalized')
  })

  test('an answered decision is not announced as abandoned', () => {
    const exec = internals()
    const seen: string[][] = []
    exec.onHumanDecisionsCleared = (ids) => seen.push(ids)

    exec.beginHumanDecision('req-1')
    exec.endHumanDecision('req-1')
    exec.clearHumanDecisions('turn finalized')

    assert.equal(seen.length, 0, 'nothing outstanding — no notification')
  })

  test('a throwing listener cannot break teardown', () => {
    const exec = internals()
    exec.onHumanDecisionsCleared = () => {
      throw new Error('renderer gone')
    }
    exec.beginHumanDecision('req-1')
    exec.clearHumanDecisions('CLI process killed')
    assert.equal(exec.hasHumanDecisionPending(), false)
  })

  test('two concurrent prompts: the clock resumes only after the last one', async () => {
    const exec = internals()
    exec.armExitSignal()
    exec.beginHumanDecision('req-1')
    exec.beginHumanDecision('req-2')

    const read = exec.raceRead(neverSettles(), 20, 'tool timeout')
    exec.endHumanDecision('req-1')
    assert.equal(await stillPendingAfter(read, 120), true, 'req-2 still holds the clock')

    exec.endHumanDecision('req-2')
    await assert.rejects(read, /tool timeout/)
    exec.disarmExitSignal('cleanup')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Bug B — consolidated busy guard + recovery
// ══════════════════════════════════════════════════════════════════════════════

interface StreamSvcInternal {
  streamingLocks: Set<string>
  lockAcquiredAt: Map<string, number>
  activeRequestIds: Map<string, string>
  keepaliveTimers: Map<string, ReturnType<typeof setInterval>>
  safetyTimerResets: Map<string, () => void>
  mainWindow: { webContents: { send: () => void }; isDestroyed: () => boolean }
  safeWindowSend(channel: string, ...args: unknown[]): void
  describeBusy(conversationId: string): string | null
  isConversationBusy(conversationId: string): boolean
  releaseConversation(conversationId: string, reason: string, requestId?: string): boolean
  sweepOrphanedConversations(): string[]
}

/**
 * Bind the real prototype methods onto a minimal double — the constructor
 * registers live event listeners and starts the sweep timer, neither of which
 * belongs in a unit test.
 */
function createSvc(): StreamSvcInternal {
  const svc = {
    streamingLocks: new Set<string>(),
    lockAcquiredAt: new Map<string, number>(),
    activeRequestIds: new Map<string, string>(),
    keepaliveTimers: new Map(),
    safetyTimerResets: new Map(),
    mainWindow: { webContents: { send: () => {} }, isDestroyed: () => false }
  } as unknown as StreamSvcInternal

  const { ChatStreamService } = require('../chat-stream.service') as {
    ChatStreamService: new (...args: unknown[]) => unknown
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- test double binding
  const proto = ChatStreamService.prototype as Record<string, Function>
  svc.safeWindowSend = proto.safeWindowSend.bind(svc)
  svc.describeBusy = proto.describeBusy.bind(svc)
  svc.isConversationBusy = proto.isConversationBusy.bind(svc)
  svc.releaseConversation = proto.releaseConversation.bind(svc)
  svc.sweepOrphanedConversations = proto.sweepOrphanedConversations.bind(svc)
  return svc
}

/**
 * Conversation ids owned by this file. Cleanup is scoped to these rather than
 * using a global forceReset/abortAll: the suite runs many files in one process
 * and a global reset would tear down another file's in-flight fixtures.
 *
 * Scoped cleanup also means these tests need no cross-file mutex, so they can
 * stay synchronous — which matters, because the harness currently drops async
 * tests queued late in a large run (all 38 runExclusive tests in
 * chat-stream-lifecycle.test.ts report nothing under `npm run test:unit`).
 */
const OWNED_IDS = [
  'conv-free',
  'conv-wedged',
  'conv-lock',
  'conv-both',
  'conv-x',
  'conv-notify',
  'conv-orphan',
  'conv-young',
  'conv-old',
  'conv-live'
]

function resetOwned(): void {
  for (const id of OWNED_IDS) {
    lifecycleRegistry.get(id)?.abort('test-cleanup')
    conversationStateMachine.forceReset(id)
  }
}

describe('consolidated busy guard', () => {
  test('idle_conversation_is_not_busy', () => {
    resetOwned()
    const svc = createSvc()
    assert.equal(svc.describeBusy('conv-free'), null)
    assert.equal(svc.isConversationBusy('conv-free'), false)
  })

  test('state_machine_alone_counts_as_busy', () => {
    resetOwned()
    const svc = createSvc()
    // THE REGRESSION: lock released, state machine still streaming.
    conversationStateMachine.transition('sendMessage', 'conv-wedged')

    assert.equal(
      svc.streamingLocks.has('conv-wedged'),
      false,
      'precondition: the old watchdog predicate is false here'
    )
    assert.ok(
      svc.isConversationBusy('conv-wedged'),
      'a non-idle state machine must count as busy — this is what rejects the user'
    )
    assert.match(svc.describeBusy('conv-wedged') ?? '', /sm=chat-agent-streaming/)
    resetOwned()
  })

  test('lock_alone_counts_as_busy', () => {
    resetOwned()
    const svc = createSvc()
    svc.streamingLocks.add('conv-lock')
    assert.equal(svc.describeBusy('conv-lock'), 'lock')
  })

  test('describeBusy_reports_every_contributing_piece', () => {
    resetOwned()
    const svc = createSvc()
    svc.streamingLocks.add('conv-both')
    conversationStateMachine.transition('sendMessage', 'conv-both')
    const reasons = svc.describeBusy('conv-both') ?? ''
    assert.match(reasons, /lock/)
    assert.match(reasons, /sm=/)
    resetOwned()
  })
})

describe('releaseConversation', () => {
  test('clears_a_state_machine_only_wedge', () => {
    resetOwned()
    const svc = createSvc()
    conversationStateMachine.transition('sendMessage', 'conv-wedged')

    assert.equal(svc.releaseConversation('conv-wedged', 'user-force-release'), true)
    assert.equal(svc.isConversationBusy('conv-wedged'), false)
    assert.ok(conversationStateMachine.isIdle('conv-wedged'))
  })

  test('clears_lock_and_bookkeeping', () => {
    resetOwned()
    const svc = createSvc()
    svc.streamingLocks.add('conv-x')
    svc.activeRequestIds.set('conv-x', 'req-1')
    svc.lockAcquiredAt.set('conv-x', Date.now())

    assert.equal(svc.releaseConversation('conv-x', 'orphan-sweep'), true)
    assert.equal(svc.streamingLocks.has('conv-x'), false)
    assert.equal(svc.activeRequestIds.has('conv-x'), false)
    assert.equal(svc.lockAcquiredAt.has('conv-x'), false)
  })

  test('is_idempotent_on_a_free_conversation', () => {
    resetOwned()
    const svc = createSvc()
    assert.equal(svc.releaseConversation('conv-free', 'user-force-release'), false)
  })

  test('notifies_the_renderer_so_the_composer_re_enables', () => {
    resetOwned()
    const svc = createSvc()
    const sent: string[] = []
    svc.mainWindow.webContents.send = ((channel: string) => {
      sent.push(channel)
    }) as unknown as () => void

    conversationStateMachine.transition('sendMessage', 'conv-notify')
    svc.releaseConversation('conv-notify', 'user-force-release')

    assert.ok(
      sent.some((c) => c.toLowerCase().includes('complete')),
      `expected a completion event, got: ${sent.join(', ')}`
    )
  })
})

describe('orphan sweep', () => {
  // The sweep scans global state, so assertions check for the presence or
  // absence of THIS file's ids rather than exact array equality — another
  // test file's leftover conversation must not flip these results.
  test('releases_a_stale_state_machine_entry', () => {
    resetOwned()
    const svc = createSvc()
    // Busy in the state machine, no lifecycle behind it, and no recorded
    // acquire time — so the grace period does not apply.
    conversationStateMachine.transition('sendMessage', 'conv-orphan')

    assert.ok(svc.sweepOrphanedConversations().includes('conv-orphan'))
    assert.ok(conversationStateMachine.isIdle('conv-orphan'))
  })

  test('respects_the_grace_period_for_a_just_acquired_lock', () => {
    resetOwned()
    const svc = createSvc()
    svc.streamingLocks.add('conv-young')
    svc.lockAcquiredAt.set('conv-young', Date.now()) // just now

    assert.ok(!svc.sweepOrphanedConversations().includes('conv-young'))
    assert.ok(svc.streamingLocks.has('conv-young'), 'a fresh stream must survive the sweep')
    svc.streamingLocks.delete('conv-young')
  })

  test('sweeps_a_lock_older_than_the_grace_period', () => {
    resetOwned()
    const svc = createSvc()
    svc.streamingLocks.add('conv-old')
    svc.lockAcquiredAt.set('conv-old', Date.now() - 10 * 60_000)

    assert.ok(svc.sweepOrphanedConversations().includes('conv-old'))
  })

  test('leaves_a_live_stream_alone', () => {
    resetOwned()
    const svc = createSvc()
    const lc = lifecycleRegistry.begin('conv-live')
    conversationStateMachine.transition('sendMessage', 'conv-live')
    svc.streamingLocks.add('conv-live')
    svc.lockAcquiredAt.set('conv-live', Date.now() - 10 * 60_000)

    assert.ok(
      !svc.sweepOrphanedConversations().includes('conv-live'),
      'an active lifecycle means a real stream is running — never sweep it'
    )
    assert.ok(svc.streamingLocks.has('conv-live'))
    lc.abort('test-cleanup')
    resetOwned()
  })

  test('is_a_no_op_when_nothing_is_busy', () => {
    resetOwned()
    const svc = createSvc()
    const released = svc.sweepOrphanedConversations()
    for (const id of OWNED_IDS) {
      assert.ok(!released.includes(id), `${id} should not be swept when nothing is busy`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

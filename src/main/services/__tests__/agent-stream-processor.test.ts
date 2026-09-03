/**
 * Unit tests for agent-stream-processor.ts — stream chunk processing,
 * compaction band classification, and threshold resolution.
 *
 * AgentStreamProcessor takes its session host as `unknown` and casts it, so a
 * lightweight mock host (with spied emit/log) drives the testable surfaces:
 *  - checkCompaction band classification + debounce state mutation.
 *  - resolveCompactionThresholds delegation to compaction-policy.
 *  - processContentChunk DB-free branches: text accumulation, control-tool skip,
 *    budget-cap break, unexpected-abort break, session-recovery detection.
 *
 * processMetaChunk and the tool_use circuit-breaker path are intentionally not
 * unit-tested here (token-tracker + DB + circuit-breaker coupling — better as
 * integration tests).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './test-harness'
import { AgentStreamProcessor } from '../agent-stream-processor'
import { AgentCircuitBreaker } from '../agent-circuit-breaker'
import { MCP_TOOLS } from '../../../shared/constants'

interface MockHost {
  emit: ReturnType<typeof createSpy>
  log: { info: () => void; warn: () => void; debug: () => void; error: () => void }
  compactAutoThreshold: number
  compactSuggestThreshold: number
  llmProvider: string
  compactSuggested: boolean
  turnsSinceCompactSuggestion: number
  accumulatedText: string
  currentStatus: string
  getStatus: () => Record<string, unknown>
  clearSession: ReturnType<typeof createSpy>
}

function makeHost(over: Partial<MockHost> = {}): MockHost {
  const noop = (): void => {}
  return {
    emit: createSpy(),
    log: { info: noop, warn: noop, debug: noop, error: noop },
    compactAutoThreshold: 800,
    compactSuggestThreshold: 500,
    llmProvider: 'claude',
    compactSuggested: false,
    turnsSinceCompactSuggestion: 0,
    accumulatedText: '',
    currentStatus: 'writing',
    getStatus: () => ({ status: 'writing' }),
    clearSession: createSpy(),
    ...over
  }
}

function lastCompactNeeded(host: MockHost): Record<string, unknown> | undefined {
  const call = [...host.emit.calls].reverse().find((c) => c[0] === 'compactNeeded')
  return call?.[1] as Record<string, unknown> | undefined
}

describe('AgentStreamProcessor.checkCompaction', () => {
  test('no event below the warning band (resets debounce)', () => {
    const host = makeHost({ compactSuggested: true, turnsSinceCompactSuggestion: 2 })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(100) // warning starts at 0.8*500=400
    assert.equal(
      host.emit.calls.some((c) => c[0] === 'compactNeeded'),
      false
    )
    assert.equal(host.compactSuggested, false)
    assert.equal(host.turnsSinceCompactSuggestion, 0)
  })

  test('warning band emits warning with estimatedNextCost', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(450) // [400,500) → warning
    const payload = lastCompactNeeded(host)
    assert.equal(payload?.level, 'warning')
    assert.equal(payload?.estimatedNextCost, Math.round(450 * 0.05))
  })

  test('suggest band emits suggest and sets debounce state', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(600) // [500,800) → suggest
    assert.equal(lastCompactNeeded(host)?.level, 'suggest')
    assert.equal(host.compactSuggested, true)
    assert.equal(host.turnsSinceCompactSuggestion, 0)
  })

  test('critical band when auto-compact disabled', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(900) // >= autoThreshold 800
    assert.equal(lastCompactNeeded(host)?.level, 'critical')
  })

  test('auto-compact-pending when auto-compact enabled', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(900, { isAutoCompactEnabled: true } as never)
    assert.equal(lastCompactNeeded(host)?.level, 'auto-compact-pending')
  })

  test('local provider flag is forwarded in the payload', () => {
    const host = makeHost({ llmProvider: 'local-llm' })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(600)
    assert.equal(lastCompactNeeded(host)?.isLocalProvider, true)
  })
})

describe('AgentStreamProcessor.resolveCompactionThresholds', () => {
  test('delegates to the policy (≤200K window → 0.6/0.75)', () => {
    const proc = new AgentStreamProcessor(makeHost())
    assert.deepEqual(proc.resolveCompactionThresholds(200_000), { suggest: 120_000, auto: 150_000 })
  })

  test('1M window uses the same 0.6/0.75 ratios', () => {
    const proc = new AgentStreamProcessor(makeHost())
    assert.deepEqual(proc.resolveCompactionThresholds(1_000_000), {
      suggest: 600_000,
      auto: 750_000
    })
  })
})

describe('AgentStreamProcessor.processContentChunk', () => {
  const ctx = { conversationId: 'c1', isBuildMode: true, streamState: {} as never }

  test('text chunk accumulates and returns next', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk({ type: 'text', content: 'hello' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.equal(r, 'next')
    assert.equal(host.accumulatedText, 'hello')
  })

  test('control-action tool_use returns continue (skips accumulation)', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk(
      { type: 'tool_use', toolName: MCP_TOOLS.CONTROL_ACTIONS._PREFIX + 'emit_plan' } as never,
      { ...ctx, streamState: {} as never }
    )
    assert.equal(r, 'continue')
  })

  test('budget-cap error breaks and emits budgetCapReached', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk(
      { type: 'error', error: 'budget cap exceeded for session' } as never,
      { ...ctx, streamState: {} as never }
    )
    assert.equal(r, 'break')
    assert.ok(host.emit.calls.some((c) => c[0] === 'budgetCapReached'))
  })

  test('unexpected abort (status not idle) breaks with a friendly error', () => {
    const host = makeHost({ currentStatus: 'writing' })
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk(
      { type: 'error', error: 'Claude Code process aborted by user' } as never,
      { ...ctx, streamState: {} as never }
    )
    assert.equal(r, 'break')
  })

  test('stale-session error triggers recovery (break + flag + clearSession)', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { sessionRecoveryNeeded?: boolean }
    const r = proc.processContentChunk(
      { type: 'error', error: 'No conversation found with session ID abc' } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(r, 'break')
    assert.equal(streamState.sessionRecoveryNeeded, true)
    assert.equal(host.clearSession.callCount, 1)
  })
})

// ── Expanded coverage (Round 4) ──

describe('AgentStreamProcessor.processContentChunk — plan-mode tool block detection', () => {
  const ctx = { conversationId: 'c2', isBuildMode: false, streamState: {} as never }

  test('tool_result with Write block in plan mode sets planModeToolBlock', () => {
    const host = makeHost()
    ;(host as any).currentMode = 'plan'
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { planModeToolBlock?: boolean }
    const r = proc.processContentChunk(
      {
        type: 'tool_result',
        toolName: 'Write',
        content: '<tool_use_error>No such tool available: Write</tool_use_error>'
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(r, 'next')
    assert.equal(streamState.planModeToolBlock, true)
  })

  test('tool_result without Write/Edit does NOT set planModeToolBlock', () => {
    const host = makeHost()
    ;(host as any).currentMode = 'plan'
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { planModeToolBlock?: boolean }
    proc.processContentChunk(
      {
        type: 'tool_result',
        toolName: 'Read',
        content: '<tool_use_error>No such tool available: Read</tool_use_error>'
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.planModeToolBlock, undefined)
  })

  // Regression: the CLI's native plan-mode prompt tells the model to finish with
  // ExitPlanMode, which mode-permissions disallows. The old /\b(Write|Edit|MultiEdit)\b/
  // regex could never match it, so recovery never fired and the user got no plan card.
  test('tool_result with ExitPlanMode block in plan mode sets planModeToolBlock', () => {
    const host = makeHost()
    ;(host as any).currentMode = 'plan'
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { planModeToolBlock?: boolean; planModeBlockedTool?: string }
    const r = proc.processContentChunk(
      {
        type: 'tool_result',
        toolName: 'ExitPlanMode',
        content: '<tool_use_error>No such tool available: ExitPlanMode</tool_use_error>'
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(r, 'next')
    assert.equal(streamState.planModeToolBlock, true)
    assert.equal(streamState.planModeBlockedTool, 'ExitPlanMode')
  })

  test('ExitPlanMode block without <tool_use_error> wrapper still sets planModeToolBlock', () => {
    const host = makeHost()
    ;(host as any).currentMode = 'plan'
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { planModeToolBlock?: boolean; planModeBlockedTool?: string }
    proc.processContentChunk(
      {
        type: 'tool_result',
        toolName: 'ExitPlanMode',
        content: 'No such tool available: ExitPlanMode'
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.planModeToolBlock, true)
    assert.equal(streamState.planModeBlockedTool, 'ExitPlanMode')
  })

  test('ExitPlanMode block in build mode does NOT set planModeToolBlock', () => {
    const host = makeHost()
    ;(host as any).currentMode = 'build'
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { planModeToolBlock?: boolean; planModeBlockedTool?: string }
    proc.processContentChunk(
      {
        type: 'tool_result',
        toolName: 'ExitPlanMode',
        content: '<tool_use_error>No such tool available: ExitPlanMode</tool_use_error>'
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.planModeToolBlock, undefined)
    assert.equal(streamState.planModeBlockedTool, undefined)
  })
})

describe('AgentStreamProcessor.checkCompaction — decision.level undefined', () => {
  test('no event emitted when below all thresholds', () => {
    const host = makeHost({ compactSuggestThreshold: 1000, compactAutoThreshold: 2000 })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(10) // way below warning band
    const hasCompactNeeded = host.emit.calls.some((c) => c[0] === 'compactNeeded')
    assert.equal(hasCompactNeeded, false)
  })
})

describe('AgentStreamProcessor.processContentChunk — text accumulation', () => {
  const ctx = { conversationId: 'c3', isBuildMode: true, streamState: {} as never }

  test('text chunk sets hasTextAfterLastTool flag', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = { hasTextAfterLastTool: false } as { hasTextAfterLastTool: boolean }
    proc.processContentChunk({ type: 'text', content: 'some text' } as never, {
      ...ctx,
      streamState: streamState as never
    })
    assert.equal(streamState.hasTextAfterLastTool, true)
  })

  test('text chunk with empty content still returns next', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk({ type: 'text', content: '' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.equal(r, 'next')
  })
})

describe('AgentStreamProcessor.processContentChunk — status updates', () => {
  const ctx = { conversationId: 'c4', isBuildMode: true, streamState: {} as never }

  test('text chunk sets currentStatus to writing', () => {
    const host = makeHost({ currentStatus: 'idle' })
    const proc = new AgentStreamProcessor(host)
    proc.processContentChunk({ type: 'text', content: 'hi' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.equal(host.currentStatus, 'writing')
  })
})

// ── resolveCompactionThresholds: additional window sizes ──

describe('AgentStreamProcessor.resolveCompactionThresholds — window sizes', () => {
  test('128K window', () => {
    const proc = new AgentStreamProcessor(makeHost())
    const result = proc.resolveCompactionThresholds(128_000)
    assert.equal(result.suggest, 128_000 * 0.6)
    assert.equal(result.auto, 128_000 * 0.75)
  })

  test('64K window (small)', () => {
    const proc = new AgentStreamProcessor(makeHost())
    const result = proc.resolveCompactionThresholds(64_000)
    assert.equal(result.suggest, 64_000 * 0.6)
    assert.equal(result.auto, 64_000 * 0.75)
  })

  test('500K window (mid-range) uses the same uniform ratios', () => {
    const proc = new AgentStreamProcessor(makeHost())
    const result = proc.resolveCompactionThresholds(500_000)
    // Ratios are window-size independent — no tiering, no interpolation.
    assert.equal(result.suggest, 500_000 * 0.6)
    assert.equal(result.auto, 500_000 * 0.75)
  })

  test('0 window → both thresholds are 0', () => {
    const proc = new AgentStreamProcessor(makeHost())
    const result = proc.resolveCompactionThresholds(0)
    assert.equal(result.suggest, 0)
    assert.equal(result.auto, 0)
  })
})

// ── checkCompaction: debounce behavior ──

describe('AgentStreamProcessor.checkCompaction — debounce behavior', () => {
  test('suggest band sets compactSuggested and resets turnsSinceCompactSuggestion', () => {
    const host = makeHost({ turnsSinceCompactSuggestion: 5 })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(600) // suggest band
    assert.equal(host.compactSuggested, true)
    assert.equal(host.turnsSinceCompactSuggestion, 0)
  })

  test('below warning band resets compactSuggested to false', () => {
    const host = makeHost({ compactSuggested: true, turnsSinceCompactSuggestion: 3 })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(10) // well below threshold
    assert.equal(host.compactSuggested, false)
    assert.equal(host.turnsSinceCompactSuggestion, 0)
  })

  test('warning band does NOT change compactSuggested flag', () => {
    const host = makeHost({ compactSuggested: false })
    const proc = new AgentStreamProcessor(host)
    proc.checkCompaction(450) // warning band
    // compactSuggested should remain false (not promoted to suggest)
    assert.equal(host.compactSuggested, false)
  })
})

// ── processContentChunk: api_retry overload detection ──

describe('AgentStreamProcessor.processContentChunk — api_retry', () => {
  const ctx = { conversationId: 'c6', isBuildMode: true, streamState: {} as never }

  test('api_retry with 529 status sets overloadDetected', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = { overloadDetected: false } as { overloadDetected: boolean }
    proc.processContentChunk(
      { type: 'api_retry', content: 'retrying', retryInfo: { errorStatus: 529 } } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.overloadDetected, true)
  })

  test('api_retry with 503 status sets overloadDetected', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = { overloadDetected: false } as { overloadDetected: boolean }
    proc.processContentChunk(
      { type: 'api_retry', content: 'retrying', retryInfo: { errorStatus: 503 } } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.overloadDetected, true)
  })

  test('api_retry with overloaded content sets overloadDetected', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = { overloadDetected: false } as { overloadDetected: boolean }
    proc.processContentChunk(
      {
        type: 'api_retry',
        content: 'server_is_overloaded',
        retryInfo: { errorStatus: null }
      } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.overloadDetected, true)
  })

  test('api_retry with 200 status does NOT set overloadDetected', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = { overloadDetected: false } as { overloadDetected: boolean }
    proc.processContentChunk(
      { type: 'api_retry', content: 'retrying request', retryInfo: { errorStatus: 200 } } as never,
      { ...ctx, streamState: streamState as never }
    )
    assert.equal(streamState.overloadDetected, false)
  })
})

// ── Turn-scoped text measurement for the gratuitous-tool heuristic ──
//
// Regression: accumulatedText is per-MESSAGE and survives auto-continuations,
// but the circuit breaker's gratuitous heuristic is per-TURN (_toolCallCount === 1).
// continueTurnLimit rebases accumulatedTextBaseline so the continuation's first
// tool call isn't judged against the pre-break turn's wrap-up text.
describe('AgentStreamProcessor.processContentChunk — tool_use text measurement', () => {
  function makeToolUseHost(streamCtx: {
    accumulatedText: string
    accumulatedTextBaseline?: number
  }): { host: MockHost; seen: number[] } {
    const seen: number[] = []
    const host = makeHost()
    ;(host as any).activeStreams = new Map([['c-tool', { ...streamCtx, abortController: null }]])
    ;(host as any).toolActivityAccumulator = { record: (): void => {} }
    ;(host as any).circuitBreaker = {
      count: 1,
      onToolUse: (o: { accumulatedTextLength: number }) => {
        seen.push(o.accumulatedTextLength)
        return { broken: false, shouldTerminate: false }
      },
      logToolCall: (): void => {}
    }
    return { host, seen }
  }

  const ctx = { conversationId: 'c-tool', isBuildMode: true, streamState: {} as never }

  test('baseline equal to text length reports 0 to the breaker (continuation)', () => {
    const { host, seen } = makeToolUseHost({
      accumulatedText: 'x'.repeat(1699),
      accumulatedTextBaseline: 1699
    })
    const proc = new AgentStreamProcessor(host)
    const r = proc.processContentChunk({ type: 'tool_use', toolName: 'Read' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.equal(r, 'next')
    assert.deepEqual(seen, [0])
  })

  test('baseline 0 reports the full length (normal turn — unchanged)', () => {
    const { host, seen } = makeToolUseHost({
      accumulatedText: 'x'.repeat(1699),
      accumulatedTextBaseline: 0
    })
    const proc = new AgentStreamProcessor(host)
    proc.processContentChunk({ type: 'tool_use', toolName: 'Read' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.deepEqual(seen, [1699])
  })

  test('missing baseline falls back to the full length', () => {
    const { host, seen } = makeToolUseHost({ accumulatedText: 'x'.repeat(600) })
    const proc = new AgentStreamProcessor(host)
    proc.processContentChunk({ type: 'tool_use', toolName: 'Read' } as never, {
      ...ctx,
      streamState: {} as never
    })
    assert.deepEqual(seen, [600])
  })
})

// ── The 80% tool budget is a log breadcrumb, not a chat message ──
//
// Regression: the breaker used to return an `additionalContext` nudge at 80%,
// and this processor rendered it into the transcript as `> ⚠️ You've used
// 120/150 tool calls…`. It was addressed to the model but only ever reached the
// human. The budget crossing must now be completely silent to the renderer.
describe('AgentStreamProcessor.processContentChunk — 80% tool budget is silent', () => {
  test('crossing the 80% budget emits no chunk', () => {
    const host = makeHost()
    ;(host as any).activeStreams = new Map([
      ['c-budget', { accumulatedText: '', accumulatedTextBaseline: 0, abortController: null }]
    ])
    ;(host as any).toolActivityAccumulator = { record: (): void => {} }
    const breaker = new AgentCircuitBreaker()
    // Real 80%/limit logic, minus the event-log DB write per tool call.
    breaker.logToolCall = (): void => {}
    ;(host as any).circuitBreaker = breaker

    const proc = new AgentStreamProcessor(host)
    // Build limit is 400, so the breadcrumb fires on call 320 — well short of a break.
    for (let i = 0; i < 320; i++) {
      const r = proc.processContentChunk({ type: 'tool_use', toolName: 'Read' } as never, {
        conversationId: 'c-budget',
        isBuildMode: true,
        streamState: {} as never
      })
      assert.equal(r, 'next', `call ${i + 1} should not break`)
    }

    assert.equal(breaker.count, 320)
    assert.equal(breaker.isBroken, false)

    // Every tool_use chunk is forwarded verbatim; the regression is the SYNTHETIC
    // text chunk the processor used to inject on top of one of them.
    const emitted = host.emit.calls
      .filter((c) => c[0] === 'chunk')
      .map((c) => c[1] as { type?: string; content?: string })
    assert.equal(emitted.length, 320, 'each tool_use is still forwarded once')
    assert.equal(
      emitted.filter((c) => c.type === 'text').length,
      0,
      'the 80% budget crossing must not inject a text chunk into the transcript'
    )
    assert.equal(
      emitted.filter((c) => c.content?.includes("You've used")).length,
      0,
      'the tool-budget nudge must not surface in the transcript'
    )
  })
})

// ── processMetaChunk attribution derivation ───────────────────────────
//
// This is the seam the repository and token-tracker tests cannot reach: they
// call recordTurn with provider/blueprintId/taskId/attempt already populated,
// so nothing pinned the code that DERIVES them. Deleting the four attribution
// lines below the recordTurn call, or the streamState.llmProvider plumbing,
// used to leave every other test green while all four columns went NULL.
//
// The token tracker is stubbed, so no DB write happens; resolveModelFromSnapshot
// still reads, hence the test DB.
describe('AgentStreamProcessor.processMetaChunk — usage attribution', () => {
  let dbAvailable = false
  let createTestDb: typeof import('../../db/test-helpers').createTestDb
  let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
  try {
    createTestDb = require('../../db/test-helpers').createTestDb
    _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
    const probe = createTestDb()
    probe.close()
    dbAvailable = true
  } catch {
    dbAvailable = false
  }

  interface RecordedOpts {
    provider?: string | null
    blueprintId?: string | null
    taskId?: string | null
    attempt?: number | null
    feature?: string
  }

  /** Host wired just far enough for processMetaChunk, with a capturing tracker. */
  function makeMetaHost(over: {
    adapterRole?: string
    telemetryContext?: unknown
    streamLlmProvider?: string
    sessionLlmProvider?: string
  }): { host: Record<string, unknown>; recorded: RecordedOpts[] } {
    const noop = (): void => {}
    const recorded: RecordedOpts[] = []
    const host = {
      emit: createSpy(),
      log: { info: noop, warn: noop, debug: noop, error: noop },
      sessionMap: new Map<string, string>(),
      adapter: {
        role: over.adapterRole ?? 'blueprint-build',
        agentId: 'blueprint-build-bp-1',
        telemetryContext: over.telemetryContext
      },
      currentMode: 'build',
      workspacePath: '/test/workspace',
      workspaceId: 'ws-1',
      dbSessionId: 'sess-1',
      llmProvider: over.sessionLlmProvider ?? 'claude',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      lastContextTokens: 0,
      effectiveContextWindow: 200_000,
      compactAutoThreshold: 800_000,
      compactSuggestThreshold: 500_000,
      compactSuggested: false,
      turnsSinceCompactSuggestion: 0,
      resolveLocalContextWindow: () => 64_000,
      tokenTracker: {
        recordTurn: (_meta: unknown, opts: RecordedOpts) => {
          recorded.push(opts)
          // turnRecorded:false keeps the context back-fill (and its DB write)
          // out of this test — that path has its own coverage.
          return { totalTokens: 1500, turnRecorded: false }
        },
        getCacheEfficiency: () => ({
          hitRate: 0,
          savedTokens: 0,
          totalInput: 0,
          turns: 0,
          turnBreakdown: []
        })
      }
    }
    return { host, recorded }
  }

  const meta = {
    tokenUsage: {
      input: 1000,
      output: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 120_000
    }
  }

  const streamState = (): Record<string, unknown> => ({
    messageStopReceived: false,
    hasTextAfterLastTool: true,
    lastTerminalReason: undefined,
    sessionRecoveryNeeded: false,
    overloadDetected: false
  })

  test(
    'blueprint task identity reaches recordTurn from the adapter',
    async () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { host, recorded } = makeMetaHost({
        telemetryContext: { blueprintId: 'bp-1', taskId: 'T3', attempt: 2 }
      })
      const proc = new AgentStreamProcessor(host)
      await proc.processMetaChunk(meta as never, {
        conversationId: 'conv-1',
        turnCount: 1,
        streamState: { ...streamState(), llmProvider: 'claude' } as never
      })

      assert.equal(recorded.length, 1)
      assert.equal(recorded[0].blueprintId, 'bp-1')
      assert.equal(recorded[0].taskId, 'T3')
      assert.equal(recorded[0].attempt, 2)
      assert.equal(recorded[0].feature, 'blueprint-build')
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'provider comes from the stream, and local-llm stays distinct from glm',
    async () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())

      // The whole point of storing the provider rather than the executor
      // backend: both of these resolve to the 'opencode' backend, and merging
      // them would bill a free local run at GLM prices.
      for (const provider of ['claude', 'local-llm', 'glm']) {
        const { host, recorded } = makeMetaHost({ telemetryContext: undefined })
        const proc = new AgentStreamProcessor(host)
        await proc.processMetaChunk(meta as never, {
          conversationId: 'conv-1',
          turnCount: 1,
          streamState: { ...streamState(), llmProvider: provider } as never
        })
        assert.equal(recorded[0].provider, provider)
      }
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'falls back to the session provider when the stream did not record one',
    async () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { host, recorded } = makeMetaHost({ sessionLlmProvider: 'glm' })
      const proc = new AgentStreamProcessor(host)
      await proc.processMetaChunk(meta as never, {
        conversationId: 'conv-1',
        turnCount: 1,
        streamState: streamState() as never // no llmProvider
      })
      assert.equal(recorded[0].provider, 'glm')
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'a non-blueprint adapter records no blueprint attribution',
    async () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { host, recorded } = makeMetaHost({
        adapterRole: 'specialist',
        telemetryContext: undefined
      })
      const proc = new AgentStreamProcessor(host)
      await proc.processMetaChunk(meta as never, {
        conversationId: 'conv-1',
        turnCount: 1,
        streamState: { ...streamState(), llmProvider: 'claude' } as never
      })

      assert.equal(recorded[0].feature, 'chat')
      assert.equal(recorded[0].blueprintId, null)
      assert.equal(recorded[0].taskId, null)
      assert.equal(recorded[0].attempt, null)
      assert.equal(recorded[0].provider, 'claude', 'provider is recorded for every feature')
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  // prefix_tokens is NOT written here — `record()` writes it at INSERT time from
  // the same meta chunk, so its coverage lives in agent-token-tracker.test.ts,
  // next to the write. Noted because this is the obvious place to look for it.
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

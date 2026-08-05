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

  test('1M window uses the later 0.7/0.85 ratios', () => {
    const proc = new AgentStreamProcessor(makeHost())
    assert.deepEqual(proc.resolveCompactionThresholds(1_000_000), {
      suggest: 700_000,
      auto: 850_000
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

  test('500K window (mid-range: transitions between ≤200K and 1M)', () => {
    const proc = new AgentStreamProcessor(makeHost())
    const result = proc.resolveCompactionThresholds(500_000)
    // Between the two tiers, the policy interpolates
    assert.ok(result.suggest > 0)
    assert.ok(result.auto > result.suggest)
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

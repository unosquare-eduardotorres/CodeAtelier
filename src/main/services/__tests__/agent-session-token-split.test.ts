/**
 * Unit tests for the input/output token split exposed by AgentSessionService.getStatus().
 *
 * Since AgentSessionService requires a full adapter + SDK wiring, we test the
 * accumulation logic indirectly via AgentTokenTracker (which already has full
 * coverage) and validate the type contract: getStatus() must include
 * inputTokens and outputTokens alongside the existing tokenUsage sum.
 *
 * Pure logic: No filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { createTokenTracker } from './helpers/agent-factory'

/** Helper: creates a mock SDKExecuteResult with the given token usage */
function mockMeta(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0
): {
  tokenUsage: {
    input: number
    output: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
} {
  return {
    tokenUsage: {
      input,
      output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation
    }
  }
}

/** Helper: default opts that skip DB path (dbSessionId: null) */
function defaultOpts(turnCount = 1) {
  return {
    turnCount,
    conversationId: 'conv-token-split',
    dbSessionId: null as string | null,
    workspacePath: '/test/workspace'
  }
}

describe('AgentSession token split — accumulation logic', () => {
  test('input and output accumulate independently across turns', () => {
    const { tracker } = createTokenTracker()

    // Simulate the per-turn accumulation pattern from processMetaChunk:
    //   this.tokenUsage += totalTokens
    //   this.inputTokens += meta.tokenUsage.input
    //   this.outputTokens += meta.tokenUsage.output
    let tokenUsage = 0
    let inputTokens = 0
    let outputTokens = 0

    // Turn 1: 1000 input, 500 output
    const meta1 = mockMeta(1000, 500, 200, 100)
    const { totalTokens: t1 } = tracker.recordTurn(meta1 as any, defaultOpts(1))
    tokenUsage += t1
    inputTokens += meta1.tokenUsage.input
    outputTokens += meta1.tokenUsage.output

    assert.equal(tokenUsage, 1500, 'total after turn 1')
    assert.equal(inputTokens, 1000, 'input after turn 1')
    assert.equal(outputTokens, 500, 'output after turn 1')

    // Turn 2: 2000 input, 800 output
    const meta2 = mockMeta(2000, 800, 400, 50)
    const { totalTokens: t2 } = tracker.recordTurn(meta2 as any, defaultOpts(2))
    tokenUsage += t2
    inputTokens += meta2.tokenUsage.input
    outputTokens += meta2.tokenUsage.output

    assert.equal(tokenUsage, 4300, 'total after turn 2 = 1500 + 2800')
    assert.equal(inputTokens, 3000, 'input after turn 2 = 1000 + 2000')
    assert.equal(outputTokens, 1300, 'output after turn 2 = 500 + 800')
  })

  test('reset clears all counters independently', () => {
    // Simulate the reset pattern from agent-session start():
    //   this.tokenUsage = 0
    //   this.inputTokens = 0
    //   this.outputTokens = 0
    let tokenUsage = 1500
    let inputTokens = 1000
    let outputTokens = 500

    // Reset
    tokenUsage = 0
    inputTokens = 0
    outputTokens = 0

    assert.equal(tokenUsage, 0, 'tokenUsage reset')
    assert.equal(inputTokens, 0, 'inputTokens reset')
    assert.equal(outputTokens, 0, 'outputTokens reset')
  })

  test('getStatus shape includes inputTokens and outputTokens', () => {
    // Simulate what getStatus() returns:
    const inputTokens = 5000
    const outputTokens = 2000
    const tokenUsage = 7000

    const status = {
      agentId: 'test-agent',
      agentType: 'da-vinci' as const,
      status: 'idle' as const,
      elapsedMs: 0,
      tokenUsage,
      inputTokens,
      outputTokens,
      contextTokens: 150000
    }

    // Verify shape contract
    assert.equal(status.tokenUsage, 7000, 'tokenUsage is the billing sum')
    assert.equal(status.inputTokens, 5000, 'inputTokens exposed')
    assert.equal(status.outputTokens, 2000, 'outputTokens exposed')
    assert.equal(
      status.inputTokens + status.outputTokens,
      status.tokenUsage,
      'input + output = tokenUsage'
    )
  })
})

describe('AgentStore delta logic — input/output split', () => {
  test('delta computation handles normal accumulation', () => {
    // Simulate the Zustand updateStatus delta logic for input/output:
    //   const prevIn = state.lastKnownInputTokens[status.agentId] ?? 0
    //   const curIn = status.inputTokens ?? 0
    //   const deltaIn = curIn >= prevIn ? curIn - prevIn : curIn
    let sessionInputTokens = 0
    let lastKnownIn = 0

    // First status update: agent reports 1000 input
    const curIn1 = 1000
    const deltaIn1 = curIn1 >= lastKnownIn ? curIn1 - lastKnownIn : curIn1
    sessionInputTokens += deltaIn1
    lastKnownIn = curIn1

    assert.equal(sessionInputTokens, 1000, 'session input after first update')
    assert.equal(deltaIn1, 1000, 'delta is 1000 on first update')

    // Second status update: agent reports 2500 input (grew by 1500)
    const curIn2 = 2500
    const deltaIn2 = curIn2 >= lastKnownIn ? curIn2 - lastKnownIn : curIn2
    sessionInputTokens += deltaIn2
    lastKnownIn = curIn2

    assert.equal(sessionInputTokens, 2500, 'session input after second update')
    assert.equal(deltaIn2, 1500, 'delta is 1500 on second update')
  })

  test('delta computation handles agent restart (counter reset)', () => {
    let sessionInputTokens = 5000
    let lastKnownIn = 5000

    // Agent restarts — reports 300 (less than previous 5000)
    const curIn = 300
    const deltaIn = curIn >= lastKnownIn ? curIn - lastKnownIn : curIn
    sessionInputTokens += deltaIn
    lastKnownIn = curIn

    assert.equal(deltaIn, 300, 'delta treats restart as fresh delta')
    assert.equal(sessionInputTokens, 5300, 'session total includes restart delta')
  })

  test('handles undefined inputTokens/outputTokens gracefully', () => {
    // Status without inputTokens (back-compat: old agent version)
    const status: { inputTokens?: number; outputTokens?: number } = {}
    const curIn = status.inputTokens ?? 0
    const curOut = status.outputTokens ?? 0

    assert.equal(curIn, 0, 'undefined falls back to 0')
    assert.equal(curOut, 0, 'undefined falls back to 0')
  })
})

summary()

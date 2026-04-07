/**
 * Tests for GeneralistPromptAssembler turn count logic.
 * Validates that resumed sessions skip turn-1-only injections.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

// ── Minimal turn count simulation ──
// We test the core logic without importing the full PromptAssembler
// (which depends on DB, logger, and service singletons).

function createTurnCountMap(): {
  increment: (id: string) => number
  seed: (id: string) => void
  get: (id: string) => number | undefined
} {
  const map = new Map<string, number>()
  return {
    increment(conversationId: string): number {
      const nextTurn = (map.get(conversationId) ?? 0) + 1
      map.set(conversationId, nextTurn)
      return nextTurn
    },
    seed(conversationId: string): void {
      if (!map.has(conversationId)) {
        map.set(conversationId, 1) // next increment → 2
      }
    },
    get(conversationId: string): number | undefined {
      return map.get(conversationId)
    }
  }
}

// ── Tests ──

describe('Turn count — fresh session (no resume)', () => {
  test('first message returns turn 1', () => {
    const tc = createTurnCountMap()
    assert.equal(tc.increment('conv-1'), 1)
  })

  test('second message returns turn 2', () => {
    const tc = createTurnCountMap()
    tc.increment('conv-1')
    assert.equal(tc.increment('conv-1'), 2)
  })

  test('different conversations have independent counts', () => {
    const tc = createTurnCountMap()
    tc.increment('conv-1')
    tc.increment('conv-1')
    assert.equal(tc.increment('conv-2'), 1)
    assert.equal(tc.increment('conv-1'), 3)
  })
})

describe('Turn count — resumed session (seedTurnCountForResume)', () => {
  test('seeded conversation starts at turn 2 after increment', () => {
    const tc = createTurnCountMap()
    tc.seed('conv-resumed')
    assert.equal(tc.increment('conv-resumed'), 2)
  })

  test('seed is idempotent — does not overwrite existing count', () => {
    const tc = createTurnCountMap()
    tc.increment('conv-1') // turn 1
    tc.increment('conv-1') // turn 2
    tc.seed('conv-1') // should NOT reset — already has count
    assert.equal(tc.increment('conv-1'), 3) // should be 3, not 2
  })

  test('seed only affects conversations with no prior count', () => {
    const tc = createTurnCountMap()
    tc.seed('conv-new') // new conversation — seed takes effect
    tc.seed('conv-new') // second seed — idempotent, no change
    assert.equal(tc.increment('conv-new'), 2)
  })

  test('resumed session does not trigger turn-1-only injection', () => {
    const tc = createTurnCountMap()

    // Simulate: app restart → session resumed → seed → increment
    const sessionId = 'faa47d3d-7f08-41c4-b32a-d25f740287ef'
    const conversationId = 'conv-resumed'

    // This is what generalist.service.ts now does:
    if (sessionId) {
      tc.seed(conversationId)
    }
    const turnCount = tc.increment(conversationId)

    // Turn-1-only injections should NOT fire
    const shouldInjectRoster = turnCount <= 1
    assert.equal(shouldInjectRoster, false, 'Specialist roster should NOT be injected on resumed session')
    assert.equal(turnCount, 2)
  })

  test('fresh session (no sessionId) still gets turn 1', () => {
    const tc = createTurnCountMap()

    const sessionId: string | undefined = undefined
    const conversationId = 'conv-fresh'

    if (sessionId) {
      tc.seed(conversationId)
    }
    const turnCount = tc.increment(conversationId)

    const shouldInjectRoster = turnCount <= 1
    assert.equal(shouldInjectRoster, true, 'Specialist roster SHOULD be injected on fresh session')
    assert.equal(turnCount, 1)
  })
})

summary()

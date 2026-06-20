/**
 * Unit tests for event-logger.service.ts — monotonic sequence counter.
 *
 * Covers:
 *  - nextSequence (private, via as any): monotonic per-session counters
 *  - sequenceCounters map isolation between sessions
 *
 * Only tests the pure-logic `nextSequence` method — the `log*` methods
 * depend on `eventRepository.create()` which requires DB access.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { eventLoggerService } from '../event-logger.service'

// Fresh instance to avoid cross-test pollution — use the singleton but reset its internal map
const logger = eventLoggerService

describe('EventLoggerService.nextSequence', () => {
  // Reset sequence counters before each test group
  const resetCounters = () => {
    ;(logger as any).sequenceCounters = new Map<string, number>()
  }

  test('first call for a session → returns 1', () => {
    resetCounters()
    const seq = (logger as any).nextSequence('session-a')
    assert.equal(seq, 1)
  })

  test('sequential calls → monotonically increasing', () => {
    resetCounters()
    assert.equal((logger as any).nextSequence('session-b'), 1)
    assert.equal((logger as any).nextSequence('session-b'), 2)
    assert.equal((logger as any).nextSequence('session-b'), 3)
    assert.equal((logger as any).nextSequence('session-b'), 4)
  })

  test('different sessions have independent counters', () => {
    resetCounters()
    assert.equal((logger as any).nextSequence('sess-x'), 1)
    assert.equal((logger as any).nextSequence('sess-y'), 1)
    assert.equal((logger as any).nextSequence('sess-x'), 2)
    assert.equal((logger as any).nextSequence('sess-y'), 2)
    assert.equal((logger as any).nextSequence('sess-x'), 3)
  })

  test('counter survives many increments (no overflow at reasonable numbers)', () => {
    resetCounters()
    for (let i = 0; i < 100; i++) {
      ;(logger as any).nextSequence('stress-test')
    }
    assert.equal((logger as any).nextSequence('stress-test'), 101)
  })

  test('new session after reset starts at 1 again', () => {
    resetCounters()
    ;(logger as any).nextSequence('session-reset')
    ;(logger as any).nextSequence('session-reset')
    resetCounters()
    assert.equal((logger as any).nextSequence('session-reset'), 1)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Stale-turn ("poisoned session") guard.
 *
 * Lives in its own file rather than agent-session-deep-phase25.test.ts: that
 * suite wraps everything in `if (loaded)` and silently skips when the service
 * module fails to load. These cases guard a behaviour change, so a load
 * failure here must be a hard failure.
 *
 * Run: tsx src/main/services/__tests__/turn-poison.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { isTurnPoisoned } from '../turn-poison'

describe('isTurnPoisoned — stale-turn guard', () => {
  test('a normal turn with output is not poisoned', () => {
    assert.equal(isTurnPoisoned({ aborted: false, chunkCount: 12 }), false)
  })

  test('a user-stopped turn is poisoned even though it produced output', () => {
    // req-gchh in the reported timeline: userStop mid-turn still leaves the
    // user turn unanswered inside the CLI session.
    assert.equal(isTurnPoisoned({ aborted: true, chunkCount: 7 }), true)
  })

  test('an empty-exit turn is poisoned', () => {
    // req-j1nv: CLI produced no output, exit null, 0 NDJSON messages.
    assert.equal(isTurnPoisoned({ aborted: false, chunkCount: 0 }), true)
  })

  test('a turn aborted with zero output is poisoned', () => {
    // req-537m: aborted by a workspace switch.
    assert.equal(isTurnPoisoned({ aborted: true, chunkCount: 0 }), true)
  })

  test('a single-chunk turn is enough to keep the session resumable', () => {
    assert.equal(isTurnPoisoned({ aborted: false, chunkCount: 1 }), false)
  })
})

// ─── Standalone runner ──────────────────────────────────────────────────
if (require.main === module) {
  void summaryAsync()
}

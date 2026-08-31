/**
 * N2 — stable segment identity across the committed boundary.
 *
 * createStreamingStore exposes only UNCOMMITTED segments
 * (slice(committedCount)); after clearCommittedSegments() the array indices
 * restart at 0. Rendering derived ids/keys from the index therefore collides
 * with already-committed segments (React key reuse → stale DOM; message id
 * collisions). The fix: the accumulator assigns each segment a monotonic
 * `seq` that survives reset(), and consumers key off `seq`.
 *
 * Deterministic strategy: explicit `flush()` calls + heading-after-substantial-
 * prose splits (same recipe as stream-segment-accumulator-fence.test.ts).
 *
 * Run: tsx src/renderer/src/utils/__tests__/stream-segment-seq.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'

// createStreamingStore imports through the `@renderer/*` alias — map it for
// the duration of the require (same pattern as safety-timeout-orphan.test.ts).
const RENDERER_SRC = path.resolve(__dirname, '../..')
const resolver = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  const mapped = request.startsWith('@renderer/')
    ? path.join(RENDERER_SRC, request.slice('@renderer/'.length))
    : request
  return resolver.call(this, mapped, ...rest)
}
const { createStreamingStore } = require('../../store/createStreamingStore')
;(Module as any)._resolveFilename = resolver

/** ~280 chars of prose — clears the 200-char hasSubstantialContent bar. */
const SUBSTANTIAL_PROSE = 'Intro prose sentence. '.repeat(13)

/** Append a heading that triggers a section split (after substantial content). */
function streamHeadingSplit(store: any, heading: string): void {
  const st = store.getState()
  st.handleStreamChunk({ type: 'text', content: SUBSTANTIAL_PROSE })
  st.flush()
  st.handleStreamChunk({ type: 'text', content: `${heading}\n` })
  st.flush()
}

describe('StreamSegment.seq — monotonic identity (N2)', () => {
  test('segments get strictly increasing seq numbers', () => {
    const store = createStreamingStore()
    streamHeadingSplit(store, '## First heading')
    streamHeadingSplit(store, '## Second heading')
    streamHeadingSplit(store, '## Third heading')

    const segments = store.getState().segments
    assert.ok(segments.length >= 2, `expected >=2 segments, got ${segments.length}`)
    for (let i = 1; i < segments.length; i++) {
      assert.ok(
        segments[i].seq > segments[i - 1].seq,
        `seq must increase: ${segments[i - 1].seq} -> ${segments[i].seq}`
      )
    }
    store.getState().reset()
  })

  test('seq survives clearCommittedSegments — no id reuse across the boundary', () => {
    const store = createStreamingStore()
    streamHeadingSplit(store, '## Before boundary')
    streamHeadingSplit(store, '## Second before boundary')

    const before = store.getState().segments
    const committedSeqs = before.map((s: any) => s.seq)
    assert.ok(committedSeqs.length >= 2, `expected >=2 committed, got ${committedSeqs.length}`)

    store.getState().clearCommittedSegments()
    assert.equal(store.getState().segments.length, 0, 'committed segments cleared')

    // New segments after the boundary must NOT reuse the committed seqs —
    // index-derived ids would restart at 0 and collide.
    streamHeadingSplit(store, '## After boundary')
    const after = store.getState().segments
    assert.ok(after.length >= 1)
    for (const seg of after) {
      assert.ok(
        !committedSeqs.includes(seg.seq),
        `seq ${seg.seq} must not reuse a committed seq (${committedSeqs.join(',')})`
      )
    }
    store.getState().reset()
  })

  test('seq survives reset() — ids never repeat for the accumulator lifetime', () => {
    const store = createStreamingStore()
    streamHeadingSplit(store, '## Before reset')
    const firstSeq = store.getState().segments[0]?.seq
    assert.ok(firstSeq !== undefined)

    store.getState().reset()
    streamHeadingSplit(store, '## After reset')
    const secondSeq = store.getState().segments[0]?.seq
    assert.ok(secondSeq !== undefined)
    assert.ok(secondSeq > firstSeq, `seq must not repeat after reset: ${firstSeq} -> ${secondSeq}`)
    store.getState().reset()
  })
})

// Only exit when run standalone — in the shared runner the harness's own
// summaryAsync() owns the totals (an unconditional call would exit mid-suite
// and silently truncate every later file).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

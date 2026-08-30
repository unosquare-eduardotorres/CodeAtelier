/**
 * Accumulator-level tests for the F5 FIX: no split trigger (size, heading, or
 * tool) may fire while the current segment is inside a fenced code block.
 *
 * Regression origin: a `## ` inside a fenced markdown sample split the segment
 * mid-fence (rendering two broken fences), and text arriving after tools while
 * inside a fence detached the tools from the in-fence text. All three triggers
 * now defer until the fence closes; fence parity stays truthful because a
 * non-split never resets `inCodeFence`.
 *
 * Deterministic strategy: explicit `flush()` calls control exactly what is
 * flushed when (no reliance on the 250ms SentenceBuffer timer).
 *
 * Run: tsx src/renderer/src/utils/__tests__/stream-segment-accumulator-fence.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../../main/services/__tests__/test-harness'
import { StreamSegmentAccumulator } from '../stream-segment-accumulator'
import type { SegmentState } from '../stream-segment-accumulator'

/** ~280 chars of prose — clears the 200-char hasSubstantialContent bar. */
const SUBSTANTIAL_PROSE = 'Intro prose sentence. '.repeat(13)

function makeAccumulator(): { acc: StreamSegmentAccumulator; states: SegmentState[] } {
  const states: SegmentState[] = []
  const acc = new StreamSegmentAccumulator((state) => states.push(state))
  return { acc, states }
}

describe('StreamSegmentAccumulator — F5 fence-guarded splits', () => {
  test('heading flush inside a fence does NOT split', () => {
    const { acc } = makeAccumulator()
    acc.appendText(SUBSTANTIAL_PROSE)
    acc.flush()

    // Open a fence — parity flips to inside on this flush.
    acc.appendText('```md\n')
    acc.flush()

    // Heading arrives while inside the fence: isNewSection && hasSubstantialContent
    // are both true, but canSplit must be false.
    acc.appendText('## Heading inside fence\n')
    acc.flush()

    const state = acc.getState()
    assert.equal(state.segments.length, 0, 'no segment must be committed mid-fence')
    assert.ok(
      state.currentContent.includes('## Heading inside fence'),
      'in-fence heading stays in the live segment'
    )

    acc.reset()
  })

  test('text-after-tools inside a fence does NOT split — tools stay attached', () => {
    const { acc } = makeAccumulator()
    acc.appendText(SUBSTANTIAL_PROSE)
    acc.flush()
    acc.appendText('```md\n')
    acc.flush() // inside the fence now

    // Tool arrives while inside the fence, then new text after it.
    acc.handleToolActivity({ id: 't1', toolName: 'Read' })
    acc.appendText('text after tools inside fence\n')
    acc.flush()

    const state = acc.getState()
    assert.equal(state.segments.length, 0, 'tool split must defer inside a fence')
    assert.equal(
      state.currentToolActivities.length,
      1,
      'tools stay attached to the in-fence segment'
    )
    assert.ok(state.currentContent.includes('text after tools inside fence'))

    acc.reset()
  })

  test('deferred heading split fires on the next eligible flush after the fence closes', () => {
    const { acc } = makeAccumulator()
    acc.appendText(SUBSTANTIAL_PROSE)
    acc.flush()
    acc.appendText('```md\n')
    acc.flush()
    acc.appendText('## Heading inside fence\n')
    acc.flush() // deferred — no split
    assert.equal(acc.getState().segments.length, 0)

    // Close the fence: parity flips back to outside on this flush.
    acc.appendText('```\n')
    acc.flush()

    // Next heading flush is eligible again — the deferred split fires.
    acc.appendText('## Real Heading\n')
    acc.flush()

    const state = acc.getState()
    assert.equal(state.segments.length, 1, 'split fires once the fence has closed')
    assert.ok(
      state.segments[0].content.includes('## Heading inside fence'),
      'committed segment carries the in-fence content'
    )
    assert.ok(
      state.currentContent.startsWith('## Real Heading'),
      'new segment starts with the post-fence heading'
    )

    acc.reset()
  })

  test('deferred tool split fires after the fence closes (parity preserved by non-split)', () => {
    const { acc } = makeAccumulator()
    acc.appendText(SUBSTANTIAL_PROSE)
    acc.flush()
    acc.appendText('```md\n')
    acc.flush()
    acc.handleToolActivity({ id: 't1', toolName: 'Read' })
    acc.appendText('text after tools inside fence\n')
    acc.flush() // deferred — tools still attached
    assert.equal(acc.getState().segments.length, 0)

    // Close the fence, then send more text — the tool split is now eligible.
    acc.appendText('```\n')
    acc.flush()
    acc.appendText('text after the fence closed.\n')
    acc.flush()

    const state = acc.getState()
    assert.equal(state.segments.length, 1, 'deferred tool split fires after fence close')
    assert.equal(
      state.segments[0].toolActivities.length,
      1,
      'tools are finalized with the in-fence segment'
    )
    assert.equal(state.currentToolActivities.length, 0, 'new segment starts tool-free')
    assert.ok(state.currentContent.includes('text after the fence closed.'))

    acc.reset()
  })
})

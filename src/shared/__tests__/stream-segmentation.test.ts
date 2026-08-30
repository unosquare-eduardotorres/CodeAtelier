/**
 * Unit tests for the stream-segmentation size-threshold commit rule (A2 FIX).
 *
 * Regression origin: blueprint phases streamed one ever-growing live bubble —
 * the renderer re-parsed the FULL accumulated text on every ~250ms flush
 * (O(total) per flush → renderer CPU saturation). The accumulator now
 * finalizes segments at paragraph boundaries once over SEGMENT_CHAR_LIMIT,
 * never inside a fenced code block.
 *
 * Run: tsx src/shared/__tests__/stream-segmentation.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../main/services/__tests__/test-harness'
import {
  SEGMENT_CHAR_LIMIT,
  SEGMENT_HARD_CAP_CHARS,
  shouldCommitForSize,
  fenceParityAfter
} from '../stream-segmentation'

describe('shouldCommitForSize — size-threshold commit rule', () => {
  test('commits when over the cap at a paragraph boundary outside fences', () => {
    assert.equal(shouldCommitForSize(SEGMENT_CHAR_LIMIT, 'end of paragraph.\n\n', false), true)
  })

  test('does not commit below the cap even at a paragraph boundary', () => {
    assert.equal(shouldCommitForSize(SEGMENT_CHAR_LIMIT - 1, 'text.\n\n', false), false)
  })

  test('does not commit over the cap on a sentence-only flush (no trailing newline)', () => {
    // Sentence flushes carry no trailing blank line — must wait for a true break.
    assert.equal(shouldCommitForSize(SEGMENT_CHAR_LIMIT, 'a sentence.', false), false)
  })

  test('does not commit inside a fenced code block', () => {
    assert.equal(shouldCommitForSize(SEGMENT_CHAR_LIMIT, 'code line\n', true), false)
  })

  test('commits right after a fence closes (parity false again)', () => {
    assert.equal(
      shouldCommitForSize(SEGMENT_CHAR_LIMIT, '```\n\nprose after fence.\n\n', false),
      true
    )
  })
})

describe('shouldCommitForSize — F4 hard cap (no-boundary streams)', () => {
  test('hard cap commits on a sentence-only flush outside fences', () => {
    // No paragraph boundary at all — the soft rule alone would wait forever.
    assert.equal(shouldCommitForSize(SEGMENT_HARD_CAP_CHARS, 'a sentence.', false), true)
  })

  test('hard cap does NOT commit inside a fenced code block', () => {
    // A mid-fence split would render as two broken fences — must keep waiting.
    assert.equal(shouldCommitForSize(SEGMENT_HARD_CAP_CHARS, 'code line', true), false)
  })

  test('below the hard cap with no newline still waits (soft rule only)', () => {
    // Between SEGMENT_CHAR_LIMIT and SEGMENT_HARD_CAP_CHARS, sentence-only
    // flushes still wait for a paragraph boundary.
    const between = Math.floor((SEGMENT_CHAR_LIMIT + SEGMENT_HARD_CAP_CHARS) / 2)
    assert.ok(between > SEGMENT_CHAR_LIMIT && between < SEGMENT_HARD_CAP_CHARS)
    assert.equal(shouldCommitForSize(between, 'a sentence.', false), false)
  })
})

describe('fenceParityAfter — fence tracking across flushes', () => {
  test('opening a fence flips to inside', () => {
    assert.equal(fenceParityAfter(false, '```ts\nconst x = 1\n'), true)
  })

  test('opening and closing a fence in one flush stays outside', () => {
    assert.equal(fenceParityAfter(false, '```ts\nconst x = 1\n```\n'), false)
  })

  test('a fence split across flushes stays tracked', () => {
    const afterOpen = fenceParityAfter(false, '```ts\nconst x = 1\n')
    assert.equal(afterOpen, true)
    const afterClose = fenceParityAfter(afterOpen, 'const y = 2\n```\n')
    assert.equal(afterClose, false)
  })

  test('indented fences count (trimStart)', () => {
    assert.equal(fenceParityAfter(false, '  ```python\nprint(1)\n'), true)
  })

  test('prose without fences is a no-op', () => {
    assert.equal(fenceParityAfter(false, 'just text\nmore text'), false)
    assert.equal(fenceParityAfter(true, 'still inside\nno fence markers'), true)
  })
})

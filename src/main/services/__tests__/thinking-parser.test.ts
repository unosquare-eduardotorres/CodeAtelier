/**
 * Unit tests for thinking-parser.ts — extracts <think>...</think> reasoning
 * blocks from local LLM output.
 *
 * Pure logic — no Electron deps — runs directly from the main-process harness.
 *
 * Coverage:
 *  - extractThinkingBlocks: single / multiple blocks, no block, multiline.
 *  - StreamingThinkingParser: push/flush/reset, split chunks, partial </think>
 *    at buffer edge, partial <think> at buffer edge, unclosed block on flush.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { extractThinkingBlocks, StreamingThinkingParser } from '../thinking-parser'

describe('extractThinkingBlocks', () => {
  test('returns text unchanged when no think block present', () => {
    const result = extractThinkingBlocks('just a plain answer')
    assert.equal(result.thinking, '')
    assert.equal(result.response, 'just a plain answer')
  })

  test('extracts a single block and strips it from the response', () => {
    const result = extractThinkingBlocks('<think>reasoning</think>the answer')
    assert.equal(result.thinking, 'reasoning')
    assert.equal(result.response, 'the answer')
  })

  test('trims whitespace inside the block', () => {
    const result = extractThinkingBlocks('<think>  padded reasoning  </think>answer')
    assert.equal(result.thinking, 'padded reasoning')
  })

  test('concatenates multiple blocks with a blank line separator', () => {
    const result = extractThinkingBlocks('<think>first</think>mid<think>second</think>end')
    assert.equal(result.thinking, 'first\n\nsecond')
    assert.equal(result.response, 'midend')
  })

  test('handles multiline content inside a block', () => {
    const result = extractThinkingBlocks('<think>line one\nline two</think>done')
    assert.equal(result.thinking, 'line one\nline two')
    assert.equal(result.response, 'done')
  })
})

describe('StreamingThinkingParser', () => {
  test('emits response text when no think tags are present', () => {
    const parser = new StreamingThinkingParser()
    const out = parser.push('hello world')
    assert.equal(out.thinking, '')
    assert.equal(out.response, 'hello world')
    assert.equal(out.isInsideThinkBlock, false)
  })

  test('parses a complete block in one push', () => {
    const parser = new StreamingThinkingParser()
    const out = parser.push('<think>reasoning</think>answer')
    assert.equal(out.thinking, 'reasoning')
    assert.equal(out.response, 'answer')
    assert.equal(out.isInsideThinkBlock, false)
  })

  test('buffers across split chunks until close tag arrives', () => {
    const parser = new StreamingThinkingParser()
    const a = parser.push('<think>part one ')
    assert.equal(a.thinking, '')
    assert.equal(a.isInsideThinkBlock, true)
    const b = parser.push('part two</think>final')
    assert.equal(b.thinking, 'part one part two')
    assert.equal(b.response, 'final')
    assert.equal(b.isInsideThinkBlock, false)
  })

  test('handles a partial </think> tag split at the buffer edge', () => {
    const parser = new StreamingThinkingParser()
    parser.push('<think>reasoning</thi')
    // The partial close tag must NOT be emitted as thinking content yet.
    const mid = parser.push('nk>response')
    assert.equal(mid.thinking, 'reasoning')
    assert.equal(mid.response, 'response')
  })

  test('handles a partial <think> tag split at the buffer edge', () => {
    const parser = new StreamingThinkingParser()
    const a = parser.push('answer <thi')
    // "answer " emitted; "<thi" held back as a potential tag start.
    assert.equal(a.response, 'answer ')
    assert.equal(a.isInsideThinkBlock, false)
    const b = parser.push('nk>secret</think>rest')
    assert.equal(b.thinking, 'secret')
    assert.equal(b.response, 'rest')
  })

  test('flush emits an unclosed think block as thinking', () => {
    const parser = new StreamingThinkingParser()
    parser.push('<think>cut off reasoning')
    const flushed = parser.flush()
    assert.equal(flushed.thinking, 'cut off reasoning')
    assert.equal(flushed.response, '')
  })

  test('flush emits buffered response text outside a think block', () => {
    const parser = new StreamingThinkingParser()
    // A lone partial open tag is buffered, not emitted, until flush.
    parser.push('tail <thi')
    const flushed = parser.flush()
    assert.equal(flushed.thinking, '')
    assert.equal(flushed.response, '<thi')
  })

  test('reset clears state so a new turn parses independently', () => {
    const parser = new StreamingThinkingParser()
    parser.push('<think>leftover')
    parser.reset()
    const out = parser.push('fresh answer')
    assert.equal(out.thinking, '')
    assert.equal(out.response, 'fresh answer')
    assert.equal(out.isInsideThinkBlock, false)
  })

  test('emits multiple blocks across many pushes', () => {
    const parser = new StreamingThinkingParser()
    const first = parser.push('<think>a</think>X<think>b</think>Y')
    assert.equal(first.thinking, 'a\n\nb')
    assert.equal(first.response, 'XY')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

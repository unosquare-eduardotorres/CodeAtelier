/**
 * Unit tests for SentenceBuffer — the renderer-side helper that
 * accumulates streaming tokens and flushes complete sentences.
 *
 * Pure logic — no DOM, no React, no Electron deps — so we can run it
 * directly from the main-process test harness.
 *
 * Coverage:
 *  - Sentence-boundary flushing (default behavior).
 *  - NEW: char-count force-flush rule (long code-only chunks).
 *  - NEW: 250ms timer flush (regression for the original 600ms stall).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SentenceBuffer } from '../../../renderer/src/utils/sentence-buffer'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('SentenceBuffer', () => {
  test('flushes_on_sentence_boundary', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('Hello world. ')
    assert.equal(flushed.join(''), 'Hello world. ')
  })

  test('does_not_flush_on_partial_sentence', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('partial sentence without ending')
    assert.equal(flushed.length, 0)
  })

  test('char_count_force_flush_when_unflushed_exceeds_limit', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    // 250 chars without any sentence-ending punctuation — should force-flush
    // because we exceed the 200-char threshold.
    const longCode = 'const x = 1\n'.repeat(25) // 300 chars, no '.'
    buffer.append(longCode)
    assert.ok(
      flushed.length > 0,
      `expected force-flush on >200 chars without sentence boundary, got 0 flushes (longCode.length=${longCode.length})`
    )
    assert.equal(flushed.join(''), longCode)
  })

  test('char_count_does_not_flush_under_limit', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('a'.repeat(150))
    assert.equal(flushed.length, 0, 'should not flush under 200-char limit without boundary')
  })

  test('flush_method_drains_remaining_buffer', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('partial without boundary')
    assert.equal(flushed.length, 0)

    buffer.flush()
    assert.equal(flushed.join(''), 'partial without boundary')
  })

  test('timer_flush_under_300ms', async () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('partial without boundary')
    // Default FLUSH_TIMEOUT is now 250ms — wait slightly longer.
    await delay(300)
    assert.equal(
      flushed.join(''),
      'partial without boundary',
      'timer should force-flush within 300ms'
    )
  })

  test('flushes_paragraph_boundary_on_double_newline', () => {
    const flushed: string[] = []
    const buffer = new SentenceBuffer((text) => flushed.push(text))

    buffer.append('paragraph one\n\n')
    assert.ok(flushed.join('').includes('paragraph one'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

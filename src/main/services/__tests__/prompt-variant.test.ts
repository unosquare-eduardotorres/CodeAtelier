/**
 * Unit tests for prompt-variant.ts — full/lean variant selection driven by
 * resolvePromptVerbosity(model). Lean is enabled for Opus 4.8+ and Sonnet 4.6+;
 * Haiku and older models get the full variant.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { selectVariant, isLeanModel, type PromptVariants } from '../prompt-variant'

const VARIANTS: PromptVariants = { full: 'FULL_TEXT', lean: 'LEAN_TEXT' }

describe('prompt-variant › selectVariant', () => {
  test('returns lean for claude-opus-4-8', () => {
    assert.equal(selectVariant(VARIANTS, 'claude-opus-4-8'), 'LEAN_TEXT')
  })

  test('returns lean for an Opus newer than 4.8', () => {
    assert.equal(selectVariant(VARIANTS, 'claude-opus-4-9'), 'LEAN_TEXT')
  })

  test('returns lean for Sonnet 4.6', () => {
    assert.equal(selectVariant(VARIANTS, 'claude-sonnet-4-6'), 'LEAN_TEXT')
  })

  test('returns full for Haiku', () => {
    assert.equal(selectVariant(VARIANTS, 'claude-haiku-4-5'), 'FULL_TEXT')
  })

  test('returns full for an older Opus (≤4.7)', () => {
    assert.equal(selectVariant(VARIANTS, 'claude-opus-4-7'), 'FULL_TEXT')
  })

  test('returns full when model is undefined', () => {
    assert.equal(selectVariant(VARIANTS), 'FULL_TEXT')
  })

  test('returns full when model is empty string', () => {
    assert.equal(selectVariant(VARIANTS, ''), 'FULL_TEXT')
  })
})

describe('prompt-variant › isLeanModel', () => {
  test('true for Opus 4.8', () => {
    assert.equal(isLeanModel('claude-opus-4-8'), true)
  })

  test('true for Sonnet 4.6', () => {
    assert.equal(isLeanModel('claude-sonnet-4-6'), true)
  })

  test('false for undefined model', () => {
    assert.equal(isLeanModel(), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for TokenAccountant — accumulates token usage from messages
 * across the lifecycle of a query.
 *
 * Pure class with zero external dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { TokenAccountant } from '../executor-utils/token-accountant'

describe('TokenAccountant', () => {
  // ── accumulateFromMessageStart ──

  test('accumulateFromMessageStart accumulates input + cache tokens', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10
    })
    const s = ta.getSummary()
    assert.equal(s.input, 100)
    assert.equal(s.cacheReadInputTokens, 50)
    assert.equal(s.cacheCreationInputTokens, 10)
    assert.equal(s.output, 0)
  })

  test('accumulateFromMessageStart overwrites contextWindowTokens (snapshot)', () => {
    const ta = new TokenAccountant()
    // First call
    ta.accumulateFromMessageStart({
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 0
    })
    assert.equal(ta.getSummary().contextWindowTokens, 300)

    // Second call — should overwrite contextWindowTokens (not accumulate)
    ta.accumulateFromMessageStart({
      input_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5
    })
    assert.equal(ta.getSummary().contextWindowTokens, 85) // 50+30+5
    assert.equal(ta.getSummary().input, 150) // accumulated: 100+50
  })

  test('accumulateFromMessageStart with undefined is no-op', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart(undefined)
    const s = ta.getSummary()
    assert.equal(s.input, 0)
    assert.equal(s.contextWindowTokens, 0)
  })

  test('accumulateFromMessageStart handles missing fields gracefully', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 42 })
    const s = ta.getSummary()
    assert.equal(s.input, 42)
    assert.equal(s.cacheReadInputTokens, 0)
    assert.equal(s.cacheCreationInputTokens, 0)
  })

  // ── accumulateFromMessageDelta ──

  test('accumulateFromMessageDelta accumulates output tokens only', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageDelta({ output_tokens: 75 })
    ta.accumulateFromMessageDelta({ output_tokens: 25 })
    assert.equal(ta.getSummary().output, 100)
    assert.equal(ta.getSummary().input, 0)
  })

  test('accumulateFromMessageDelta with undefined is no-op', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageDelta(undefined)
    assert.equal(ta.getSummary().output, 0)
  })

  // ── setFromResult (authoritative replace) ──

  test('setFromResult replaces totals with snake_case fields', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 999 }) // will be overwritten
    ta.setFromResult({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20
    })
    const s = ta.getSummary()
    assert.equal(s.input, 200)
    assert.equal(s.output, 50)
    assert.equal(s.cacheReadInputTokens, 80)
    assert.equal(s.cacheCreationInputTokens, 20)
  })

  test('setFromResult supports camelCase field names', () => {
    const ta = new TokenAccountant()
    ta.setFromResult({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 15
    })
    const s = ta.getSummary()
    assert.equal(s.input, 300)
    assert.equal(s.output, 60)
    assert.equal(s.cacheReadInputTokens, 40)
    assert.equal(s.cacheCreationInputTokens, 15)
  })

  test('setFromResult does NOT overwrite existing contextWindowTokens', () => {
    const ta = new TokenAccountant()
    // Set contextWindowTokens via message_start
    ta.accumulateFromMessageStart({
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 0
    })
    assert.equal(ta.getSummary().contextWindowTokens, 150)

    // setFromResult should not overwrite it
    ta.setFromResult({ input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 300 })
    assert.equal(ta.getSummary().contextWindowTokens, 150) // unchanged
  })

  test('setFromResult DOES set contextWindowTokens when it was 0', () => {
    const ta = new TokenAccountant()
    // No message_start — contextWindowTokens is 0
    ta.setFromResult({ input_tokens: 200, cache_read_input_tokens: 100 })
    assert.equal(ta.getSummary().contextWindowTokens, 300) // 200+100
  })

  test('setFromResult with undefined is no-op', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 10 })
    ta.setFromResult(undefined)
    assert.equal(ta.getSummary().input, 10) // unchanged
  })

  // ── accumulateGeneric ──

  test('accumulateGeneric adds to all counters', () => {
    const ta = new TokenAccountant()
    ta.accumulateGeneric({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3
    })
    const s = ta.getSummary()
    assert.equal(s.input, 10)
    assert.equal(s.output, 20)
    assert.equal(s.cacheReadInputTokens, 5)
    assert.equal(s.cacheCreationInputTokens, 3)
  })

  test('accumulateGeneric with undefined is no-op', () => {
    const ta = new TokenAccountant()
    ta.accumulateGeneric(undefined)
    assert.equal(ta.getSummary().input, 0)
  })

  // ── getSummary copy semantics ──

  test('getSummary returns a copy (mutations do not affect internal state)', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 42 })
    const s1 = ta.getSummary()
    s1.input = 9999
    const s2 = ta.getSummary()
    assert.equal(s2.input, 42)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

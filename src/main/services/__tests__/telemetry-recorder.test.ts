/**
 * Unit tests for executor-utils/telemetry-recorder.ts — pure-logic telemetry
 * lifecycle tracking (requestId generation, recordFailure, finalize).
 *
 * Zero dependencies — TelemetryRecorder only uses Date.now() and a counter.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { TelemetryRecorder } from '../executor-utils/telemetry-recorder'

describe('TelemetryRecorder — constructor', () => {
  test('generates a requestId with the model name', () => {
    const recorder = new TelemetryRecorder('sonnet-4')
    assert.ok(recorder.requestId.startsWith('exec-'))
    // The ID format is exec-{counter}-{timestamp}
    assert.match(recorder.requestId, /^exec-\d+-\d+$/)
  })

  test('generates monotonically increasing requestIds', () => {
    const r1 = new TelemetryRecorder('haiku')
    const r2 = new TelemetryRecorder('haiku')
    // Counter portion is the second segment
    const counter1 = parseInt(r1.requestId.split('-')[1])
    const counter2 = parseInt(r2.requestId.split('-')[1])
    assert.ok(counter2 > counter1, `counter2 (${counter2}) should be > counter1 (${counter1})`)
  })
})

describe('TelemetryRecorder — recordFailure', () => {
  test('sets status to failed and captures error message', () => {
    const recorder = new TelemetryRecorder('opus')
    recorder.recordFailure(new Error('connection timeout'))
    // finalize returns a copy of the entry
    const entry = recorder.finalize({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    assert.equal(entry.status, 'failed')
    assert.equal(entry.error, 'connection timeout')
  })

  test('computes durationMs on failure', () => {
    const recorder = new TelemetryRecorder('sonnet')
    recorder.recordFailure(new Error('timeout'))
    const entry = recorder.finalize({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    assert.equal(typeof entry.durationMs, 'number')
    assert.ok(entry.durationMs! >= 0)
  })
})

describe('TelemetryRecorder — finalize', () => {
  test('sets status to succeeded when still started', () => {
    const recorder = new TelemetryRecorder('haiku')
    const entry = recorder.finalize({
      input: 100,
      output: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      contextWindowTokens: 0
    })
    assert.equal(entry.status, 'succeeded')
    assert.equal(entry.model, 'haiku')
    assert.ok(entry.durationMs! >= 0)
  })

  test('copies tokenUsage via spread (not shared reference)', () => {
    const recorder = new TelemetryRecorder('sonnet')
    const tokens = {
      input: 100,
      output: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      contextWindowTokens: 0
    }
    const entry = recorder.finalize(tokens)
    // Mutate original — entry should be unaffected
    tokens.input = 999
    assert.equal(entry.tokenUsage!.input, 100)
  })

  test('finalize after recordFailure is a no-op (stays failed)', () => {
    const recorder = new TelemetryRecorder('opus')
    recorder.recordFailure(new Error('boom'))
    const entry = recorder.finalize({
      input: 500,
      output: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    assert.equal(entry.status, 'failed')
    assert.equal(entry.error, 'boom')
    // tokenUsage should NOT be set since finalize was a no-op
    assert.equal(entry.tokenUsage, undefined)
  })

  test('returns a copy (not the internal entry)', () => {
    const recorder = new TelemetryRecorder('sonnet')
    const entry1 = recorder.finalize({
      input: 10,
      output: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    const entry2 = recorder.finalize({
      input: 99,
      output: 99,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    // Both should be identical since finalize only sets on first call
    assert.equal(entry1.tokenUsage!.input, 10)
    assert.equal(entry2.tokenUsage!.input, 10)
    // They should be different object references
    assert.notEqual(entry1, entry2)
  })

  test('requestId getter returns the constructor-assigned ID', () => {
    const recorder = new TelemetryRecorder('haiku')
    const entry = recorder.finalize({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindowTokens: 0
    })
    assert.equal(entry.requestId, recorder.requestId)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Tests for one-shot-claude — the shared `claude -p` wrapper that records usage.
 * parseOneShotResult is pure; runOneShotClaude is tested with an injected runner.
 * Skips the DB-recording assertions if better-sqlite3 is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { parseOneShotResult, runOneShotClaude } from '../one-shot-claude'

const SAMPLE_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Hello from Claude',
  session_id: 'abc',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5
  },
  modelUsage: { 'claude-haiku-4-5-20251001': {} }
})

describe('parseOneShotResult', () => {
  test('extracts text + usage + model + cost from a valid JSON result', () => {
    const parsed = parseOneShotResult(SAMPLE_JSON)
    assert.ok(parsed)
    assert.equal(parsed.text, 'Hello from Claude')
    assert.equal(parsed.usage.input, 120)
    assert.equal(parsed.usage.output, 45)
    assert.equal(parsed.usage.cacheRead, 10)
    assert.equal(parsed.usage.cacheCreation, 5)
    assert.equal(parsed.model, 'claude-haiku-4-5-20251001')
    assert.equal(parsed.totalCostUsd, 0.0123)
  })

  test('returns null on non-JSON stdout', () => {
    assert.equal(parseOneShotResult('not json at all'), null)
    assert.equal(parseOneShotResult(''), null)
  })

  test('defaults missing usage fields to 0', () => {
    const parsed = parseOneShotResult(JSON.stringify({ result: 'x' }))
    assert.ok(parsed)
    assert.equal(parsed.usage.input, 0)
    assert.equal(parsed.usage.output, 0)
    assert.equal(parsed.model, null)
  })
})

describe('runOneShotClaude', () => {
  test('returns the result text and forces --output-format json', async () => {
    let capturedArgs: string[] = []
    const res = await runOneShotClaude({
      feature: 'condense',
      model: 'claude-haiku-4-5-20251001',
      args: ['-p', 'prompt', '--output-format', 'text'],
      _runner: async (args) => {
        capturedArgs = args
        return SAMPLE_JSON
      }
    })
    assert.equal(res.text, 'Hello from Claude')
    assert.equal(res.usage.input, 120)
    // The caller's --output-format text must be replaced with json
    const fmtIdx = capturedArgs.lastIndexOf('--output-format')
    assert.equal(capturedArgs[fmtIdx + 1], 'json')
    assert.ok(!capturedArgs.includes('text'))
  })

  test('parse-failure path returns raw stdout and zero usage', async () => {
    const res = await runOneShotClaude({
      feature: 'condense',
      args: ['-p', 'prompt'],
      _runner: async () => 'totally not json'
    })
    assert.equal(res.text, 'totally not json')
    assert.equal(res.usage.input, 0)
    assert.equal(res.costCents, 0)
  })
})

/**
 * Phase 27 — one-shot-local.ts pure function test.
 *
 * Tests buildMemoryFeedFallbackArgs — pure string → string[] function.
 * GLM-REASONING (C1): parseChatCompletion + isTruncationWithReasoning +
 * runOneShotLocal's truncation retry / reasoning fallback, via a stubbed
 * global fetch (same pattern as context-window-resolver.test.ts).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { setupFullMock, mockService, createSpy } from './setup-full-mock'

setupFullMock()
mockService('model-config.service', {
  modelConfigService: { getLocalLLMConfig: createSpy(() => ({})) }
})
mockService('ollama-manager', { ollamaManagerService: {} })
mockService('omlx-manager', { omlxManagerService: {} })
// runOneShotLocal records usage on the success path.
mockService('usage-tracker.service', {
  usageTrackerService: { recordUsage: createSpy(() => {}) }
})

const {
  buildMemoryFeedFallbackArgs,
  parseChatCompletion,
  isTruncationWithReasoning,
  runOneShotLocal
} = require('../one-shot-local')

describe('buildMemoryFeedFallbackArgs — fallback arg construction', () => {
  test('returns non-empty array', () => {
    const result = buildMemoryFeedFallbackArgs('Extract facts from this commit')
    assert.ok(Array.isArray(result))
    assert.ok(result.length > 0)
  })

  test('includes the prompt text', () => {
    const prompt = 'Extract key architectural decisions'
    const result = buildMemoryFeedFallbackArgs(prompt)
    const joined = result.join(' ')
    assert.ok(joined.includes(prompt) || result.some((a: string) => a === prompt))
  })

  test('includes required CLI flags', () => {
    const result = buildMemoryFeedFallbackArgs('test prompt')
    // Should include -p flag for prompt
    assert.ok(result.includes('-p') || result.some((a: string) => a.startsWith('--')))
  })
})

// ── GLM-REASONING (C1) — parseChatCompletion ─────────────────────────────────

describe('parseChatCompletion — GLM reasoning-content parsing', () => {
  test('normal content → returned as text', () => {
    const parsed = parseChatCompletion({
      choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }]
    })
    assert.equal(parsed.text, 'the answer')
    assert.equal(parsed.finishReason, 'stop')
    assert.equal(parsed.reasoningText, '')
  })

  test('empty content + reasoning_content + finish_reason "length" → all three surfaced', () => {
    const parsed = parseChatCompletion({
      choices: [
        {
          message: { content: '', reasoning_content: 'thinking hard about the doc...' },
          finish_reason: 'length'
        }
      ]
    })
    assert.equal(parsed.text, '')
    assert.equal(parsed.finishReason, 'length')
    assert.equal(parsed.reasoningText, 'thinking hard about the doc...')
    assert.equal(isTruncationWithReasoning(parsed), true)
  })

  test('both empty → empty text (caller throw still governs)', () => {
    const parsed = parseChatCompletion({
      choices: [{ message: { content: '' }, finish_reason: 'length' }]
    })
    assert.equal(parsed.text, '')
    assert.equal(parsed.reasoningText, '')
    assert.equal(isTruncationWithReasoning(parsed), false)
  })

  test('missing/malformed fields never throw', () => {
    assert.deepEqual(parseChatCompletion({}), { text: '', finishReason: null, reasoningText: '' })
    assert.deepEqual(parseChatCompletion(null), {
      text: '',
      finishReason: null,
      reasoningText: ''
    })
    assert.deepEqual(parseChatCompletion({ choices: [] }), {
      text: '',
      finishReason: null,
      reasoningText: ''
    })
    // non-string content must not leak through
    const weird = parseChatCompletion({
      choices: [{ message: { content: 42 }, finish_reason: 7 }]
    })
    assert.equal(weird.text, '')
    assert.equal(weird.finishReason, null)
  })

  test('truncation shape requires empty content AND reasoning AND length', () => {
    const mk = (text: string, reason: string | null, reasoning: string) => ({
      text,
      finishReason: reason,
      reasoningText: reasoning
    })
    assert.equal(isTruncationWithReasoning(mk('', 'length', 'r')), true)
    assert.equal(isTruncationWithReasoning(mk('a', 'length', 'r')), false, 'content present')
    assert.equal(isTruncationWithReasoning(mk('', 'stop', 'r')), false, 'not truncated')
    assert.equal(isTruncationWithReasoning(mk('', 'length', '')), false, 'no reasoning')
  })
})

// ── GLM-REASONING (C1) — runOneShotLocal over a stubbed fetch ────────────────

type FetchFn = typeof globalThis.fetch

/** Install a fetch stub answering sequential JSON bodies; returns call log. Restores in the returned done(). */
function stubFetch(bodies: Array<Record<string, unknown>>): {
  calls: Array<Record<string, unknown>>
  done: () => void
} {
  const calls: Array<Record<string, unknown>> = []
  const queue = [...bodies]
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : {})
    const body = queue.shift()
    if (!body) throw new Error('test: no more stubbed bodies')
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as FetchFn
  return {
    calls,
    done: () => {
      globalThis.fetch = original
    }
  }
}

const baseOpts = {
  systemPrompt: 'sys',
  userMessage: 'user',
  baseUrl: 'http://127.0.0.1:1',
  model: 'glm-5.3',
  feature: 'memory_feed'
}

describe('runOneShotLocal — GLM truncation retry + reasoning fallback', () => {
  // The harness runs async tests concurrently and these swap globalThis.fetch —
  // runExclusive() serializes them on the shared lock (harness-provided pattern).
  test('normal completion: content returned, single request, no finishReason games', () =>
    runExclusive(async () => {
      const { calls, done } = stubFetch([
        { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
      ])
      try {
        const result = await runOneShotLocal({ ...baseOpts, maxTokens: 1000 })
        assert.equal(result.text, 'ok')
        assert.equal(result.provider, 'local')
        assert.equal(result.finishReason, 'stop')
        assert.equal(calls.length, 1)
        assert.equal((calls[0] as { max_tokens: number }).max_tokens, 1000)
      } finally {
        done()
      }
    }))

  test('truncation → ONE retry with doubled max_tokens, second answer wins', () =>
    runExclusive(async () => {
      const { calls, done } = stubFetch([
        {
          choices: [
            {
              message: { content: '', reasoning_content: 'halfway through thinking' },
              finish_reason: 'length'
            }
          ]
        },
        { choices: [{ message: { content: 'recovered answer' }, finish_reason: 'stop' }] }
      ])
      try {
        const result = await runOneShotLocal({ ...baseOpts, maxTokens: 2048 })
        assert.equal(result.text, 'recovered answer')
        assert.equal(result.finishReason, 'stop')
        assert.equal(calls.length, 2, 'exactly one retry')
        assert.equal((calls[0] as { max_tokens: number }).max_tokens, 2048)
        assert.equal((calls[1] as { max_tokens: number }).max_tokens, 4096, 'budget doubled')
      } finally {
        done()
      }
    }))

  test('retry ceiling bounds the doubled budget', () =>
    runExclusive(async () => {
      const { calls, done } = stubFetch([
        {
          choices: [{ message: { content: '', reasoning_content: 'x' }, finish_reason: 'length' }]
        },
        {
          choices: [
            {
              message: { content: '', reasoning_content: 'still thinking' },
              finish_reason: 'length'
            }
          ]
        }
      ])
      try {
        // 8192 doubles to exactly the 16384 ceiling (not beyond it).
        const result = await runOneShotLocal({ ...baseOpts, maxTokens: 8192 })
        // Second call also truncated-empty → falls back to reasoning_content.
        assert.equal(calls.length, 2)
        assert.equal((calls[1] as { max_tokens: number }).max_tokens, 16384, 'ceiling, not 16384*2')
        assert.equal(result.text, 'still thinking')
        assert.equal(result.finishReason, 'length')
      } finally {
        done()
      }
    }))

  test('persistently empty content with reasoning → reasoning text returned as fallback', () =>
    runExclusive(async () => {
      const { calls, done } = stubFetch([
        {
          choices: [
            {
              message: { content: '', reasoning_content: 'the extraction reasoning' },
              finish_reason: 'length'
            }
          ]
        },
        {
          choices: [
            {
              message: { content: '', reasoning_content: 'the extraction reasoning, again' },
              finish_reason: 'length'
            }
          ]
        }
      ])
      try {
        const result = await runOneShotLocal({ ...baseOpts, maxTokens: 4096 })
        assert.equal(
          result.text,
          'the extraction reasoning, again',
          'the retried completion is the source of the fallback text'
        )
        assert.equal(result.finishReason, 'length', 'finishReason is surfaced')
        assert.equal(calls.length, 2)
      } finally {
        done()
      }
    }))

  test('both content and reasoning empty → empty text (caller throw governs)', () =>
    runExclusive(async () => {
      const { calls, done } = stubFetch([
        { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
      ])
      try {
        const result = await runOneShotLocal({ ...baseOpts, maxTokens: 1000 })
        assert.equal(result.text, '')
        assert.equal(result.finishReason, 'stop')
        assert.equal(calls.length, 1, 'no retry — not truncation-shaped')
      } finally {
        done()
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

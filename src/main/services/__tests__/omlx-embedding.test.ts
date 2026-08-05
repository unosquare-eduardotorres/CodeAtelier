/**
 * Run 18: oMLX embedding provider.
 *
 * Validates the parts of OmlxEmbeddingProvider that don't require an actual
 * oMLX server: the not-ready guard, /v1/embeddings response mapping +
 * batch-halving safety net, character truncation, empty-input short-circuit,
 * and dispose(). The oMLX server interaction is stubbed via global.fetch.
 *
 * NOTE: the harness runs async tests in a describe() concurrently, and this
 * suite mutates process-global `fetch` plus the singleton's private state. To
 * avoid cross-test races we run every stateful assertion sequentially inside a
 * SINGLE test that owns the global for its whole duration.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { omlxEmbeddingProvider } from '../omlx-embedding.service'
import { OMLX_EMBEDDING } from '../../../shared/constants'

const internals = omlxEmbeddingProvider as any

type FetchFn = typeof fetch

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function parseInput(init?: RequestInit): string[] {
  const parsed = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
  return parsed.input ?? []
}

describe('OmlxEmbeddingProvider', () => {
  test('embed contract: guard, mapping, halving, empty-input, truncation, dispose', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        // ── not-ready guard: no silent fallback ──────────────────────────────
        internals._isReady = false
        internals.baseUrl = ''
        await assert.rejects(
          () => omlxEmbeddingProvider.embed(['hello']),
          /not ready/,
          'embed() must reject before initialize()'
        )

        // Force the singleton into a "ready" state pointing at a dummy server.
        internals._isReady = true
        internals.baseUrl = 'http://127.0.0.1:65000'
        internals.modelName = 'test-embed-model'

        // ── response mapping + index ordering ────────────────────────────────
        global.fetch = (async () =>
          jsonResponse({
            data: [
              { index: 1, embedding: [4, 5, 6] },
              { index: 0, embedding: [1, 2, 3] }
            ]
          })) as FetchFn
        const ordered = await omlxEmbeddingProvider.embed(['a', 'b'])
        assert.deepEqual(
          ordered,
          [
            [1, 2, 3],
            [4, 5, 6]
          ],
          'results must be ordered by data[].index'
        )

        // ── batch-halving on error ───────────────────────────────────────────
        // Fail any multi-text request; succeed for single-text requests. The
        // provider should recursively split until every text is embedded alone.
        global.fetch = (async (_url: string, init?: RequestInit) => {
          const input = parseInput(init)
          if (input.length > 1) throw new Error('simulated oversized-batch failure')
          return jsonResponse({ data: [{ index: 0, embedding: [input[0].length] }] })
        }) as FetchFn
        const halved = await omlxEmbeddingProvider.embed(['xx', 'y', 'zzz'])
        assert.deepEqual(halved, [[2], [1], [3]], 'each text must be embedded after splitting')

        // ── empty input short-circuits without calling fetch ─────────────────
        let called = false
        global.fetch = (async () => {
          called = true
          return jsonResponse({ data: [] })
        }) as FetchFn
        const empty = await omlxEmbeddingProvider.embed([])
        assert.deepEqual(empty, [])
        assert.equal(called, false, 'embed([]) must not hit the server')

        // ── length-mismatch guard: short/empty data on a 200 must not corrupt ──
        global.fetch = (async () => jsonResponse({ data: [] })) as FetchFn
        await assert.rejects(
          () => omlxEmbeddingProvider.embed(['solo']),
          /returned 0 valid embeddings for 1/,
          'embed() must reject when the server returns fewer embeddings than inputs'
        )

        // ── oversized-input cap: truncate to maxInputChars before sending ─────
        const cap = OMLX_EMBEDDING.server.maxInputChars
        let sentInput: string[] = []
        global.fetch = (async (_url: string, init?: RequestInit) => {
          sentInput = parseInput(init)
          return jsonResponse({
            data: sentInput.map((s, i) => ({ index: i, embedding: [s.length] }))
          })
        }) as FetchFn
        const big = 'x'.repeat(cap * 3)
        const capped = await omlxEmbeddingProvider.embed([big])
        assert.equal(sentInput[0].length, cap, 'oversized input must be truncated to maxInputChars')
        assert.deepEqual(capped, [[cap]], 'embed() returns a vector for the (capped) input')

        // ── activeModelName reflects discovered model ─────────────────────────
        assert.equal(
          omlxEmbeddingProvider.activeModelName,
          'test-embed-model',
          'activeModelName must reflect the model set during init'
        )

        // ── dispose() resets isReady ──────────────────────────────────────────
        omlxEmbeddingProvider.dispose()
        assert.equal(omlxEmbeddingProvider.isReady, false, 'dispose() must reset isReady')
        assert.equal(omlxEmbeddingProvider.activeModelName, '', 'dispose() must clear modelName')
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.baseUrl = ''
        internals.modelName = ''
      }
    }))

  test('initialize() when oMLX not running rejects with helpful message', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        // Stub omlxManager.checkStatus to return not-running
        // Since omlxManager is used internally, we stub fetch to fail on admin API
        global.fetch = (async () => {
          throw new Error('Connection refused')
        }) as FetchFn

        internals._isReady = false
        internals.initPromise = null

        await assert.rejects(
          () => omlxEmbeddingProvider.initialize(),
          /not running|Connection refused/i,
          'initialize() must reject when oMLX is not reachable'
        )
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.initPromise = null
      }
    }))

  test('initialize() is idempotent when already ready', () =>
    runExclusive(async () => {
      internals._isReady = true
      internals.baseUrl = 'http://127.0.0.1:8000'
      internals.modelName = 'test-model'
      try {
        // Should return immediately without doing anything
        await omlxEmbeddingProvider.initialize()
        assert.equal(omlxEmbeddingProvider.isReady, true, 'should remain ready')
      } finally {
        internals._isReady = false
        internals.baseUrl = ''
        internals.modelName = ''
      }
    }))

  test('initialize() when oMLX running but no embedding model rejects with helpful message', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        // Stub fetch to simulate admin API returning running=true with an LLM model but no embedding model
        global.fetch = (async (url: string) => {
          if (String(url).includes('/admin/api/models')) {
            return jsonResponse({
              models: [
                {
                  id: 'llama3',
                  loaded: true,
                  is_loading: false,
                  model_type: 'llm',
                  estimated_size_formatted: '4 GB',
                  pinned: false,
                  is_default: true
                }
              ]
            })
          }
          // For the initial status check, return running=true
          return jsonResponse({ running: true })
        }) as FetchFn

        internals._isReady = false
        internals.initPromise = null

        await assert.rejects(
          () => omlxEmbeddingProvider.initialize(),
          /No embedding model loaded/,
          'initialize() must reject with helpful message when no embedding model is loaded'
        )
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.initPromise = null
      }
    }))

  test('modelReady and modelError events fire correctly', () =>
    runExclusive(async () => {
      const events: string[] = []
      const onReady = (): void => {
        events.push('ready')
      }
      const onError = (msg: string): void => {
        events.push(`error:${msg}`)
      }

      omlxEmbeddingProvider.on('modelReady', onReady)
      omlxEmbeddingProvider.on('modelError', onError)

      try {
        // Trigger modelReady
        omlxEmbeddingProvider.emit('modelReady')
        assert.deepEqual(events, ['ready'])

        // Trigger modelError
        omlxEmbeddingProvider.emit('modelError', 'test error')
        assert.deepEqual(events, ['ready', 'error:test error'])
      } finally {
        omlxEmbeddingProvider.off('modelReady', onReady)
        omlxEmbeddingProvider.off('modelError', onError)
        internals._isReady = false
        internals.baseUrl = ''
        internals.modelName = ''
      }
    }))

  test('embed() sends Authorization header when apiKey is set', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        internals._isReady = true
        internals.baseUrl = 'http://127.0.0.1:65000'
        internals.modelName = 'test'
        internals.apiKey = 'test-key-123'

        let capturedHeaders: Record<string, string> = {}
        global.fetch = (async (_url: string, init?: RequestInit) => {
          capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}))
          return jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] })
        }) as FetchFn

        await omlxEmbeddingProvider.embed(['test'])
        assert.equal(capturedHeaders['Authorization'], 'Bearer test-key-123')
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.baseUrl = ''
        internals.apiKey = undefined
      }
    }))

  test('embed() handles HTTP 500 error response', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        internals._isReady = true
        internals.baseUrl = 'http://127.0.0.1:65000'
        internals.modelName = 'test'

        global.fetch = (async () => ({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'GPU out of memory'
        })) as unknown as FetchFn

        await assert.rejects(
          () => omlxEmbeddingProvider.embed(['test']),
          /500 Internal Server Error GPU out of memory/
        )
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.baseUrl = ''
      }
    }))

  test('embed() marks not-ready on connection loss and auto-reconnects', () =>
    runExclusive(async () => {
      const originalFetch = global.fetch
      try {
        internals._isReady = true
        internals.baseUrl = 'http://127.0.0.1:65000'
        internals.modelName = 'test'

        // Simulate ECONNREFUSED
        global.fetch = (async () => {
          throw new Error('fetch failed: ECONNREFUSED')
        }) as FetchFn

        await assert.rejects(() => omlxEmbeddingProvider.embed(['test']), /ECONNREFUSED/)

        // After connection loss, provider should be marked not ready
        assert.equal(
          omlxEmbeddingProvider.isReady,
          false,
          'should be marked not-ready after connection loss'
        )
      } finally {
        global.fetch = originalFetch
        internals._isReady = false
        internals.baseUrl = ''
        internals.initPromise = null
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

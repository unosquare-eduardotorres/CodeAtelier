/**
 * Run 18: Llamafile embedding sidecar manager.
 *
 * Validates the parts of LlamafileEmbeddingManager that don't require actually
 * spawning the server: the not-ready guard, free ephemeral-port selection, and
 * the /v1/embeddings response mapping + batch-halving safety net (global.fetch
 * is stubbed, internal state is forced ready). Spawn/health-poll are integration
 * concerns covered at runtime, not in this unit suite.
 *
 * NOTE: the harness runs the async tests in a describe() concurrently, and this
 * suite mutates process-global `fetch` plus the singleton's private state. To
 * avoid cross-test races we run every stateful assertion sequentially inside a
 * SINGLE test that owns the global for its whole duration.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { llamafileEmbeddingProvider } from '../llamafile-embedding.service'
import { LLAMAFILE_EMBEDDING } from '../../../shared/constants'

const internals = llamafileEmbeddingProvider as any

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

describe('LlamafileEmbeddingManager', () => {
  test('embed contract: guard, port, mapping, halving, empty-input', async () => {
    const originalFetch = global.fetch
    try {
      // ── not-ready guard: no silent fallback ──────────────────────────────
      internals._isReady = false
      internals.baseUrl = null
      await assert.rejects(
        () => llamafileEmbeddingProvider.embed(['hello']),
        /not ready/,
        'embed() must reject before initialize()'
      )

      // ── free ephemeral port selection ────────────────────────────────────
      const port = (await internals.findFreePort()) as number
      assert.equal(typeof port, 'number')
      assert.ok(port > 0 && port < 65536, `expected a valid port, got ${port}`)

      // Force the singleton into a "ready" state pointing at a dummy server.
      internals._isReady = true
      internals.baseUrl = 'http://127.0.0.1:65000'

      // ── response mapping + index ordering ────────────────────────────────
      global.fetch = (async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: [4, 5, 6] },
            { index: 0, embedding: [1, 2, 3] }
          ]
        })) as FetchFn
      const ordered = await llamafileEmbeddingProvider.embed(['a', 'b'])
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
      // manager should recursively split until every text is embedded alone.
      global.fetch = (async (_url: string, init?: RequestInit) => {
        const input = parseInput(init)
        if (input.length > 1) throw new Error('simulated oversized-batch failure')
        return jsonResponse({ data: [{ index: 0, embedding: [input[0].length] }] })
      }) as FetchFn
      const halved = await llamafileEmbeddingProvider.embed(['xx', 'y', 'zzz'])
      assert.deepEqual(halved, [[2], [1], [3]], 'each text must be embedded after splitting')

      // ── empty input short-circuits without calling fetch ─────────────────
      let called = false
      global.fetch = (async () => {
        called = true
        return jsonResponse({ data: [] })
      }) as FetchFn
      const empty = await llamafileEmbeddingProvider.embed([])
      assert.deepEqual(empty, [])
      assert.equal(called, false, 'embed([]) must not hit the server')

      // ── length-mismatch guard: short/empty data on a 200 must not corrupt ──
      // Server returns fewer items than inputs; a single text can't be halved,
      // so the guard must surface a hard error rather than misaligned vectors.
      global.fetch = (async () => jsonResponse({ data: [] })) as FetchFn
      await assert.rejects(
        () => llamafileEmbeddingProvider.embed(['solo']),
        /returned 0 valid embeddings for 1/,
        'embed() must reject when the server returns fewer embeddings than inputs'
      )

      // ── oversized-input cap: truncate to maxInputChars before sending ─────
      const cap = LLAMAFILE_EMBEDDING.server.maxInputChars
      let sentInput: string[] = []
      global.fetch = (async (_url: string, init?: RequestInit) => {
        sentInput = parseInput(init)
        return jsonResponse({ data: sentInput.map((s, i) => ({ index: i, embedding: [s.length] })) })
      }) as FetchFn
      const big = 'x'.repeat(cap * 3)
      const capped = await llamafileEmbeddingProvider.embed([big])
      assert.equal(sentInput[0].length, cap, 'oversized input must be truncated to maxInputChars')
      assert.deepEqual(capped, [[cap]], 'embed() returns a vector for the (capped) input')
    } finally {
      global.fetch = originalFetch
      internals._isReady = false
      internals.baseUrl = null
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for ollama-manager.service.ts — status detection, NDJSON pull
 * progress parsing, and batch embed.
 *
 * `fetch` is stubbed on globalThis. The harness runs async tests concurrently,
 * so the whole suite is consolidated into one sequential test to avoid races on
 * the shared global. startOllama (OS-level) is intentionally not tested.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { ollamaManager } from '../ollama-manager.service'

type FetchFn = typeof globalThis.fetch

function jsonRes(obj: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  } as unknown as Response
}

function streamRes(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
  return { ok: true, status: 200, body: stream } as unknown as Response
}

describe('OllamaManagerService', () => {
  test('isRemote distinguishes loopback from remote hosts', () => {
    assert.equal(ollamaManager.isRemote('127.0.0.1'), false)
    assert.equal(ollamaManager.isRemote('localhost'), false)
    assert.equal(ollamaManager.isRemote('192.168.1.50'), true)
  })

  test('fetch-backed flows (sequential)', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        // ── checkStatus: running with models ──
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/api/version')) return jsonRes({ version: '0.5.1' })
          if (u.includes('/api/tags'))
            return jsonRes({ models: [{ name: 'qwen3' }, { name: 'llama3' }] })
          throw new Error(`unexpected url ${u}`)
        }) as FetchFn
        const status = await ollamaManager.checkStatus()
        assert.equal(status.running, true)
        assert.equal(status.installed, true)
        assert.equal(status.version, '0.5.1')
        assert.deepEqual(status.models, ['qwen3', 'llama3'])

        // ── checkStatus: server down (remote URL skips PATH/execSync probe) ──
        globalThis.fetch = (async () => {
          throw new Error('ECONNREFUSED')
        }) as FetchFn
        const down = await ollamaManager.checkStatus('http://192.168.9.9:11434')
        assert.equal(down.running, false)
        assert.equal(down.installed, false)

        // ── pullModel: NDJSON progress (split across chunks) + complete ──
        globalThis.fetch = (async () =>
          streamRes([
            '{"status":"pulling","completed":50,"total":100}\n{"sta',
            'tus":"verifying"}\n'
          ])) as FetchFn
        const progresses: number[] = []
        const onProgress = (p: { percent: number }): void => {
          progresses.push(p.percent)
        }
        let completed = false
        const onComplete = (): void => {
          completed = true
        }
        ollamaManager.on('pullProgress', onProgress)
        ollamaManager.on('pullComplete', onComplete)
        await ollamaManager.pullModel('qwen3')
        ollamaManager.off('pullProgress', onProgress)
        ollamaManager.off('pullComplete', onComplete)
        assert.ok(progresses.includes(50), 'percent = round(50/100*100)')
        assert.equal(completed, true)

        // ── pullModel: error line emits pullError ──
        globalThis.fetch = (async () => streamRes(['{"error":"manifest not found"}\n'])) as FetchFn
        let pullErr = ''
        const onErr = (e: string): void => {
          pullErr = e
        }
        ollamaManager.on('pullError', onErr)
        await ollamaManager.pullModel('bad-model')
        ollamaManager.off('pullError', onErr)
        assert.equal(pullErr, 'manifest not found')

        // ── embed: returns the embeddings array ──
        globalThis.fetch = (async () => jsonRes({ embeddings: [[0.1, 0.2, 0.3]] })) as FetchFn
        const vecs = await ollamaManager.embed('nomic', ['hello'])
        assert.deepEqual(vecs, [[0.1, 0.2, 0.3]])

        // ── embed: non-ok response rejects ──
        globalThis.fetch = (async () => jsonRes({ error: 'no model' }, false, 404)) as FetchFn
        await assert.rejects(() => ollamaManager.embed('missing', ['x']))
      } finally {
        globalThis.fetch = originalFetch
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for omlx-manager.service.ts — status detection with the admin→auth
 * →/v1/models fallback chain, Set-Cookie session parsing, and model-list mapping.
 *
 * `fetch` is stubbed on globalThis; the suite is consolidated into one sequential
 * test to avoid races on the shared global. startOmlx (OS-level) is not tested.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { omlxManager } from '../omlx-manager.service'

type FetchFn = typeof globalThis.fetch

function res(opts: {
  ok?: boolean
  status?: number
  json?: unknown
  setCookie?: string
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json ?? {},
    text: async () => JSON.stringify(opts.json ?? {}),
    headers: {
      get: (h: string) => (h.toLowerCase() === 'set-cookie' ? (opts.setCookie ?? null) : null)
    }
  } as unknown as Response
}

describe('OmlxManagerService', () => {
  test('getAdminUrl builds the admin dashboard URL', () => {
    assert.equal(omlxManager.getAdminUrl('http://host:8000'), 'http://host:8000/admin')
    assert.equal(omlxManager.getAdminUrl(), 'http://127.0.0.1:8000/admin')
  })

  test('fetch-backed status flows (sequential)', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        // ── admin API success: maps loaded + allModels ──
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api/models')) {
            return res({
              json: {
                models: [
                  {
                    id: 'qwen-7b',
                    loaded: true,
                    is_loading: false,
                    estimated_size_formatted: '4GB',
                    pinned: true,
                    is_default: true,
                    model_type: 'mlx'
                  },
                  {
                    id: 'llama-13b',
                    loaded: false,
                    is_loading: true,
                    estimated_size_formatted: '8GB',
                    pinned: false,
                    is_default: false,
                    model_type: 'mlx'
                  }
                ]
              }
            })
          }
          throw new Error(`unexpected ${u}`)
        }) as FetchFn
        const adminStatus = await omlxManager.checkStatus()
        assert.equal(adminStatus.running, true)
        assert.deepEqual(adminStatus.models, ['qwen-7b']) // only loaded
        assert.equal(adminStatus.allModels?.length, 2)
        assert.equal(adminStatus.allModels?.[1].isLoading, true)

        // ── admin returns 401 → fall back to /v1/models ──
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api/models')) return res({ ok: false, status: 401 })
          if (u.includes('/v1/models')) return res({ json: { data: [{ id: 'm1' }, { id: 'm2' }] } })
          throw new Error(`unexpected ${u}`)
        }) as FetchFn
        const v1Status = await omlxManager.checkStatus()
        assert.equal(v1Status.running, true)
        assert.deepEqual(v1Status.models, ['m1', 'm2'])

        // ── apiKey path: admin login Set-Cookie parsing, then admin models ──
        const seenCookies: Array<string | undefined> = []
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const u = String(input)
          if (u.includes('/admin/api/login')) {
            return res({ status: 302, ok: false, setCookie: 'session=abc123; Path=/; HttpOnly' })
          }
          if (u.includes('/admin/api/models')) {
            const headers = (init?.headers ?? {}) as Record<string, string>
            seenCookies.push(headers['Cookie'])
            return res({ json: { models: [] } })
          }
          throw new Error(`unexpected ${u}`)
        }) as FetchFn
        const authed = await omlxManager.checkStatus('http://127.0.0.1:8000', 'my-key')
        assert.equal(authed.running, true)
        assert.equal(
          seenCookies[0],
          'session=abc123',
          'session cookie forwarded to admin models call'
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    }))

  // ── Diagnostics tests ──

  test('checkStatus returns diagnostics when admin API returns 401 (no key)', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api/models')) return res({ ok: false, status: 401 })
          if (u.includes('/v1/models'))
            return res({ json: { data: [{ id: 'model-1' }] } })
          throw new Error(`unexpected ${u}`)
        }) as FetchFn

        const status = await omlxManager.checkStatus()
        assert.equal(status.running, true)
        assert.equal(status.diagnostics?.adminAuthRequired, true)
        assert.equal(status.diagnostics?.adminHttpStatus, 401)
        assert.ok(status.diagnostics?.errorDetail?.includes('API key required'))
      } finally {
        globalThis.fetch = originalFetch
      }
    }))

  test('checkStatus returns diagnostics when admin API returns 401 (wrong key)', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api/login')) return res({ ok: false, status: 401 })
          if (u.includes('/admin/api/models')) return res({ ok: false, status: 401 })
          if (u.includes('/v1/models'))
            return res({ json: { data: [{ id: 'model-1' }] } })
          throw new Error(`unexpected ${u}`)
        }) as FetchFn

        const status = await omlxManager.checkStatus('http://127.0.0.1:8000', 'wrong-key')
        assert.equal(status.running, true)
        assert.equal(status.diagnostics?.adminAuthRequired, true)
        assert.ok(status.diagnostics?.errorDetail?.includes('rejected'))
      } finally {
        globalThis.fetch = originalFetch
      }
    }))

  test('checkStatus returns timeout diagnostics when admin API times out', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api')) {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            throw err
          }
          if (u.includes('/v1/models')) return res({ json: { data: [] } })
          throw new Error(`unexpected ${u}`)
        }) as FetchFn

        const status = await omlxManager.checkStatus()
        assert.equal(status.running, true)
        assert.equal(status.diagnostics?.timedOut, true)
        assert.ok(status.diagnostics?.errorDetail?.includes('timed out'))
      } finally {
        globalThis.fetch = originalFetch
      }
    }))

  test('checkStatus synthesizes embedding type from model name patterns', () =>
    runExclusive(async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input)
          if (u.includes('/admin/api')) return res({ ok: false, status: 404 })
          if (u.includes('/v1/models')) {
            return res({
              json: {
                data: [
                  { id: 'bge-m3-mlx-8bit' },
                  { id: 'Qwen3-30B-A3B-4bit' },
                  { id: 'nomic-embed-text-v1.5' },
                  { id: 'gemma-3-27b-it' }
                ]
              }
            })
          }
          throw new Error(`unexpected ${u}`)
        }) as FetchFn

        const status = await omlxManager.checkStatus()
        assert.equal(status.running, true)
        assert.equal(status.allModels?.length, 4)

        const types = status.allModels!.map((m) => `${m.id}=${m.modelType}`)
        assert.deepEqual(types, [
          'bge-m3-mlx-8bit=embedding',
          'Qwen3-30B-A3B-4bit=llm',
          'nomic-embed-text-v1.5=embedding',
          'gemma-3-27b-it=llm'
        ])
      } finally {
        globalThis.fetch = originalFetch
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for context-window-resolver.ts — the resolution chain
 * (user override → backend API → known model table → 32768 fallback) plus
 * the oMLX / Ollama field mapping.
 *
 * `globalThis.fetch` is stubbed for the backend-query tests. Because the harness
 * runs async tests concurrently, every fetch-swapping body is wrapped in
 * `runExclusive()` so it joins the shared mutex used by the ollama/omlx suites.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { ContextWindowResolver } from '../context-window-resolver'
import type { LocalLLMConfig } from '../../../shared/types'

type FetchFn = typeof globalThis.fetch

function cfg(overrides: Partial<LocalLLMConfig> = {}): LocalLLMConfig {
  return {
    provider: 'local',
    backend: 'ollama',
    localModel: 'some-model',
    localHost: '127.0.0.1',
    localPort: 11434,
    ...overrides
  } as LocalLLMConfig
}

function jsonRes(obj: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => obj } as unknown as Response
}

const resolver = new ContextWindowResolver()

describe('context-window-resolver › fromKnownModels', () => {
  test('hits on a known ollamaId', () => {
    // qwen3.6 coding model advertises a 262144 native window in the table.
    assert.equal(resolver.fromKnownModels('qwen3.6:35b-a3b-coding-nvfp4'), 262144)
  })

  test('hits on a known omlxId', () => {
    assert.equal(
      resolver.fromKnownModels('mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'),
      32768
    )
  })

  test('misses on an unknown model → null', () => {
    assert.equal(resolver.fromKnownModels('totally-unknown-model:99b'), null)
  })
})

describe('context-window-resolver › queryOmlxContext field mapping', () => {
  test('maps context_window from matching model', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          assert.match(String(input), /\/admin\/api\/models$/)
          return jsonRes({ models: [{ id: 'my-model', context_window: 131072 }] })
        }) as FetchFn
        const value = await resolver.queryOmlxContext(cfg({ localModel: 'my-model' }))
        assert.equal(value, 131072)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('falls back to max_context_window when context_window is absent', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () =>
          jsonRes({ models: [{ id: 'my-model', max_context_window: 65536 }] })) as FetchFn
        const value = await resolver.queryOmlxContext(cfg({ localModel: 'my-model' }))
        assert.equal(value, 65536)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('returns null when no model matches / response not ok', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () => jsonRes({}, false)) as FetchFn
        const value = await resolver.queryOmlxContext(cfg({ localModel: 'my-model' }))
        assert.equal(value, null)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('returns null when fetch throws', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () => {
          throw new Error('ECONNREFUSED')
        }) as FetchFn
        const value = await resolver.queryOmlxContext(cfg())
        assert.equal(value, null)
      } finally {
        globalThis.fetch = original
      }
    }))
})

describe('context-window-resolver › queryOllamaContext field mapping', () => {
  test('maps details.context_length from a name-matched model', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          assert.match(String(input), /\/api\/ps$/)
          return jsonRes({
            models: [{ name: 'llama3:latest', details: { context_length: 8192 } }]
          })
        }) as FetchFn
        const value = await resolver.queryOllamaContext(cfg({ localModel: 'llama3' }))
        assert.equal(value, 8192)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('returns null when no running model matches the name', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () =>
          jsonRes({ models: [{ name: 'other:latest', details: { context_length: 4096 } }] })) as FetchFn
        const value = await resolver.queryOllamaContext(cfg({ localModel: 'llama3' }))
        assert.equal(value, null)
      } finally {
        globalThis.fetch = original
      }
    }))
})

describe('context-window-resolver › resolve chain ordering', () => {
  test('1. user override wins over everything', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        // fetch should never be consulted when an override is present.
        globalThis.fetch = (async () => {
          throw new Error('fetch must not be called')
        }) as FetchFn
        const value = await resolver.resolve(cfg(), 96000)
        assert.equal(value, 96000)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('ignores a non-positive override and continues the chain', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () =>
          jsonRes({ models: [{ name: 'llama3', details: { context_length: 16384 } }] })) as FetchFn
        const value = await resolver.resolve(cfg({ localModel: 'llama3' }), 0)
        assert.equal(value, 16384) // came from the backend query, not the 0 override
      } finally {
        globalThis.fetch = original
      }
    }))

  test('2. backend query (omlx) used when no override', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () =>
          jsonRes({ models: [{ id: 'm', context_window: 200000 }] })) as FetchFn
        const value = await resolver.resolve(cfg({ backend: 'omlx', localModel: 'm' }))
        assert.equal(value, 200000)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('3. known model table used when backend query returns null', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () => jsonRes({ models: [] })) as FetchFn
        const value = await resolver.resolve(cfg({ localModel: 'qwen3.6:35b-a3b-coding-nvfp4' }))
        assert.equal(value, 262144)
      } finally {
        globalThis.fetch = original
      }
    }))

  test('4. hardcoded 32768 fallback for an unknown model with no backend data', () =>
    runExclusive(async () => {
      const original = globalThis.fetch
      try {
        globalThis.fetch = (async () => {
          throw new Error('down')
        }) as FetchFn
        const value = await resolver.resolve(cfg({ localModel: 'mystery-model:1t' }))
        assert.equal(value, 32768)
      } finally {
        globalThis.fetch = original
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

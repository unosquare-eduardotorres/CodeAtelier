/**
 * Ollama capability detection — the three-tier chain.
 *
 * The defect this pins down: /api/tags carries no model type, so the Models
 * page badged *every* Ollama model as an LLM and offered `bge-m3:latest` a
 * "Select as chat model" button. Selecting it did nothing, because an embedding
 * model cannot answer a chat turn.
 *
 * Detection must therefore be honest about *how* it decided:
 *   1. /api/show `capabilities`   — authoritative
 *   2. /api/tags `details.family` — free, already in a response we were discarding
 *   3. the model's name           — a guess, and labelled as one
 *
 * Run: tsx src/main/services/__tests__/ollama-capability-detection.test.ts
 */
import assert from 'node:assert/strict'
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync, runExclusive } from './test-harness'

setupElectronStub()

const {
  ollamaManager,
  capabilityFromApiShow,
  capabilityFromFamily,
  capabilityFromName
} = require('../ollama-manager.service')

type TagEntry = { name: string; digest: string; family?: string }

interface StubOptions {
  /** name → capabilities array, or 'fail' for a non-OK response, or 'hang' to throw. */
  show?: Record<string, string[] | 'fail' | 'hang'>
  /** Raw /api/tags model entries. */
  tags?: unknown[]
  version?: string
}

interface StubResult {
  showCalls: string[]
  tagCalls: number
}

/**
 * Swap globalThis.fetch for the duration of `fn`. Serialised through the
 * harness mutex — the harness starts async tests concurrently and this is a
 * process-global.
 */
function withFetch<T>(opts: StubOptions, fn: (calls: StubResult) => Promise<T>): Promise<T> {
  return runExclusive(async () => {
    const previous = globalThis.fetch
    const calls: StubResult = { showCalls: [], tagCalls: 0 }

    globalThis.fetch = (async (input: string, init?: { body?: string }) => {
      const url = String(input)

      if (url.endsWith('/api/version')) {
        return { ok: true, json: async () => ({ version: opts.version ?? '0.5.0' }) }
      }

      if (url.endsWith('/api/tags')) {
        calls.tagCalls++
        return { ok: true, json: async () => ({ models: opts.tags ?? [] }) }
      }

      if (url.endsWith('/api/show')) {
        const model = JSON.parse(init?.body ?? '{}').model as string
        calls.showCalls.push(model)
        const answer = opts.show?.[model]
        if (answer === 'hang') throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        if (answer === 'fail' || answer === undefined) return { ok: false, status: 404 }
        return { ok: true, json: async () => ({ capabilities: answer }) }
      }

      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof globalThis.fetch

    try {
      ollamaManager.clearCapabilityCache()
      return await fn(calls)
    } finally {
      globalThis.fetch = previous
      ollamaManager.clearCapabilityCache()
    }
  })
}

const tag = (name: string, digest = 'd1', family?: string): TagEntry => ({ name, digest, family })

describe('capabilityFromApiShow — tier 1', () => {
  test('capabilities:["embedding"] is an embedding model', () => {
    assert.equal(capabilityFromApiShow(['embedding']), 'embedding')
  })

  test('capabilities:["completion"] is a chat model', () => {
    assert.equal(capabilityFromApiShow(['completion']), 'chat')
  })

  test('a vision model is reported as vision, not plain chat', () => {
    assert.equal(capabilityFromApiShow(['completion', 'vision']), 'vision')
  })

  test('an absent or empty capabilities field decides nothing', () => {
    assert.equal(capabilityFromApiShow(undefined), null)
    assert.equal(capabilityFromApiShow([]), null)
    assert.equal(capabilityFromApiShow(null), null)
  })

  test('an unrecognised capability decides nothing rather than guessing', () => {
    assert.equal(capabilityFromApiShow(['thinking']), null)
  })
})

describe('capabilityFromFamily — tier 2', () => {
  test('family "bert" is an embedding model', () => {
    assert.equal(capabilityFromFamily('bert'), 'embedding')
  })

  test('family "nomic-bert" is an embedding model', () => {
    assert.equal(capabilityFromFamily('nomic-bert'), 'embedding')
  })

  test('family matching is case-insensitive', () => {
    assert.equal(capabilityFromFamily('BERT'), 'embedding')
  })

  /**
   * One-directional on purpose. EmbeddingGemma reports family 'gemma3'; if an
   * unrecognised family asserted chat, tier 2 would confidently mislabel it and
   * tier 3 (which reads the name and gets it right) would never run.
   */
  test('an unrecognised family asserts nothing — it does not imply chat', () => {
    assert.equal(capabilityFromFamily('llama'), null)
    assert.equal(capabilityFromFamily('gemma3'), null)
    assert.equal(capabilityFromFamily(undefined), null)
  })
})

describe('capabilityFromName — tier 3', () => {
  test('bge-m3:latest reads as an embedding model', () => {
    assert.equal(capabilityFromName('bge-m3:latest'), 'embedding')
  })

  test('nomic-embed-text reads as an embedding model', () => {
    assert.equal(capabilityFromName('nomic-embed-text'), 'embedding')
  })

  test('a coding model reads as chat', () => {
    assert.equal(capabilityFromName('qwen2.5-coder:32b'), 'chat')
  })
})

describe('classifyModels — tier precedence', () => {
  test('/api/show wins over a contradicting name', async () => {
    await withFetch({ show: { 'weird-name:latest': ['embedding'] } }, async () => {
      const [info] = await ollamaManager.classifyModels(
        [tag('weird-name:latest')],
        'http://h:11434'
      )
      assert.equal(info.capability, 'embedding')
      assert.equal(info.detectedVia, 'api-show')
    })
  })

  test('family answers when /api/show has no capabilities field', async () => {
    await withFetch({ show: { 'mystery:latest': 'fail' } }, async () => {
      const [info] = await ollamaManager.classifyModels(
        [tag('mystery:latest', 'd1', 'bert')],
        'http://h:11434'
      )
      assert.equal(info.capability, 'embedding')
      assert.equal(info.detectedVia, 'family')
    })
  })

  /**
   * The whole point of the fallback chain: a probe that never answers must not
   * block the list, and must not be reported as if it had answered.
   */
  test('an /api/show timeout falls through to the name heuristic', async () => {
    await withFetch({ show: { 'bge-m3:latest': 'hang' } }, async () => {
      const [info] = await ollamaManager.classifyModels(
        [tag('bge-m3:latest', 'd1', 'llama')],
        'http://h:11434'
      )
      assert.equal(info.capability, 'embedding')
      assert.equal(info.detectedVia, 'name-heuristic', 'must not claim it asked the server')
    })
  })

  test('a chat model with nothing but a name is chat, marked as assumed', async () => {
    await withFetch({ show: { 'qwen3:8b': 'fail' } }, async () => {
      const [info] = await ollamaManager.classifyModels([tag('qwen3:8b')], 'http://h:11434')
      assert.equal(info.capability, 'chat')
      assert.equal(info.detectedVia, 'name-heuristic')
    })
  })

  test('carries name, digest and family through untouched', async () => {
    await withFetch({ show: { 'a:1': ['completion'] } }, async () => {
      const [info] = await ollamaManager.classifyModels(
        [tag('a:1', 'sha256:abc', 'llama')],
        'http://h:11434'
      )
      assert.deepEqual(
        { name: info.name, digest: info.digest, family: info.family },
        { name: 'a:1', digest: 'sha256:abc', family: 'llama' }
      )
    })
  })

  test('an empty model list issues no probes at all', async () => {
    await withFetch({}, async (calls) => {
      assert.deepEqual(await ollamaManager.classifyModels([], 'http://h:11434'), [])
      assert.equal(calls.showCalls.length, 0)
    })
  })
})

describe('classifyModels — cache', () => {
  test('a second call with the same digest does not re-probe', async () => {
    await withFetch({ show: { 'a:1': ['completion'] } }, async (calls) => {
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://h:11434')
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://h:11434')
      assert.deepEqual(calls.showCalls, ['a:1'], 'second call must be served from cache')
    })
  })

  /** A re-pulled tag keeps its name but changes digest — the cache must miss. */
  test('a changed digest invalidates the cached capability', async () => {
    await withFetch({ show: { 'a:1': ['completion'] } }, async (calls) => {
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://h:11434')
      await ollamaManager.classifyModels([tag('a:1', 'sha-2')], 'http://h:11434')
      assert.deepEqual(calls.showCalls, ['a:1', 'a:1'], 'a re-pulled model must be re-probed')
    })
  })

  test('the same model on a different server is probed separately', async () => {
    await withFetch({ show: { 'a:1': ['completion'] } }, async (calls) => {
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://one:11434')
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://two:11434')
      assert.equal(calls.showCalls.length, 2)
    })
  })

  /**
   * A guess made while the server was unreachable must not outlive the outage,
   * or the model stays mislabelled for the rest of the process.
   */
  test('a name-heuristic guess is never cached', async () => {
    await withFetch({ show: { 'a:1': 'hang' } }, async (calls) => {
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://h:11434')
      await ollamaManager.classifyModels([tag('a:1', 'sha-1')], 'http://h:11434')
      assert.equal(calls.showCalls.length, 2, 'a guess must be retried, not remembered')
    })
  })
})

describe('checkStatus — model details', () => {
  test('keeps digest and family instead of mapping tags down to names', async () => {
    await withFetch(
      {
        tags: [
          { name: 'qwen3:8b', digest: 'sha-q', details: { family: 'qwen3' } },
          { name: 'bge-m3:latest', digest: 'sha-b', details: { family: 'bert' } }
        ],
        show: { 'qwen3:8b': 'fail', 'bge-m3:latest': 'fail' }
      },
      async () => {
        const status = await ollamaManager.checkStatus('http://h:11434')
        assert.deepEqual(status.models, ['qwen3:8b', 'bge-m3:latest'])

        const details = status.modelDetails as { name: string; capability: string }[]
        assert.equal(details.length, 2)
        assert.equal(details.find((d) => d.name === 'bge-m3:latest')?.capability, 'embedding')
        assert.equal(details.find((d) => d.name === 'qwen3:8b')?.capability, 'chat')
      }
    )
  })

  test('modelDetails is absent — not empty — when the server is unreachable', async () => {
    await runExclusive(async () => {
      const previous = globalThis.fetch
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof globalThis.fetch
      try {
        const status = await ollamaManager.checkStatus('http://127.0.0.1:1')
        assert.equal(status.running, false)
        assert.equal(status.modelDetails, undefined)
      } finally {
        globalThis.fetch = previous
      }
    })
  })
})

if (process.argv[1]?.includes('ollama-capability-detection')) {
  void summaryAsync()
}

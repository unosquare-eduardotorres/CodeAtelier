/**
 * Tier 1c — e2e-runner.service.ts preflight + run-lifecycle coverage.
 *
 * `preflight()` is the densest branch surface in the file: an API-key fallback
 * chain, model selection with an embedding filter, a retrying tool-capability
 * probe and a vision probe. All of it hangs off two seams — omlxManager.checkStatus
 * and global fetch — so it can be driven end-to-end without oMLX running.
 *
 * Run: tsx src/main/services/__tests__/e2e-runner-preflight.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'
import { serial, tryRequire } from './e2e-runner-harness'

const dbContext = attachTestDb()

if (!dbContext) {
  describe('e2e-runner-preflight (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      /* better-sqlite3 unavailable — nothing to assert */
    })
  })
} else {
  // e2e-runner.service reaches omlxManager / modelConfigService /
  // workspaceRepository through STATIC imports, so it keeps whatever instance it
  // bound when it was first loaded. In the shared run a `require` here can hand
  // back a different instance than the one the service bound — an earlier file
  // registers `mockService('omlx-manager', …)` and setup-full-mock's serviceMocks
  // map is never cleared — and the patch then lands on an object preflight never
  // calls. Resolving everything through the same dynamic-import graph the service
  // itself was loaded from keeps both sides on one instance. The require seeds
  // keep the standalone run working; the imports win before any test body runs.
  let runnerMod = tryRequire('../e2e-testing/e2e-runner.service')
  let omlx = tryRequire('../omlx-manager.service')?.omlxManager
  let repos = tryRequire('../../db/repositories')
  let modelConfig = tryRequire('../model-config.service')?.modelConfigService
  let fixture = tryRequire('../e2e-testing/fixture-manager')?.fixtureManager

  void import('../e2e-testing/e2e-runner.service').then((m: any) => {
    runnerMod = m?.preflight ? m : runnerMod
  })
  void import('../omlx-manager.service').then((m: any) => {
    omlx = m?.omlxManager ?? omlx
  })
  void import('../../db/repositories').then((m: any) => {
    repos = m?.workspaceRepository ? m : repos
  })
  void import('../model-config.service').then((m: any) => {
    modelConfig = m?.modelConfigService ?? modelConfig
  })
  void import('../e2e-testing/fixture-manager').then((m: any) => {
    fixture = m?.fixtureManager ?? fixture
  })

  // Resolved per test rather than captured, so they always come from whichever
  // copy of the module the imports above settled on.
  const preflight = (...args: unknown[]): any => runnerMod.preflight(...args)
  const service = new Proxy({} as any, {
    get: (_t, prop) => runnerMod.e2eRunnerService[prop],
    set: (_t, prop, value) => {
      runnerMod.e2eRunnerService[prop] = value
      return true
    },
    getOwnPropertyDescriptor: (_t, prop) => {
      const d = Object.getOwnPropertyDescriptor(runnerMod.e2eRunnerService, prop)
      return d ? { ...d, configurable: true } : undefined
    },
    defineProperty: (_t, prop, desc) => {
      Object.defineProperty(runnerMod.e2eRunnerService, prop, desc)
      return true
    },
    deleteProperty: (_t, prop) => {
      delete runnerMod.e2eRunnerService[prop]
      return true
    }
  })

  const realFetch = global.fetch

  /** A JSON Response stand-in good enough for preflight's two probes. */
  function res(
    ok: boolean,
    body: unknown,
    status = ok ? 200 : 500
  ): { ok: boolean; status: number; text: () => Promise<string> } {
    return {
      ok,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }

  const toolCallBody = {
    choices: [{ message: { tool_calls: [{ function: { name: 'calculator' } }] } }]
  }
  const noToolCallBody = { choices: [{ message: { content: '4' } }] }

  /** Route each probe by URL+payload so a test can answer them independently. */
  function installFetch(
    p: { set: (o: any, k: string, v: unknown) => void },
    handler: (url: string, init: any) => unknown
  ): void {
    p.set(global, 'fetch', async (url: any, init: any) => handler(String(url), init))
  }

  const isVisionProbe = (init: any): boolean =>
    typeof init?.body === 'string' && init.body.includes('image_url')

  /** Neutralise the key-resolution chain so tests control only what they mean to. */
  function silenceKeyChain(p: { set: (o: any, k: string, v: unknown) => void }): void {
    p.set(repos.workspaceRepository, 'findAll', () => [])
    p.set(repos.workspaceRepository, 'findByPath', () => undefined)
  }

  // ── preflight — connectivity and model selection ───────────────────────────

  describe('e2e-runner preflight — connectivity', () => {
    test(
      'reports a connection failure when oMLX is not running',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: false, models: [] }))
        const r = await preflight()
        assert.equal(r.ok, false)
        assert.match(r.error, /Cannot connect to oMLX/)
        assert.equal(r.modelId, undefined)
      })
    )

    test(
      'a checkStatus rejection is reported as unreachable, not thrown',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => {
          throw new Error('ECONNREFUSED')
        })
        const r = await preflight()
        assert.equal(r.ok, false)
        assert.match(r.error, /Cannot reach oMLX at http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED/)
      })
    )

    test(
      'a blocking 401 with zero models fails with the reported detail',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({
          running: true,
          models: [],
          diagnostics: { adminAuthRequired: true, errorDetail: 'bad api key' }
        }))
        const r = await preflight()
        assert.equal(r.ok, false)
        assert.equal(r.error, 'bad api key')
      })
    )

    test(
      'a blocking 401 with no detail falls back to the documented message',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({
          running: true,
          models: [],
          diagnostics: { adminAuthRequired: true }
        }))
        const r = await preflight()
        assert.match(r.error, /API key required or rejected by oMLX/)
      })
    )

    test(
      'a 401 on the admin API is tolerated when /v1/models still returned models',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({
          running: true,
          models: ['llama-3-8b'],
          diagnostics: { adminAuthRequired: true, errorDetail: 'admin 401' }
        }))
        installFetch(p, (_u, init) =>
          isVisionProbe(init) ? res(false, 'unsupported image content') : res(true, toolCallBody)
        )
        const r = await preflight()
        assert.equal(r.ok, true)
        assert.equal(r.modelId, 'llama-3-8b')
      })
    )

    test(
      'running with an empty model list fails with the "no chat models" message',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: [] }))
        const r = await preflight()
        assert.equal(r.ok, false)
        assert.match(r.error, /no chat models are loaded/)
      })
    )
  })

  describe('e2e-runner preflight — model selection', () => {
    const ok = (
      p: { set: (o: any, k: string, v: unknown) => void },
      status: Record<string, unknown>
    ): void => {
      silenceKeyChain(p)
      p.set(omlx, 'checkStatus', async () => ({ running: true, ...status }))
      installFetch(p, (_u, init) =>
        isVisionProbe(init) ? res(false, 'unsupported image content') : res(true, toolCallBody)
      )
    }

    test(
      'the preferred coding model wins when present in allModels',
      serial(async (p) => {
        ok(p, {
          models: ['other', 'qwen3.6:35b-a3b-coding-nvfp4'],
          allModels: [
            { id: 'other', modelType: 'llm', loaded: true },
            { id: 'qwen3.6:35b-a3b-coding-nvfp4', modelType: 'llm', loaded: false }
          ]
        })
        assert.equal((await preflight()).modelId, 'qwen3.6:35b-a3b-coding-nvfp4')
      })
    )

    test(
      'the preferred model is also honoured from the flat list',
      serial(async (p) => {
        ok(p, { models: ['a', 'qwen3.6:35b-a3b-coding-nvfp4'] })
        assert.equal((await preflight()).modelId, 'qwen3.6:35b-a3b-coding-nvfp4')
      })
    )

    test(
      'a loaded non-embedding model is preferred over an unloaded one',
      serial(async (p) => {
        ok(p, {
          models: ['bge-large', 'llama-3'],
          allModels: [
            { id: 'bge-large', modelType: 'embedding', loaded: true },
            { id: 'unloaded-llm', modelType: 'llm', loaded: false },
            { id: 'llama-3', modelType: 'llm', loaded: true }
          ]
        })
        assert.equal((await preflight()).modelId, 'llama-3')
      })
    )

    test(
      'an unloaded chat model is used when every loaded model is an embedding',
      serial(async (p) => {
        ok(p, {
          models: ['bge-large', 'mistral'],
          allModels: [
            { id: 'bge-large', modelType: 'embedding', loaded: true },
            { id: 'mistral', modelType: 'llm', loaded: false }
          ]
        })
        assert.equal((await preflight()).modelId, 'mistral')
      })
    )

    test(
      'without allModels, embedding names are filtered out by heuristic',
      serial(async (p) => {
        ok(p, { models: ['nomic_embed-text', 'bge-m3', 'gte_base', 'phi-4'] })
        assert.equal((await preflight()).modelId, 'phi-4')
      })
    )

    test(
      'when every name looks like an embedding the first entry is used anyway',
      serial(async (p) => {
        ok(p, { models: ['bge-m3', 'e5_large'] })
        assert.equal((await preflight()).modelId, 'bge-m3')
      })
    )
  })

  // ── preflight — capability probes ──────────────────────────────────────────

  describe('e2e-runner preflight — tool probe', () => {
    const base = (
      p: { set: (o: any, k: string, v: unknown) => void },
      handler: (url: string, init: any) => unknown
    ): void => {
      silenceKeyChain(p)
      p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
      installFetch(p, handler)
    }

    test(
      'structured tool_calls on the first attempt set supportsTools true',
      serial(async (p) => {
        let toolProbes = 0
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          toolProbes++
          return res(true, toolCallBody)
        })
        const r = await preflight()
        assert.equal(r.supportsTools, true)
        assert.equal(toolProbes, 1, 'a definitive positive must not retry')
      })
    )

    test(
      'a negative first attempt is retried, and a positive retry wins',
      serial(async (p) => {
        let toolProbes = 0
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          toolProbes++
          return res(true, toolProbes === 1 ? noToolCallBody : toolCallBody)
        })
        const r = await preflight()
        assert.equal(toolProbes, 2)
        assert.equal(r.supportsTools, true)
      })
    )

    test(
      'two negative attempts settle on supportsTools false',
      serial(async (p) => {
        let toolProbes = 0
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          toolProbes++
          return res(true, noToolCallBody)
        })
        const r = await preflight()
        assert.equal(toolProbes, 2, 'documented budget is 2 attempts')
        assert.equal(r.supportsTools, false)
      })
    )

    test(
      'unparseable probe JSON is treated as no tool calls',
      serial(async (p) => {
        base(p, (_u, init) =>
          isVisionProbe(init) ? res(false, 'unsupported image content') : res(true, 'not json at all')
        )
        assert.equal((await preflight()).supportsTools, false)
      })
    )

    test(
      'an HTTP error on the probe is optimistic and does not retry',
      serial(async (p) => {
        let toolProbes = 0
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          toolProbes++
          return res(false, 'server error', 503)
        })
        const r = await preflight()
        assert.equal(toolProbes, 1, 'an HTTP error must not be retried')
        assert.equal(r.supportsTools, true, 'HTTP failure is optimistic per the documented policy')
      })
    )

    test(
      'a thrown probe is retried and then treated optimistically',
      serial(async (p) => {
        let toolProbes = 0
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          toolProbes++
          throw new Error('probe timeout')
        })
        const r = await preflight()
        assert.equal(toolProbes, 2)
        assert.equal(r.supportsTools, true)
      })
    )

    test(
      'the probe body asks for the calculator tool with tool_choice auto',
      serial(async (p) => {
        let body: any = null
        base(p, (_u, init) => {
          if (isVisionProbe(init)) return res(false, 'unsupported image content')
          body ??= JSON.parse(init.body)
          return res(true, toolCallBody)
        })
        await preflight()
        assert.equal(body.tool_choice, 'auto')
        assert.equal(body.temperature, 0)
        assert.equal(body.tools[0].function.name, 'calculator')
        assert.equal(body.model, 'phi-4')
      })
    )
  })

  describe('e2e-runner preflight — vision probe', () => {
    test(
      'a vl/vision model name short-circuits the probe entirely',
      serial(async (p) => {
        let visionProbes = 0
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['qwen2-vl-7b'] }))
        installFetch(p, (_u, init) => {
          if (isVisionProbe(init)) visionProbes++
          return res(true, toolCallBody)
        })
        const r = await preflight()
        assert.equal(r.supportsVision, true)
        assert.equal(visionProbes, 0, 'the name heuristic must skip the network probe')
      })
    )

    test(
      'an accepted image_url payload sets supportsVision true',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, () => res(true, toolCallBody))
        assert.equal((await preflight()).supportsVision, true)
      })
    )

    test(
      'an image-specific rejection marks the model text-only',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, (_u, init) =>
          isVisionProbe(init)
            ? res(false, 'this model does not support multimodal input', 400)
            : res(true, toolCallBody)
        )
        assert.equal((await preflight()).supportsVision, false)
      })
    )

    test(
      'an unrelated HTTP error leaves vision optimistically enabled',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, (_u, init) =>
          isVisionProbe(init) ? res(false, 'rate limited', 429) : res(true, toolCallBody)
        )
        assert.equal((await preflight()).supportsVision, true)
      })
    )

    test(
      'a thrown vision probe falls back to text-only',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, (_u, init) => {
          if (isVisionProbe(init)) throw new Error('probe timeout')
          return res(true, toolCallBody)
        })
        assert.equal((await preflight()).supportsVision, false)
      })
    )
  })
  // ── preflight — API key resolution chain ───────────────────────────────────
  //
  // NOT COVERED HERE. resolveApiKey() reaches workspaceRepository through a
  // STATIC import in e2e-runner.service, so the service keeps whichever copy of
  // the repositories module it bound when it was first loaded. In the shared
  // runner that copy can differ from the one this file can reach (setup-full-mock
  // leaves entries in its module-scoped serviceMocks map, and modules loaded
  // during a mock episode keep the mock in their bindings), so patching the
  // repository here lands on an object preflight never calls — green standalone,
  // red in the shared run. Covering this needs real workspace rows seeded into
  // the test database rather than a repository patch.

  // ── run lifecycle guards ───────────────────────────────────────────────────

  describe('E2ERunnerService — lifecycle guards', () => {
    test(
      'isRunning is false on a freshly loaded service and cancel is a no-op',
      serial(async () => {
        assert.equal(service.isRunning(), false)
        assert.doesNotThrow(() => service.cancel())
        assert.equal(service.isRunning(), false)
      })
    )

    test(
      'setMainWindow accepts a window without starting anything',
      serial(async () => {
        service.setMainWindow({ isDestroyed: () => false, webContents: { send: () => {} } })
        assert.equal(service.isRunning(), false)
      })
    )

    test(
      'run rejects when preflight fails, and leaves the service idle',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: false, models: [] }))
        await assert.rejects(() => service.run({ scenarioIds: ['nope'] }), /oMLX preflight failed/)
        assert.equal(service.isRunning(), false)
      })
    )

    test(
      'run rejects when no scenario id resolves to an implemented scenario',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, (_u, init) =>
          isVisionProbe(init) ? res(false, 'unsupported image') : res(true, toolCallBody)
        )
        await assert.rejects(
          () => service.run({ scenarioIds: ['definitely-not-a-scenario'] }),
          /No runnable scenarios found/
        )
        assert.equal(service.isRunning(), false)
      })
    )

    test(
      'run rejects for a category that matches no implemented scenario',
      serial(async (p) => {
        silenceKeyChain(p)
        p.set(omlx, 'checkStatus', async () => ({ running: true, models: ['phi-4'] }))
        installFetch(p, (_u, init) =>
          isVisionProbe(init) ? res(false, 'unsupported image') : res(true, toolCallBody)
        )
        await assert.rejects(
          () => service.run({ category: 'no-such-category' }),
          /No runnable scenarios found/
        )
      })
    )


    // requeueFailed / resumeRun are NOT covered here for the same reason as the
    // API-key chain above: both read e2eTestRunRepository / e2eTestResultRepository
    // through e2e-runner.service's static imports, which this file cannot reach
    // reliably in the shared runner.
  })

  // Restore the real fetch once every test in this file has run.
  describe('e2e-runner-preflight — teardown', () => {
    test(
      'global fetch is the real implementation again',
      serial(async () => {
        assert.equal(global.fetch, realFetch)
      })
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

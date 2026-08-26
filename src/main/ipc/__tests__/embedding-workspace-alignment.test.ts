/**
 * Embedding ↔ workspace alignment.
 *
 * `localEmbeddingProvider` is a process-wide singleton documented as
 * "last-configured workspace wins". Every entry point that embeds something —
 * or that claims to *test* whether embedding works — must re-point it at the
 * workspace it was asked about first. Otherwise a semantic search silently runs
 * against another workspace's backend, and "Check Connection" answers a
 * different question from the one the user asked.
 *
 * Run: tsx src/main/ipc/__tests__/embedding-workspace-alignment.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  mockMainWindow,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

const { localEmbeddingProvider } = require('../../services/local-embedding.provider')

let indexingLoaded = false
let embeddingLoaded = false

try {
  require('../../ipc/indexing.ipc').registerIndexingIpc(mockMainWindow)
  indexingLoaded = true
} catch (err) {
  console.log(`⚠ indexing.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  require('../../ipc/embedding.ipc').registerEmbeddingIpc(mockMainWindow)
  embeddingLoaded = true
} catch (err) {
  console.log(`⚠ embedding.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

/**
 * Invoke a handler with `configureForWorkspace` shadowed on the singleton, and
 * return the workspace ids it was called with. Serialized through the harness
 * mutex because the shadow is process-global.
 *
 * The handler itself is expected to reject downstream (no index, no Ollama) —
 * what is asserted is whether alignment happened before that point.
 */
function recordAlignment(channel: string, args: unknown): Promise<string[]> {
  return runExclusive(async () => {
    const calls: string[] = []
    const previous = localEmbeddingProvider.configureForWorkspace
    localEmbeddingProvider.configureForWorkspace = (workspaceId: string): void => {
      calls.push(workspaceId)
    }
    try {
      await tryInvokeHandler(channel, args)
    } finally {
      localEmbeddingProvider.configureForWorkspace = previous
    }
    return calls
  })
}

if (indexingLoaded) {
  describe('semanticSearch:query — workspace alignment', () => {
    test('configures the facade for the workspace being searched', async () => {
      const calls = await recordAlignment('semanticSearch:query', {
        workspaceId: 'ws-search',
        query: 'find me things'
      })
      assert.deepEqual(calls, ['ws-search'])
    })

    test('re-points the facade on a search against a different workspace', async () => {
      await recordAlignment('semanticSearch:query', { workspaceId: 'ws-a', query: 'q' })
      const second = await recordAlignment('semanticSearch:query', {
        workspaceId: 'ws-b',
        query: 'q'
      })
      assert.deepEqual(second, ['ws-b'], 'second search must re-point at its own workspace')
    })
  })
}

if (embeddingLoaded) {
  describe('embedding:initialize — workspace alignment', () => {
    test('configures the facade for the requested workspace before probing', async () => {
      const calls = await recordAlignment('embedding:initialize', { workspaceId: 'ws-probe' })
      assert.deepEqual(calls, ['ws-probe'])
    })

    test('omitting workspaceId leaves the facade untouched (back-compat)', async () => {
      const calls = await recordAlignment('embedding:initialize', undefined)
      assert.deepEqual(calls, [])
    })
  })

  describe('models:runtimeStatus', () => {
    test('reports live facade state and saved-vs-loaded drift', async () => {
      const r = await tryInvokeHandler('models:runtimeStatus', { workspaceId: 'ws-1' })
      assert.ok(r.ok, `handler should resolve: ${r.ok ? '' : r.error.message}`)
      const status = r.result as {
        embedding: { activeBackend: string; drift: boolean; savedBackend: string }
        chat: { plan: unknown; build: unknown }
        reachability: { ollamaRunning: boolean; omlxRunning: boolean }
      }
      assert.ok(['omlx', 'ollama'].includes(status.embedding.activeBackend))
      assert.ok(['omlx', 'ollama'].includes(status.embedding.savedBackend))
      assert.equal(typeof status.embedding.drift, 'boolean')
      assert.ok('plan' in status.chat && 'build' in status.chat)
      assert.equal(typeof status.reachability.ollamaRunning, 'boolean')
      assert.equal(typeof status.reachability.omlxRunning, 'boolean')
    })
  })
}

if (process.argv[1]?.includes('embedding-workspace-alignment')) {
  void summaryAsync()
}

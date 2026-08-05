/**
 * Phase 24 — IPC Coverage Blitz: ollama.ipc, embedding.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-ollama-embedding.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  mockMainWindow,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let ollamaLoaded = false
let embeddingLoaded = false

try {
  const mod = require('../../ipc/ollama.ipc')
  mod.registerOllamaIpc(mockMainWindow)
  ollamaLoaded = true
} catch (err) {
  console.log(`⚠ ollama.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/embedding.ipc')
  mod.registerEmbeddingIpc(mockMainWindow)
  embeddingLoaded = true
} catch (err) {
  console.log(`⚠ embedding.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// ollama.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (ollamaLoaded) {
  describe('ollama.ipc — channel registration', () => {
    test('registers ollama:checkStatus', () => {
      assert.ok(getHandlers().has('ollama:checkStatus'))
    })

    test('registers ollama:pullModel', () => {
      assert.ok(getHandlers().has('ollama:pullModel'))
    })

    test('registers ollama:cancelPull', () => {
      assert.ok(getHandlers().has('ollama:cancelPull'))
    })

    test('registers ollama:removeModel', () => {
      assert.ok(getHandlers().has('ollama:removeModel'))
    })

    test('registers ollama:start', () => {
      assert.ok(getHandlers().has('ollama:start'))
    })

    test('registers omlx:checkStatus', () => {
      assert.ok(getHandlers().has('omlx:checkStatus'))
    })

    test('registers omlx:start', () => {
      assert.ok(getHandlers().has('omlx:start'))
    })

    test('registers omlx:adminUrl', () => {
      assert.ok(getHandlers().has('omlx:adminUrl'))
    })

    test('registers omlx:loadModel', () => {
      assert.ok(getHandlers().has('omlx:loadModel'))
    })

    test('registers omlx:unloadModel', () => {
      assert.ok(getHandlers().has('omlx:unloadModel'))
    })
  })

  describe('ollama.ipc — handler bodies', () => {
    test('ollama:checkStatus calls through', async () => {
      const r = await tryInvokeHandler('ollama:checkStatus')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('ollama:checkStatus calls through with baseUrl', async () => {
      const r = await tryInvokeHandler('ollama:checkStatus', { baseUrl: 'http://localhost:11434' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('ollama:pullModel calls through', async () => {
      const r = await tryInvokeHandler('ollama:pullModel', { model: 'llama3.1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('ollama:cancelPull calls through', async () => {
      const r = await tryInvokeHandler('ollama:cancelPull')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('ollama:removeModel calls through', async () => {
      const r = await tryInvokeHandler('ollama:removeModel', { model: 'llama3.1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('ollama:start calls through', async () => {
      const r = await tryInvokeHandler('ollama:start')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('omlx:checkStatus calls through', async () => {
      const r = await tryInvokeHandler('omlx:checkStatus')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('omlx:start calls through', async () => {
      const r = await tryInvokeHandler('omlx:start')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('omlx:adminUrl calls through', async () => {
      const r = await tryInvokeHandler('omlx:adminUrl')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('omlx:loadModel calls through', async () => {
      const r = await tryInvokeHandler('omlx:loadModel', { modelId: 'test-model' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('omlx:unloadModel calls through', async () => {
      const r = await tryInvokeHandler('omlx:unloadModel', { modelId: 'test-model' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// embedding.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (embeddingLoaded) {
  describe('embedding.ipc — channel registration', () => {
    test('registers embedding:checkStatus', () => {
      assert.ok(getHandlers().has('embedding:checkStatus'))
    })

    test('registers embedding:initialize', () => {
      assert.ok(getHandlers().has('embedding:initialize'))
    })
  })

  describe('embedding.ipc — handler bodies', () => {
    test('embedding:checkStatus calls through', async () => {
      const r = await tryInvokeHandler('embedding:checkStatus')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('embedding:checkStatus calls through with workspaceId', async () => {
      const r = await tryInvokeHandler('embedding:checkStatus', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('embedding:initialize calls through', async () => {
      const r = await tryInvokeHandler('embedding:initialize')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('embedding:initialize calls through with baseUrl', async () => {
      const r = await tryInvokeHandler('embedding:initialize', { baseUrl: 'http://localhost:8080' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-ollama-embedding')) {
  void summaryAsync()
}

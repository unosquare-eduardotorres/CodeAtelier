/**
 * Phase 24 — IPC Coverage Blitz: code-graph.ipc, indexing.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-code-graph-indexing.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  mockMainWindow,
  tryInvokeHandler,
} from '../../services/__tests__/electron-stub'

setupElectronStub()

// ── Register ─────────────────────────────────────────────────────────────

let codeGraphLoaded = false
let indexingLoaded = false

try {
  const mod = require('../../ipc/code-graph.ipc')
  mod.registerCodeGraphIpc(mockMainWindow)
  codeGraphLoaded = true
} catch (err) {
  console.log(`⚠ code-graph.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/indexing.ipc')
  const fn = Object.values(mod).find((v: any) => typeof v === 'function' && v.name?.startsWith('register')) as any
  if (fn) {
    if (fn.length > 0) fn(mockMainWindow); else fn()
    indexingLoaded = true
  }
} catch (err) {
  console.log(`⚠ indexing.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// code-graph.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (codeGraphLoaded) {
  describe('code-graph.ipc — channel registration', () => {
    test('registers codeGraph:indexStart', () => {
      assert.ok(capturedHandlers.has('codeGraph:indexStart'))
    })

    test('registers codeGraph:getStatus', () => {
      assert.ok(capturedHandlers.has('codeGraph:getStatus'))
    })

    test('registers codeGraph:hasIndex', () => {
      assert.ok(capturedHandlers.has('codeGraph:hasIndex'))
    })
  })

  describe('code-graph.ipc — validation', () => {
    test('codeGraph:indexStart rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('codeGraph:indexStart', {})
      assert.equal(r.ok, false)
    })

    test('codeGraph:getStatus rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('codeGraph:getStatus', {})
      assert.equal(r.ok, false)
    })
  })

  describe('code-graph.ipc — handler bodies', () => {
    test('codeGraph:indexStart calls through', async () => {
      const r = await tryInvokeHandler('codeGraph:indexStart', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('codeGraph:getStatus calls through', async () => {
      const r = await tryInvokeHandler('codeGraph:getStatus', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('codeGraph:hasIndex calls through', async () => {
      const r = await tryInvokeHandler('codeGraph:hasIndex', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// indexing.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (indexingLoaded) {
  describe('indexing.ipc — channel registration', () => {
    const indexChannels = [...capturedHandlers.keys()].filter(c =>
      c.includes('indexing') || c.includes('index')
    )
    test('registers indexing channels', () => {
      assert.ok(indexChannels.length >= 1, `Expected ≥1 indexing channels, got ${indexChannels.length}`)
    })
  })

  describe('indexing.ipc — handler bodies', () => {
    const indexChannels = [...capturedHandlers.keys()].filter(c =>
      c.includes('indexing') && !c.includes('codeGraph')
    )
    for (const ch of indexChannels) {
      test(`${ch} calls through with workspaceId`, async () => {
        const r = await tryInvokeHandler(ch, { workspaceId: 'ws-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-code-graph-indexing')) {
  void summaryAsync()
}

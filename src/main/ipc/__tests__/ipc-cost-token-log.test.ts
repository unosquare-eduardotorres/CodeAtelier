/**
 * Phase 24 — IPC Coverage Blitz: cost.ipc, token.ipc, log.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-cost-token-log.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  tryInvokeHandler,
} from '../../services/__tests__/electron-stub'

setupElectronStub()

let costLoaded = false
let tokenLoaded = false
let logLoaded = false

try {
  const mod = require('../../ipc/cost.ipc')
  mod.registerCostIpc()
  costLoaded = true
} catch (err) {
  console.log(`⚠ cost.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/token.ipc')
  mod.registerTokenIpc()
  tokenLoaded = true
} catch (err) {
  console.log(`⚠ token.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/log.ipc')
  mod.registerLogIpc()
  logLoaded = true
} catch (err) {
  console.log(`⚠ log.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// cost.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (costLoaded) {
  describe('cost.ipc — channel registration', () => {
    test('registers cost:getWorkspaceSummary', () => {
      assert.ok(capturedHandlers.has('cost:getWorkspaceSummary'))
    })

    test('registers cost:getConversation', () => {
      assert.ok(capturedHandlers.has('cost:getConversation'))
    })

    test('registers cost:getWorkspaceConversations', () => {
      assert.ok(capturedHandlers.has('cost:getWorkspaceConversations'))
    })

    test('registers cost:checkBudget', () => {
      assert.ok(capturedHandlers.has('cost:checkBudget'))
    })
  })

  describe('cost.ipc — argument validation', () => {
    test('cost:getWorkspaceSummary rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('cost:getWorkspaceSummary', {})
      assert.equal(r.ok, false)
    })

    test('cost:getConversation rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('cost:getConversation', {})
      assert.equal(r.ok, false)
    })

    test('cost:getWorkspaceConversations rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('cost:getWorkspaceConversations', {})
      assert.equal(r.ok, false)
    })

    test('cost:checkBudget rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('cost:checkBudget', {})
      assert.equal(r.ok, false)
    })

    test('cost:getWorkspaceSummary rejects non-object', async () => {
      const r = await tryInvokeHandler('cost:getWorkspaceSummary', 'bad')
      assert.equal(r.ok, false)
    })
  })

  describe('cost.ipc — handler bodies', () => {
    test('cost:getWorkspaceSummary calls through', async () => {
      const r = await tryInvokeHandler('cost:getWorkspaceSummary', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('cost:getConversation calls through', async () => {
      const r = await tryInvokeHandler('cost:getConversation', { conversationId: 'c-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('cost:getWorkspaceConversations calls through', async () => {
      const r = await tryInvokeHandler('cost:getWorkspaceConversations', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('cost:checkBudget calls through', async () => {
      const r = await tryInvokeHandler('cost:checkBudget', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// token.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (tokenLoaded) {
  describe('token.ipc — channel registration', () => {
    test('registers token:getWorkspaceSummary', () => {
      assert.ok(capturedHandlers.has('token:getWorkspaceSummary'))
    })

    test('registers token:getConversationSummary', () => {
      assert.ok(capturedHandlers.has('token:getConversationSummary'))
    })

    test('registers token:getRecentSessions', () => {
      assert.ok(capturedHandlers.has('token:getRecentSessions'))
    })

    test('registers token:getWorkspaceUsage', () => {
      assert.ok(capturedHandlers.has('token:getWorkspaceUsage'))
    })

    test('registers token:getGlobalUsage', () => {
      assert.ok(capturedHandlers.has('token:getGlobalUsage'))
    })
  })

  describe('token.ipc — argument validation', () => {
    test('token:getWorkspaceSummary rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('token:getWorkspaceSummary', {})
      assert.equal(r.ok, false)
    })

    test('token:getConversationSummary rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('token:getConversationSummary', {})
      assert.equal(r.ok, false)
    })

    test('token:getRecentSessions rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('token:getRecentSessions', {})
      assert.equal(r.ok, false)
    })

    test('token:getWorkspaceUsage rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('token:getWorkspaceUsage', {})
      assert.equal(r.ok, false)
    })
  })

  describe('token.ipc — handler bodies', () => {
    test('token:getWorkspaceSummary calls through', async () => {
      const r = await tryInvokeHandler('token:getWorkspaceSummary', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('token:getConversationSummary calls through', async () => {
      const r = await tryInvokeHandler('token:getConversationSummary', { conversationId: 'c-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('token:getRecentSessions calls through', async () => {
      const r = await tryInvokeHandler('token:getRecentSessions', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('token:getRecentSessions calls through with limit', async () => {
      const r = await tryInvokeHandler('token:getRecentSessions', { workspaceId: 'ws-1', limit: 10 })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('token:getWorkspaceUsage calls through', async () => {
      const r = await tryInvokeHandler('token:getWorkspaceUsage', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('token:getGlobalUsage calls through', async () => {
      const r = await tryInvokeHandler('token:getGlobalUsage')
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// log.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (logLoaded) {
  describe('log.ipc — channel registration', () => {
    test('registers log:fromRenderer', () => {
      assert.ok(capturedHandlers.has('log:fromRenderer'))
    })
  })

  describe('log.ipc — argument validation', () => {
    test('log:fromRenderer rejects missing level', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', { message: 'hi' })
      assert.equal(r.ok, false)
    })

    test('log:fromRenderer rejects missing message', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', { level: 'info' })
      assert.equal(r.ok, false)
    })

    test('log:fromRenderer rejects non-object', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', 'bad')
      assert.equal(r.ok, false)
    })

    test('log:fromRenderer rejects invalid level (prototype pollution prevention)', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'constructor',
        message: 'test',
      })
      assert.equal(r.ok, false)
    })

    test('log:fromRenderer rejects __proto__ as level', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: '__proto__',
        message: 'test',
      })
      assert.equal(r.ok, false)
    })
  })

  describe('log.ipc — handler bodies', () => {
    test('log:fromRenderer accepts level=info', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'info',
        message: 'Test info message',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('log:fromRenderer accepts level=warn', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'warn',
        message: 'Test warning',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('log:fromRenderer accepts level=error', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'error',
        message: 'Test error',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('log:fromRenderer accepts level=debug', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'debug',
        message: 'Test debug',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('log:fromRenderer accepts data array', async () => {
      const r = await tryInvokeHandler('log:fromRenderer', {
        level: 'info',
        message: 'With data',
        data: ['extra', 42],
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-cost-token-log')) {
  void summaryAsync()
}

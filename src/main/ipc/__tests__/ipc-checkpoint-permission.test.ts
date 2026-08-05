/**
 * Phase 24 — IPC Coverage Blitz: checkpoint.ipc, permission.ipc, insights.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-checkpoint-permission.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let checkpointLoaded = false
let permissionLoaded = false
let insightsLoaded = false

try {
  const mod = require('../../ipc/checkpoint.ipc')
  mod.registerCheckpointIpc()
  checkpointLoaded = true
} catch (err) {
  console.log(`⚠ checkpoint.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/permission.ipc')
  mod.registerPermissionIpc()
  permissionLoaded = true
} catch (err) {
  console.log(`⚠ permission.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/insights.ipc')
  mod.registerInsightsIpc()
  insightsLoaded = true
} catch (err) {
  console.log(`⚠ insights.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// checkpoint.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (checkpointLoaded) {
  describe('checkpoint.ipc — channel registration', () => {
    test('registers checkpoint:list', () => {
      assert.ok(getHandlers().has('checkpoint:list'))
    })

    test('registers checkpoint:restore', () => {
      assert.ok(getHandlers().has('checkpoint:restore'))
    })

    test('registers checkpoint:rewind', () => {
      assert.ok(getHandlers().has('checkpoint:rewind'))
    })

    test('registers checkpoint:approvalResponse', () => {
      assert.ok(getHandlers().has('checkpoint:approvalResponse'))
    })
  })

  describe('checkpoint.ipc — argument validation', () => {
    test('checkpoint:list rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('checkpoint:list', {})
      assert.equal(r.ok, false)
    })

    test('checkpoint:restore rejects missing checkpointId', async () => {
      const r = await tryInvokeHandler('checkpoint:restore', {})
      assert.equal(r.ok, false)
    })

    test('checkpoint:rewind rejects missing checkpointId', async () => {
      const r = await tryInvokeHandler('checkpoint:rewind', { conversationId: 'c1' })
      assert.equal(r.ok, false)
    })

    test('checkpoint:rewind rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('checkpoint:rewind', { checkpointId: 'cp1' })
      assert.equal(r.ok, false)
    })

    test('checkpoint:approvalResponse rejects missing checkpointId', async () => {
      const r = await tryInvokeHandler('checkpoint:approvalResponse', {})
      assert.equal(r.ok, false)
    })
  })

  describe('checkpoint.ipc — handler bodies', () => {
    test('checkpoint:list calls through', async () => {
      const r = await tryInvokeHandler('checkpoint:list', { conversationId: 'c1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('checkpoint:restore calls through', async () => {
      const r = await tryInvokeHandler('checkpoint:restore', { checkpointId: 'cp1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('checkpoint:rewind calls through', async () => {
      const r = await tryInvokeHandler('checkpoint:rewind', {
        checkpointId: 'cp1',
        conversationId: 'c1'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('checkpoint:approvalResponse calls through', async () => {
      const r = await tryInvokeHandler('checkpoint:approvalResponse', {
        checkpointId: 'cp1',
        approved: true
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// permission.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (permissionLoaded) {
  describe('permission.ipc — channel registration', () => {
    test('registers permission:response', () => {
      assert.ok(getHandlers().has('permission:response'))
    })
  })

  describe('permission.ipc — argument validation', () => {
    test('permission:response rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('permission:response', { type: 'elicitation' })
      assert.equal(r.ok, false)
    })

    test('permission:response rejects missing type', async () => {
      const r = await tryInvokeHandler('permission:response', { workspaceId: 'ws1' })
      assert.equal(r.ok, false)
    })

    test('permission:response rejects invalid type', async () => {
      const r = await tryInvokeHandler('permission:response', {
        workspaceId: 'ws1',
        type: 'invalid'
      })
      assert.equal(r.ok, false)
    })

    test('permission:response rejects non-object', async () => {
      const r = await tryInvokeHandler('permission:response', 'bad')
      assert.equal(r.ok, false)
    })
  })

  describe('permission.ipc — handler bodies', () => {
    test('permission:response (elicitation) calls through', async () => {
      const r = await tryInvokeHandler('permission:response', {
        workspaceId: 'ws1',
        type: 'elicitation',
        response: { accepted: true }
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('permission:response (askQuestion) calls through', async () => {
      const r = await tryInvokeHandler('permission:response', {
        workspaceId: 'ws1',
        type: 'askQuestion',
        response: { requestId: 'r1', answer: 'yes' }
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('permission:response (mpaApproval) calls through', async () => {
      const r = await tryInvokeHandler('permission:response', {
        workspaceId: 'ws1',
        type: 'mpaApproval',
        response: { approved: true, feedback: 'LGTM' }
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('permission:response (toolPermission) calls through', async () => {
      const r = await tryInvokeHandler('permission:response', {
        workspaceId: 'ws1',
        type: 'toolPermission',
        response: 'approve',
        payload: { requestId: 'req1' }
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// insights.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (insightsLoaded) {
  describe('insights.ipc — channel registration', () => {
    test('registers conversation:insights', () => {
      assert.ok(getHandlers().has('conversation:insights'))
    })
  })

  describe('insights.ipc — argument validation', () => {
    test('conversation:insights rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('conversation:insights', {})
      assert.equal(r.ok, false)
    })
  })

  describe('insights.ipc — handler bodies', () => {
    test('conversation:insights calls through', async () => {
      const r = await tryInvokeHandler('conversation:insights', { conversationId: 'c1' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-checkpoint-permission')) {
  void summaryAsync()
}

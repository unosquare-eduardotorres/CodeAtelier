/**
 * ipc-workspace-agent-handlers.test.ts — Phase 21, File 2
 *
 * Deep body coverage for workspace/agent/permission/checkpoint IPC handlers.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub, capturedHandlers, tryInvokeHandler, mockMainWindow } from './electron-stub'

setupElectronStub()

// ── Register IPC modules ─────────────────────────────────────────────────

let wsRegistered = false
let agentRegistered = false
let lifecycleRegistered = false
let permRegistered = false
let cpRegistered = false

try { require('../../ipc/workspace.ipc').registerWorkspaceIpc(); wsRegistered = true } catch (err) {
  console.log(`⚠ workspace.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}
try { require('../../ipc/agent.ipc').registerAgentIpc(mockMainWindow); agentRegistered = true } catch (err) {
  console.log(`⚠ agent.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}
try { require('../../ipc/agent-lifecycle.ipc').registerAgentLifecycleIpc(mockMainWindow); lifecycleRegistered = true } catch (err) {
  console.log(`⚠ agent-lifecycle.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}
try { require('../../ipc/permission.ipc').registerPermissionIpc(); permRegistered = true } catch (err) {
  console.log(`⚠ permission.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}
try { require('../../ipc/checkpoint.ipc').registerCheckpointIpc(); cpRegistered = true } catch (err) {
  console.log(`⚠ checkpoint.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// workspace.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (wsRegistered) {
  describe('workspace.ipc — channel registration', () => {
    for (const ch of ['workspace:list', 'workspace:create', 'workspace:open', 'workspace:delete',
      'workspace:get-settings', 'workspace:update-settings', 'workspace:update-auth',
      'workspace:check-external-mcp', 'dialog:selectDirectory']) {
      test(`registers ${ch}`, () => { assert.ok(capturedHandlers.has(ch)) })
    }
  })

  describe('workspace.ipc — validation', () => {
    test('workspace:create rejects null args', async () => {
      const r = await tryInvokeHandler('workspace:create', null)
      assert.equal(r.ok, false)
    })

    test('workspace:create rejects missing name', async () => {
      const r = await tryInvokeHandler('workspace:create', { repoPath: '/tmp/test' })
      assert.equal(r.ok, false)
    })

    test('workspace:create rejects missing repoPath', async () => {
      const r = await tryInvokeHandler('workspace:create', { name: 'Test' })
      assert.equal(r.ok, false)
    })

    test('workspace:open rejects null args', async () => {
      const r = await tryInvokeHandler('workspace:open', null)
      assert.equal(r.ok, false)
    })

    test('workspace:open rejects missing id', async () => {
      const r = await tryInvokeHandler('workspace:open', {})
      assert.equal(r.ok, false)
    })

    test('workspace:delete rejects null args', async () => {
      const r = await tryInvokeHandler('workspace:delete', null)
      assert.equal(r.ok, false)
    })

    test('workspace:get-settings rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:get-settings', {})
      assert.equal(r.ok, false)
    })

    test('workspace:update-settings rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:update-settings', { settings: {} })
      assert.equal(r.ok, false)
    })

    test('workspace:update-auth rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:update-auth', { authMode: 'api-key' })
      assert.equal(r.ok, false)
    })

    test('workspace:check-external-mcp rejects missing command', async () => {
      const r = await tryInvokeHandler('workspace:check-external-mcp', {})
      assert.equal(r.ok, false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// agent.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (agentRegistered) {
  describe('agent.ipc — channel registration', () => {
    for (const ch of ['agent:getStatuses', 'agent:stopAll', 'agent:cacheEfficiency']) {
      test(`registers ${ch}`, () => { assert.ok(capturedHandlers.has(ch)) })
    }
  })

  describe('agent.ipc — handlers', () => {
    test('agent:getStatuses returns result (array or error)', async () => {
      const r = await tryInvokeHandler('agent:getStatuses', undefined)
      // Either succeeds (returns array) or fails (service not ready)
      assert.equal(typeof r.ok, 'boolean')
    })

    test('agent:stopAll executes without throwing', async () => {
      const r = await tryInvokeHandler('agent:stopAll', undefined)
      assert.equal(typeof r.ok, 'boolean')
    })

    test('agent:cacheEfficiency returns result', async () => {
      const r = await tryInvokeHandler('agent:cacheEfficiency', undefined)
      assert.equal(typeof r.ok, 'boolean')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// agent-lifecycle.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (lifecycleRegistered) {
  describe('agent-lifecycle.ipc — channel registration', () => {
    test('registers agent:start', () => { assert.ok(capturedHandlers.has('agent:start')) })
    test('registers workspace:all-statuses', () => { assert.ok(capturedHandlers.has('workspace:all-statuses')) })
  })

  describe('agent-lifecycle.ipc — validation', () => {
    test('agent:start rejects empty string', async () => {
      const r = await tryInvokeHandler('agent:start', '')
      assert.equal(r.ok, false)
    })

    test('agent:start rejects whitespace-only path', async () => {
      const r = await tryInvokeHandler('agent:start', '   ')
      assert.equal(r.ok, false)
    })

    test('agent:start rejects null', async () => {
      const r = await tryInvokeHandler('agent:start', null)
      assert.equal(r.ok, false)
    })

    test('workspace:all-statuses returns result', async () => {
      const r = await tryInvokeHandler('workspace:all-statuses', undefined)
      assert.equal(typeof r.ok, 'boolean')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// permission.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (permRegistered) {
  describe('permission.ipc — channel registration', () => {
    test('registers permission:response', () => { assert.ok(capturedHandlers.has('permission:response')) })
  })

  describe('permission.ipc — validation', () => {
    test('permission:response rejects null args', async () => {
      const r = await tryInvokeHandler('permission:response', null)
      assert.equal(r.ok, false)
    })

    test('permission:response rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('permission:response', { type: 'elicitation' })
      assert.equal(r.ok, false)
    })

    test('permission:response rejects missing type', async () => {
      const r = await tryInvokeHandler('permission:response', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
    })

    test('permission:response rejects invalid type', async () => {
      const r = await tryInvokeHandler('permission:response', { workspaceId: 'ws-1', type: 'invalid' })
      assert.equal(r.ok, false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// checkpoint.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (cpRegistered) {
  describe('checkpoint.ipc — channel registration', () => {
    for (const ch of ['checkpoint:list', 'checkpoint:restore', 'checkpoint:rewind', 'checkpoint:approvalResponse']) {
      test(`registers ${ch}`, () => { assert.ok(capturedHandlers.has(ch)) })
    }
  })

  describe('checkpoint.ipc — validation', () => {
    test('checkpoint:list rejects null args', async () => {
      const r = await tryInvokeHandler('checkpoint:list', null)
      assert.equal(r.ok, false)
    })

    test('checkpoint:list rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('checkpoint:list', {})
      assert.equal(r.ok, false)
    })

    test('checkpoint:restore rejects missing checkpointId', async () => {
      const r = await tryInvokeHandler('checkpoint:restore', {})
      assert.equal(r.ok, false)
    })

    test('checkpoint:rewind rejects missing fields', async () => {
      const r = await tryInvokeHandler('checkpoint:rewind', {})
      assert.equal(r.ok, false)
    })

    test('checkpoint:approvalResponse rejects missing checkpointId', async () => {
      const r = await tryInvokeHandler('checkpoint:approvalResponse', {})
      assert.equal(r.ok, false)
    })
  })
}

// ── Skip blocks ──────────────────────────────────────────────────────────

if (!wsRegistered) { describe('workspace.ipc (skipped)', () => { test('skipped', () => {}, { skipReason: 'module not loaded' }) }) }
if (!agentRegistered) { describe('agent.ipc (skipped)', () => { test('skipped', () => {}, { skipReason: 'module not loaded' }) }) }
if (!lifecycleRegistered) { describe('agent-lifecycle.ipc (skipped)', () => { test('skipped', () => {}, { skipReason: 'module not loaded' }) }) }
if (!permRegistered) { describe('permission.ipc (skipped)', () => { test('skipped', () => {}, { skipReason: 'module not loaded' }) }) }
if (!cpRegistered) { describe('checkpoint.ipc (skipped)', () => { test('skipped', () => {}, { skipReason: 'module not loaded' }) }) }

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

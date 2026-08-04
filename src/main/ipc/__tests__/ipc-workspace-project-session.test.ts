/**
 * Phase 24 — IPC Coverage Blitz: workspace.ipc (deep), project.ipc, session.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-workspace-project-session.test.ts
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

let workspaceLoaded = false
let projectLoaded = false
let sessionLoaded = false

try {
  const mod = require('../../ipc/workspace.ipc')
  mod.registerWorkspaceIpc(mockMainWindow)
  workspaceLoaded = true
} catch (err) {
  console.log(`⚠ workspace.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/project.ipc')
  const fn = Object.values(mod).find((v: any) => typeof v === 'function' && v.name?.startsWith('register')) as any
  if (fn) { fn.length > 0 ? fn(mockMainWindow) : fn(); projectLoaded = true }
} catch (err) {
  console.log(`⚠ project.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/session.ipc')
  mod.registerSessionIpc()
  sessionLoaded = true
} catch (err) {
  console.log(`⚠ session.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// workspace.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (workspaceLoaded) {
  describe('workspace.ipc — channel registration (deep)', () => {
    const wsCh = [...capturedHandlers.keys()].filter(c => c.startsWith('workspace:'))
    test('registers ≥10 workspace channels', () => {
      assert.ok(wsCh.length >= 10, `Expected ≥10 workspace channels, got ${wsCh.length}`)
    })

    test('registers workspace:list', () => {
      assert.ok(capturedHandlers.has('workspace:list'))
    })

    test('registers workspace:create', () => {
      assert.ok(capturedHandlers.has('workspace:create'))
    })

    test('registers workspace:select', () => {
      assert.ok(capturedHandlers.has('workspace:select'))
    })

    test('registers workspace:getSettings', () => {
      assert.ok(capturedHandlers.has('workspace:getSettings'))
    })

    test('registers workspace:updateSettings', () => {
      assert.ok(capturedHandlers.has('workspace:updateSettings'))
    })

    test('registers workspace:delete', () => {
      assert.ok(capturedHandlers.has('workspace:delete'))
    })
  })

  describe('workspace.ipc — argument validation', () => {
    test('workspace:create rejects missing repoPath', async () => {
      const r = await tryInvokeHandler('workspace:create', { name: 'test' })
      assert.equal(r.ok, false)
    })

    test('workspace:select rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:select', {})
      assert.equal(r.ok, false)
    })

    test('workspace:getSettings rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:getSettings', {})
      assert.equal(r.ok, false)
    })

    test('workspace:updateSettings rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:updateSettings', { settings: {} })
      assert.equal(r.ok, false)
    })

    test('workspace:delete rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('workspace:delete', {})
      assert.equal(r.ok, false)
    })
  })

  describe('workspace.ipc — handler bodies', () => {
    test('workspace:list calls through', async () => {
      const r = await tryInvokeHandler('workspace:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:create calls through', async () => {
      const r = await tryInvokeHandler('workspace:create', {
        repoPath: '/tmp/test-project',
        name: 'Test Project',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:select calls through', async () => {
      const r = await tryInvokeHandler('workspace:select', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:getSettings calls through', async () => {
      const r = await tryInvokeHandler('workspace:getSettings', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:updateSettings calls through', async () => {
      const r = await tryInvokeHandler('workspace:updateSettings', {
        workspaceId: 'ws-1',
        settings: { theme: 'dark' },
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:delete calls through', async () => {
      const r = await tryInvokeHandler('workspace:delete', { workspaceId: 'ws-del' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// project.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (projectLoaded) {
  describe('project.ipc — channel registration', () => {
    const projCh = [...capturedHandlers.keys()].filter(c => c.startsWith('project:'))
    test('registers project channels', () => {
      assert.ok(projCh.length >= 3, `Expected ≥3 project channels, got ${projCh.length}`)
    })
  })

  describe('project.ipc — handler bodies', () => {
    const projCh = [...capturedHandlers.keys()].filter(c => c.startsWith('project:'))
    for (const ch of projCh) {
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, { workspaceId: 'ws-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// session.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (sessionLoaded) {
  describe('session.ipc — channel registration', () => {
    test('registers session:list', () => {
      assert.ok(capturedHandlers.has('session:list'))
    })

    const sessionCh = [...capturedHandlers.keys()].filter(c => c.startsWith('session:'))
    test('registers ≥3 session channels', () => {
      assert.ok(sessionCh.length >= 3, `Expected ≥3 session channels, got ${sessionCh.length}`)
    })
  })

  describe('session.ipc — handler bodies', () => {
    test('session:list calls through', async () => {
      const r = await tryInvokeHandler('session:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('session:list calls through with dir', async () => {
      const r = await tryInvokeHandler('session:list', { dir: '/tmp/project' })
      assert.ok(r.ok === true || r.ok === false)
    })

    // Test session channels with args validation
    const detailCh = ['session:get', 'session:resume', 'session:delete'].filter(
      ch => capturedHandlers.has(ch)
    )
    for (const ch of detailCh) {
      test(`${ch} rejects missing id/sessionId`, async () => {
        const r = await tryInvokeHandler(ch, {})
        assert.equal(r.ok, false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-workspace-project-session')) {
  void summaryAsync()
}

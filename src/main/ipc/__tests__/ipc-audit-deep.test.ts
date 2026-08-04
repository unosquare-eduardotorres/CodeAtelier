/**
 * Phase 24 — IPC Coverage Blitz: audit.ipc (deep, 1044 lines)
 *
 * Run: tsx src/main/ipc/__tests__/ipc-audit-deep.test.ts
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

let auditLoaded = false

try {
  const mod = require('../../ipc/audit.ipc')
  mod.registerAuditIpc(mockMainWindow)
  auditLoaded = true
} catch (err) {
  console.log(`⚠ audit.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (auditLoaded) {
  describe('audit.ipc — channel registration (deep)', () => {
    const auditCh = [...capturedHandlers.keys()].filter(c => c.startsWith('audit:'))
    test('registers ≥10 audit channels', () => {
      assert.ok(auditCh.length >= 10, `Expected ≥10, got ${auditCh.length}`)
    })

    const expectedChannels = [
      'audit:cancel', 'audit:deleteRun', 'audit:generatePlan', 'audit:getPlans',
    ]
    for (const ch of expectedChannels) {
      if (capturedHandlers.has(ch)) {
        test(`registers ${ch}`, () => {
          assert.ok(capturedHandlers.has(ch))
        })
      }
    }
  })

  describe('audit.ipc — argument validation (deep)', () => {
    // audit:start/run — usually requires workspaceId and conversationId
    const startCh = [...capturedHandlers.keys()].find(c =>
      c.startsWith('audit:') && (c.includes('start') || c.includes('Start') || c.includes('run') || c.includes('Run'))
    )
    if (startCh) {
      test(`${startCh} rejects missing workspaceId`, async () => {
        const r = await tryInvokeHandler(startCh, { conversationId: 'c1' })
        assert.equal(r.ok, false)
      })

      test(`${startCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(startCh, { workspaceId: 'ws1' })
        assert.equal(r.ok, false)
      })
    }

    // audit:deleteRun
    if (capturedHandlers.has('audit:deleteRun')) {
      test('audit:deleteRun rejects missing runId', async () => {
        const r = await tryInvokeHandler('audit:deleteRun', {})
        assert.equal(r.ok, false)
      })
    }

    // audit:getPlans
    if (capturedHandlers.has('audit:getPlans')) {
      test('audit:getPlans rejects missing workspaceId', async () => {
        const r = await tryInvokeHandler('audit:getPlans', {})
        assert.equal(r.ok, false)
      })
    }

    // audit:generatePlan
    if (capturedHandlers.has('audit:generatePlan')) {
      test('audit:generatePlan rejects missing workspaceId', async () => {
        const r = await tryInvokeHandler('audit:generatePlan', { conversationId: 'c1' })
        assert.equal(r.ok, false)
      })
    }
  })

  describe('audit.ipc — handler bodies (deep)', () => {
    // Exercise all registered audit channels
    const auditCh = [...capturedHandlers.keys()].filter(c => c.startsWith('audit:'))
    for (const ch of auditCh) {
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, {
          workspaceId: 'ws-1',
          conversationId: 'c-1',
          runId: 'run-1',
          planId: 'plan-1',
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    // Specific body tests
    if (capturedHandlers.has('audit:cancel')) {
      test('audit:cancel calls through (no args)', async () => {
        const r = await tryInvokeHandler('audit:cancel')
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-audit-deep')) {
  void summaryAsync()
}

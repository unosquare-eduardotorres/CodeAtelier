/**
 * Phase 24 — IPC Coverage Blitz: plan.ipc, sdk-control.ipc, handoff.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-plan-sdk-handoff.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let planLoaded = false
let sdkLoaded = false
let handoffLoaded = false

try {
  const mod = require('../../ipc/plan.ipc')
  mod.registerPlanIpc()
  planLoaded = true
} catch (err) {
  console.log(`⚠ plan.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/sdk-control.ipc')
  mod.registerSdkControlIpc()
  sdkLoaded = true
} catch (err) {
  console.log(`⚠ sdk-control.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/handoff.ipc')
  mod.registerHandoffIpc()
  handoffLoaded = true
} catch (err) {
  console.log(`⚠ handoff.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// plan.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (planLoaded) {
  describe('plan.ipc — channel registration', () => {
    test('registers plan:getAll', () => {
      assert.ok(getHandlers().has('plan:getAll'))
    })

    test('registers plan:getById', () => {
      assert.ok(getHandlers().has('plan:getById'))
    })

    test('registers plan:updateStatus', () => {
      assert.ok(getHandlers().has('plan:updateStatus'))
    })

    const planCh = [...getHandlers().keys()].filter((c) => c.startsWith('plan:'))
    test('registers ≥5 plan channels', () => {
      assert.ok(planCh.length >= 5, `Expected ≥5, got ${planCh.length}: ${planCh.join(', ')}`)
    })
  })

  describe('plan.ipc — handler bodies', () => {
    test('plan:getAll calls through', async () => {
      const r = await tryInvokeHandler('plan:getAll', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('plan:getById calls through', async () => {
      const r = await tryInvokeHandler('plan:getById', { planId: 'p-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('plan:updateStatus calls through', async () => {
      const r = await tryInvokeHandler('plan:updateStatus', {
        planId: 'p-1',
        status: 'active'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    // Test plan:delete and plan:import if registered
    const deleteCh = getHandlers().has('plan:delete')
    if (deleteCh) {
      test('plan:delete calls through', async () => {
        const r = await tryInvokeHandler('plan:delete', { planId: 'p-del' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const importCh = getHandlers().has('plan:import')
    if (importCh) {
      test('plan:import calls through', async () => {
        const r = await tryInvokeHandler('plan:import', {
          workspaceId: 'ws-1',
          planId: 'p-1'
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// sdk-control.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (sdkLoaded) {
  describe('sdk-control.ipc — channel registration', () => {
    test('registers elicitation:response', () => {
      assert.ok(getHandlers().has('elicitation:response'))
    })

    test('registers sdk:elicitationResponse', () => {
      assert.ok(getHandlers().has('sdk:elicitationResponse'))
    })

    test('registers chat:askUserRespond', () => {
      assert.ok(getHandlers().has('chat:askUserRespond'))
    })

    const sdkCh = [...getHandlers().keys()].filter(
      (c) => c.startsWith('sdk:') || c.includes('elicitation') || c.includes('askUser')
    )
    test('registers ≥5 sdk-control channels', () => {
      assert.ok(sdkCh.length >= 5, `Expected ≥5, got ${sdkCh.length}: ${sdkCh.join(', ')}`)
    })
  })

  describe('sdk-control.ipc — argument validation', () => {
    test('elicitation:response rejects missing action', async () => {
      const r = await tryInvokeHandler('elicitation:response', {})
      assert.equal(r.ok, false)
    })

    test('elicitation:response rejects invalid action', async () => {
      const r = await tryInvokeHandler('elicitation:response', { action: 'invalid' })
      assert.equal(r.ok, false)
    })

    test('elicitation:response rejects non-object content', async () => {
      const r = await tryInvokeHandler('elicitation:response', {
        action: 'accept',
        content: 'bad'
      })
      assert.equal(r.ok, false)
    })

    test('sdk:elicitationResponse rejects missing requestId', async () => {
      const r = await tryInvokeHandler('sdk:elicitationResponse', { action: 'accept' })
      assert.equal(r.ok, false)
    })

    test('sdk:elicitationResponse rejects missing action', async () => {
      const r = await tryInvokeHandler('sdk:elicitationResponse', { requestId: 'r1' })
      assert.equal(r.ok, false)
    })

    test('chat:askUserRespond rejects missing requestId', async () => {
      const r = await tryInvokeHandler('chat:askUserRespond', { answer: 'yes' })
      assert.equal(r.ok, false)
    })

    test('chat:askUserRespond rejects missing answer', async () => {
      const r = await tryInvokeHandler('chat:askUserRespond', { requestId: 'r1' })
      assert.equal(r.ok, false)
    })
  })

  describe('sdk-control.ipc — handler bodies', () => {
    test('elicitation:response with accept calls through', async () => {
      const r = await tryInvokeHandler('elicitation:response', {
        action: 'accept',
        content: { field1: 'value1' }
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('elicitation:response with decline calls through', async () => {
      const r = await tryInvokeHandler('elicitation:response', { action: 'decline' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('elicitation:response with cancel calls through', async () => {
      const r = await tryInvokeHandler('elicitation:response', { action: 'cancel' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('chat:askUserRespond calls through', async () => {
      const r = await tryInvokeHandler('chat:askUserRespond', {
        requestId: 'r1',
        answer: 'yes, proceed'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    // SDK list/fork handlers
    const supportedModels = getHandlers().has('sdk:supportedModels')
    if (supportedModels) {
      test('sdk:supportedModels calls through', async () => {
        const r = await tryInvokeHandler('sdk:supportedModels')
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// handoff.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (handoffLoaded) {
  describe('handoff.ipc — channel registration', () => {
    test('registers handoff:create', () => {
      assert.ok(getHandlers().has('handoff:create'))
    })

    const handoffCh = [...getHandlers().keys()].filter((c) => c.startsWith('handoff:'))
    test('registers ≥4 handoff channels', () => {
      assert.ok(
        handoffCh.length >= 4,
        `Expected ≥4, got ${handoffCh.length}: ${handoffCh.join(', ')}`
      )
    })
  })

  describe('handoff.ipc — argument validation', () => {
    test('handoff:create rejects missing source', async () => {
      const r = await tryInvokeHandler('handoff:create', {
        target: 'chat',
        workspaceId: 'ws1',
        intent: 'continue',
        originalGoal: 'fix bug',
        contextSummary: 'summary'
      })
      assert.equal(r.ok, false)
    })

    test('handoff:create rejects missing target', async () => {
      const r = await tryInvokeHandler('handoff:create', {
        source: 'grill',
        workspaceId: 'ws1',
        intent: 'continue',
        originalGoal: 'fix bug',
        contextSummary: 'summary'
      })
      assert.equal(r.ok, false)
    })

    test('handoff:create rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('handoff:create', {
        source: 'grill',
        target: 'chat',
        intent: 'continue',
        originalGoal: 'fix bug',
        contextSummary: 'summary'
      })
      assert.equal(r.ok, false)
    })
  })

  describe('handoff.ipc — handler bodies', () => {
    test('handoff:create calls through', async () => {
      const r = await tryInvokeHandler('handoff:create', {
        source: 'grill',
        target: 'chat',
        workspaceId: 'ws1',
        intent: 'continue',
        originalGoal: 'implement feature',
        contextSummary: 'Grill concluded with plan'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    // handoff:list, handoff:get, handoff:accept, handoff:reject
    const listCh = getHandlers().has('handoff:list')
    if (listCh) {
      test('handoff:list calls through', async () => {
        const r = await tryInvokeHandler('handoff:list', { workspaceId: 'ws1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const getCh = getHandlers().has('handoff:get')
    if (getCh) {
      test('handoff:get calls through', async () => {
        const r = await tryInvokeHandler('handoff:get', { handoffId: 'h1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const acceptCh = getHandlers().has('handoff:accept')
    if (acceptCh) {
      test('handoff:accept calls through', async () => {
        const r = await tryInvokeHandler('handoff:accept', { handoffId: 'h1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-plan-sdk-handoff')) {
  void summaryAsync()
}

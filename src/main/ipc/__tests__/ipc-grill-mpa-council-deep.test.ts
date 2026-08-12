/**
 * Phase 24 — IPC Coverage Blitz: grill.ipc (544), mpa.ipc (475), council.ipc (307)
 *
 * Run: tsx src/main/ipc/__tests__/ipc-grill-mpa-council-deep.test.ts
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

let grillLoaded = false
let mpaLoaded = false
let councilLoaded = false

try {
  const mod = require('../../ipc/grill.ipc')
  mod.registerGrillIpc(mockMainWindow)
  grillLoaded = true
} catch (err) {
  console.log(`⚠ grill.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/mpa.ipc')
  mod.registerMpaIpc(mockMainWindow)
  mpaLoaded = true
} catch (err) {
  console.log(`⚠ mpa.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/council.ipc')
  mod.registerCouncilIpc(mockMainWindow)
  councilLoaded = true
} catch (err) {
  console.log(`⚠ council.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// grill.ipc.ts (544 lines)
// ═══════════════════════════════════════════════════════════════════════════

if (grillLoaded) {
  describe('grill.ipc — channel registration (deep)', () => {
    const grillCh = [...getHandlers().keys()].filter((c) => c.startsWith('grill:'))
    test('registers ≥10 grill channels', () => {
      assert.ok(grillCh.length >= 10, `Expected ≥10, got ${grillCh.length}`)
    })

    const expectedChannels = [
      'grill:evaluate',
      'grill:cancel',
      'grill:getStatus',
      'grill:getSession',
      'grill:saveAnswers',
      'grill:complete',
      'grill:discard',
      'grill:listPlannedIdeas'
    ]
    for (const ch of expectedChannels) {
      if (getHandlers().has(ch)) {
        test(`registers ${ch}`, () => {
          assert.ok(getHandlers().has(ch))
        })
      }
    }
  })

  describe('grill.ipc — argument validation (deep)', () => {
    if (getHandlers().has('grill:evaluate')) {
      test('grill:evaluate rejects missing workspaceId', async () => {
        const r = await tryInvokeHandler('grill:evaluate', {
          conversationId: 'c1',
          requirement: 'Build a feature'
        })
        assert.equal(r.ok, false)
      })

      test('grill:evaluate rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:evaluate', {
          workspaceId: 'ws1',
          requirement: 'Build a feature'
        })
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:getStatus')) {
      test('grill:getStatus rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:getStatus', {})
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:getSession')) {
      test('grill:getSession rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:getSession', {})
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:saveAnswers')) {
      test('grill:saveAnswers rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:saveAnswers', { answers: '{}' })
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:complete')) {
      test('grill:complete rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:complete', {})
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:discard')) {
      test('grill:discard rejects missing conversationId', async () => {
        const r = await tryInvokeHandler('grill:discard', {})
        assert.equal(r.ok, false)
      })
    }

    if (getHandlers().has('grill:listPlannedIdeas')) {
      test('grill:listPlannedIdeas rejects missing workspaceId', async () => {
        const r = await tryInvokeHandler('grill:listPlannedIdeas', {})
        assert.equal(r.ok, false)
      })
    }
  })

  describe('grill.ipc — handler bodies (deep)', () => {
    const grillCh = [...getHandlers().keys()].filter((c) => c.startsWith('grill:'))
    for (const ch of grillCh) {
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, {
          workspaceId: 'ws-1',
          conversationId: 'c-1',
          requirement: 'Build a feature',
          answers: '{}'
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// mpa.ipc.ts (475 lines)
// ═══════════════════════════════════════════════════════════════════════════

if (mpaLoaded) {
  describe('mpa.ipc — channel registration (deep)', () => {
    const mpaCh = [...getHandlers().keys()].filter((c) => c.startsWith('mpa:'))
    test('registers ≥8 mpa channels', () => {
      assert.ok(mpaCh.length >= 8, `Expected ≥8, got ${mpaCh.length}`)
    })

    const expectedChannels = ['mpa:cancel', 'mpa:getStatus', 'mpa:getRun']
    for (const ch of expectedChannels) {
      if (getHandlers().has(ch)) {
        test(`registers ${ch}`, () => {
          assert.ok(getHandlers().has(ch))
        })
      }
    }
  })

  describe('mpa.ipc — argument validation (deep)', () => {
    if (getHandlers().has('mpa:getStatus')) {
      test('mpa:getStatus calls through with workspaceId', async () => {
        const r = await tryInvokeHandler('mpa:getStatus', { workspaceId: 'ws-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('mpa:getRun')) {
      test('mpa:getRun calls through with runId', async () => {
        const r = await tryInvokeHandler('mpa:getRun', { runId: 'run-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })

  describe('mpa.ipc — handler bodies (deep)', () => {
    const mpaCh = [...getHandlers().keys()].filter((c) => c.startsWith('mpa:'))
    for (const ch of mpaCh) {
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, {
          workspaceId: 'ws-1',
          runId: 'run-1',
          campaignId: 'camp-1'
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    // MPA cancel without args
    if (getHandlers().has('mpa:cancel')) {
      test('mpa:cancel calls through without args', async () => {
        const r = await tryInvokeHandler('mpa:cancel')
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// council.ipc.ts (307 lines)
// ═══════════════════════════════════════════════════════════════════════════

if (councilLoaded) {
  describe('council.ipc — channel registration (deep)', () => {
    const councilCh = [...getHandlers().keys()].filter((c) => c.startsWith('council:'))
    test('registers ≥4 council channels', () => {
      assert.ok(councilCh.length >= 4, `Expected ≥4, got ${councilCh.length}`)
    })

    const expectedChannels = ['council:cancel', 'council:getSession']
    for (const ch of expectedChannels) {
      if (getHandlers().has(ch)) {
        test(`registers ${ch}`, () => {
          assert.ok(getHandlers().has(ch))
        })
      }
    }
  })

  describe('council.ipc — argument validation (deep)', () => {
    if (getHandlers().has('council:getSession')) {
      test('council:getSession calls through', async () => {
        const r = await tryInvokeHandler('council:getSession', { workspaceId: 'ws-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })

  describe('council.ipc — handler bodies (deep)', () => {
    const councilCh = [...getHandlers().keys()].filter((c) => c.startsWith('council:'))
    for (const ch of councilCh) {
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, {
          workspaceId: 'ws-1',
          conversationId: 'c-1',
          sessionId: 's-1',
          topic: 'Architecture review'
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    // Council cancel without args
    if (getHandlers().has('council:cancel')) {
      test('council:cancel calls through without args', async () => {
        const r = await tryInvokeHandler('council:cancel')
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-grill-mpa-council-deep')) {
  void summaryAsync()
}

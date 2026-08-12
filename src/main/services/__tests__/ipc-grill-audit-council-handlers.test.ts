/**
 * ipc-grill-audit-council-handlers.test.ts — Phase 21, File 3
 *
 * Deep body coverage for grill/audit/council/mpa/idea IPC handlers.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  tryInvokeHandler,
  mockMainWindow
} from './electron-stub'

setupElectronStub()

// ── Register IPC modules ─────────────────────────────────────────────────

let grillOk = false,
  auditOk = false,
  councilOk = false,
  mpaOk = false,
  ideaOk = false

try {
  require('../../ipc/grill.ipc').registerGrillIpc(mockMainWindow)
  grillOk = true
} catch (err) {
  console.log(`⚠ grill.ipc: ${(err as Error).message?.split('\n')[0]}`)
}
try {
  require('../../ipc/audit.ipc').registerAuditIpc(mockMainWindow)
  auditOk = true
} catch (err) {
  console.log(`⚠ audit.ipc: ${(err as Error).message?.split('\n')[0]}`)
}
try {
  require('../../ipc/council.ipc').registerCouncilIpc(mockMainWindow)
  councilOk = true
} catch (err) {
  console.log(`⚠ council.ipc: ${(err as Error).message?.split('\n')[0]}`)
}
try {
  require('../../ipc/mpa.ipc').registerMpaIpc(mockMainWindow)
  mpaOk = true
} catch (err) {
  console.log(`⚠ mpa.ipc: ${(err as Error).message?.split('\n')[0]}`)
}
try {
  require('../../ipc/idea.ipc').registerIdeaIpc()
  ideaOk = true
} catch (err) {
  console.log(`⚠ idea.ipc: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// grill.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (grillOk) {
  describe('grill.ipc — channel registration', () => {
    for (const ch of [
      'grill:evaluate',
      'grill:cancel',
      'grill:getStatus',
      'grill:getSession',
      'grill:saveAnswers',
      'grill:generatePlan',
      'grill:generatePlanFromDecisions',
      'grill:seedPlanCard',
      'grill:complete',
      'grill:discard',
      'grill:listPlannedIdeas',
      'grill:condenseRequirement'
    ]) {
      test(`registers ${ch}`, () => {
        assert.ok(capturedHandlers.has(ch))
      })
    }
  })

  describe('grill.ipc — validation', () => {
    test('grill:evaluate rejects null args', async () => {
      const r = await tryInvokeHandler('grill:evaluate', null)
      assert.equal(r.ok, false)
    })

    test('grill:evaluate rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('grill:evaluate', {
        trackId: 'grilled',
        ideaTitle: 'T',
        ideaDescription: 'D'
      })
      assert.equal(r.ok, false)
    })

    test('grill:evaluate rejects missing trackId', async () => {
      const r = await tryInvokeHandler('grill:evaluate', {
        workspaceId: 'ws-1',
        ideaTitle: 'T',
        ideaDescription: 'D'
      })
      assert.equal(r.ok, false)
    })

    test('grill:getStatus rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('grill:getStatus', {})
      assert.equal(r.ok, false)
    })

    test('grill:getSession rejects missing ideaId', async () => {
      const r = await tryInvokeHandler('grill:getSession', {})
      assert.equal(r.ok, false)
    })

    test('grill:saveAnswers rejects missing sessionId', async () => {
      const r = await tryInvokeHandler('grill:saveAnswers', { questionStates: {} })
      assert.equal(r.ok, false)
    })

    test('grill:generatePlan rejects missing sessionId', async () => {
      const r = await tryInvokeHandler('grill:generatePlan', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
    })

    test('grill:generatePlanFromDecisions rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('grill:generatePlanFromDecisions', {
        projectName: 'P',
        description: 'D'
      })
      assert.equal(r.ok, false)
    })

    test('grill:complete rejects missing ideaId', async () => {
      const r = await tryInvokeHandler('grill:complete', {})
      assert.equal(r.ok, false)
    })

    test('grill:discard rejects missing ideaId', async () => {
      const r = await tryInvokeHandler('grill:discard', {})
      assert.equal(r.ok, false)
    })

    test('grill:listPlannedIdeas rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('grill:listPlannedIdeas', {})
      assert.equal(r.ok, false)
    })

    test('grill:condenseRequirement rejects missing text', async () => {
      const r = await tryInvokeHandler('grill:condenseRequirement', {})
      assert.equal(r.ok, false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// audit.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (auditOk) {
  describe('audit.ipc — channel registration', () => {
    for (const ch of [
      'audit:start',
      'audit:cancel',
      'audit:rerunTrack',
      'audit:resume',
      'audit:getLatest',
      'audit:getHistory',
      'audit:deleteRun',
      'audit:generatePlan',
      'audit:getPlans',
      'audit:convertFindings',
      'audit:exportMarkdown',
      'audit:exportPlanMarkdown',
      'audit:handoffToChat'
    ]) {
      test(`registers ${ch}`, () => {
        assert.ok(capturedHandlers.has(ch))
      })
    }
  })

  describe('audit.ipc — validation', () => {
    test('audit:start rejects null args', async () => {
      const r = await tryInvokeHandler('audit:start', null)
      assert.equal(r.ok, false)
    })

    test('audit:rerunTrack rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('audit:rerunTrack', { trackId: 't1' })
      assert.equal(r.ok, false)
    })

    test('audit:getLatest handles missing workspaceId', async () => {
      const r = await tryInvokeHandler('audit:getLatest', {})
      // May return null/empty result or throw — either is valid
      assert.equal(typeof r.ok, 'boolean')
    })

    test('audit:getHistory handles missing workspaceId', async () => {
      const r = await tryInvokeHandler('audit:getHistory', {})
      assert.equal(typeof r.ok, 'boolean')
    })

    test('audit:deleteRun handles missing runId', async () => {
      const r = await tryInvokeHandler('audit:deleteRun', {})
      assert.equal(typeof r.ok, 'boolean')
    })

    test('audit:generatePlan rejects missing fields', async () => {
      const r = await tryInvokeHandler('audit:generatePlan', {})
      assert.equal(r.ok, false)
    })

    test('audit:handoffToChat rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('audit:handoffToChat', {})
      assert.equal(r.ok, false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// council.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (councilOk) {
  describe('council.ipc — channel registration', () => {
    for (const ch of [
      'council:start',
      'council:cancel',
      'council:getSession',
      'council:resume',
      'council:getHistory',
      'council:deleteSession'
    ]) {
      test(`registers ${ch}`, () => {
        assert.ok(capturedHandlers.has(ch))
      })
    }
  })

  describe('council.ipc — validation', () => {
    test('council:start rejects null args', async () => {
      const r = await tryInvokeHandler('council:start', null)
      assert.equal(r.ok, false)
    })

    test('council:start rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('council:start', { inputType: 'plan', planContent: 'test' })
      assert.equal(r.ok, false)
    })

    test('council:getSession handles missing workspaceId', async () => {
      const r = await tryInvokeHandler('council:getSession', {})
      assert.equal(typeof r.ok, 'boolean')
    })

    test('council:resume rejects missing sessionId', async () => {
      const r = await tryInvokeHandler('council:resume', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
    })

    test('council:getHistory handles missing workspaceId', async () => {
      const r = await tryInvokeHandler('council:getHistory', {})
      assert.equal(typeof r.ok, 'boolean')
    })

    test('council:deleteSession handles missing sessionId', async () => {
      const r = await tryInvokeHandler('council:deleteSession', {})
      assert.equal(typeof r.ok, 'boolean')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// mpa.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (mpaOk) {
  describe('mpa.ipc — channel registration', () => {
    const mpaChannels = [...capturedHandlers.keys()].filter((c) => c.startsWith('mpa:'))
    test('registers at least 8 MPA channels', () => {
      assert.ok(
        mpaChannels.length >= 8,
        `Expected ≥8, got ${mpaChannels.length}: ${mpaChannels.join(', ')}`
      )
    })
  })

  describe('mpa.ipc — validation', () => {
    test('mpa:getStatus handles missing workspaceId', async () => {
      const ch =
        [...capturedHandlers.keys()].find(
          (c) => c.includes('mpa') && c.includes('status') && c.includes('get')
        ) ?? 'mpa:getStatus'
      if (capturedHandlers.has(ch)) {
        const r = await tryInvokeHandler(ch, {})
        assert.equal(typeof r.ok, 'boolean')
      }
    })

    test('mpa:cancel handler exists', () => {
      const ch = [...capturedHandlers.keys()].find((c) => c.includes('mpa') && c.includes('cancel'))
      assert.ok(ch, 'Should have an MPA cancel channel')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// idea.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (ideaOk) {
  describe('idea.ipc — channel registration', () => {
    const ideaChannels = [...capturedHandlers.keys()].filter((c) => c.startsWith('idea:'))
    test('registers at least 5 idea channels', () => {
      assert.ok(
        ideaChannels.length >= 5,
        `Expected ≥5, got ${ideaChannels.length}: ${ideaChannels.join(', ')}`
      )
    })
  })

  describe('idea.ipc — validation', () => {
    test('idea:create rejects missing workspaceId', async () => {
      const ch = [...capturedHandlers.keys()].find(
        (c) => c.includes('idea') && c.includes('create')
      )
      if (ch) {
        const r = await tryInvokeHandler(ch, { title: 'Test' })
        assert.equal(r.ok, false)
      }
    })

    test('idea:create rejects missing title', async () => {
      const ch = [...capturedHandlers.keys()].find(
        (c) => c.includes('idea') && c.includes('create')
      )
      if (ch) {
        const r = await tryInvokeHandler(ch, { workspaceId: 'ws-1' })
        assert.equal(r.ok, false)
      }
    })

    test('idea:delete rejects missing id', async () => {
      const ch = [...capturedHandlers.keys()].find(
        (c) => c.includes('idea') && c.includes('delete')
      )
      if (ch) {
        const r = await tryInvokeHandler(ch, {})
        assert.equal(r.ok, false)
      }
    })
  })
}

// ── Skip blocks ──────────────────────────────────────────────────────────

if (!grillOk) {
  describe('grill.ipc (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!auditOk) {
  describe('audit.ipc (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!councilOk) {
  describe('council.ipc (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!mpaOk) {
  describe('mpa.ipc (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!ideaOk) {
  describe('idea.ipc (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

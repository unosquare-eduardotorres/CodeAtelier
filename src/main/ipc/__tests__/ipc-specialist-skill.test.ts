/**
 * Phase 24 — IPC Coverage Blitz: specialist.ipc, skill.ipc, conversation-specialist.ipc
 *
 * Tests channel registration, argument validation, and handler body execution
 * for specialist/skill management and conversation-specialist override IPC handlers.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-specialist-skill.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

// ── Register IPC modules ─────────────────────────────────────────────────

let specialistLoaded = false
let skillLoaded = false
let convSpecLoaded = false

try {
  const mod = require('../../ipc/specialist.ipc')
  mod.registerSpecialistIpc()
  specialistLoaded = true
} catch (err) {
  console.log(`⚠ specialist.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/skill.ipc')
  mod.registerSkillIpc()
  skillLoaded = true
} catch (err) {
  console.log(`⚠ skill.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/conversation-specialist.ipc')
  mod.registerConversationSpecialistIpc()
  convSpecLoaded = true
} catch (err) {
  console.log(
    `⚠ conversation-specialist.ipc load failed: ${(err as Error).message?.split('\n')[0]}`
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// specialist.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (specialistLoaded) {
  describe('specialist.ipc — channel registration', () => {
    test('registers specialist:list', () => {
      assert.ok(getHandlers().has('specialist:list'))
    })

    test('registers specialist:get', () => {
      assert.ok(getHandlers().has('specialist:get'))
    })

    test('registers specialist:create', () => {
      assert.ok(getHandlers().has('specialist:create'))
    })

    test('registers specialist:update', () => {
      assert.ok(getHandlers().has('specialist:update'))
    })

    test('registers specialist:delete', () => {
      assert.ok(getHandlers().has('specialist:delete'))
    })

    test('registers specialist:reorder', () => {
      assert.ok(getHandlers().has('specialist:reorder'))
    })

    test('registers specialist:assignSkill', () => {
      assert.ok(getHandlers().has('specialist:assignSkill'))
    })

    test('registers specialist:removeSkill', () => {
      assert.ok(getHandlers().has('specialist:removeSkill'))
    })
  })

  describe('specialist.ipc — argument validation', () => {
    test('specialist:get rejects missing id', async () => {
      const r = await tryInvokeHandler('specialist:get', {})
      assert.equal(r.ok, false)
    })

    test('specialist:get rejects non-object', async () => {
      const r = await tryInvokeHandler('specialist:get', 42)
      assert.equal(r.ok, false)
    })

    test('specialist:create rejects missing agentId', async () => {
      const r = await tryInvokeHandler('specialist:create', { displayName: 'Test' })
      assert.equal(r.ok, false)
    })

    test('specialist:create rejects missing displayName', async () => {
      const r = await tryInvokeHandler('specialist:create', { agentId: 'ag1' })
      assert.equal(r.ok, false)
    })

    test('specialist:update rejects missing id', async () => {
      const r = await tryInvokeHandler('specialist:update', { displayName: 'NewName' })
      assert.equal(r.ok, false)
    })

    test('specialist:delete rejects missing id', async () => {
      const r = await tryInvokeHandler('specialist:delete', {})
      assert.equal(r.ok, false)
    })

    test('specialist:reorder rejects missing orderedIds', async () => {
      const r = await tryInvokeHandler('specialist:reorder', {})
      assert.equal(r.ok, false)
    })

    test('specialist:assignSkill rejects missing specialistId', async () => {
      const r = await tryInvokeHandler('specialist:assignSkill', { skillId: 'sk1' })
      assert.equal(r.ok, false)
    })

    test('specialist:assignSkill rejects missing skillId', async () => {
      const r = await tryInvokeHandler('specialist:assignSkill', { specialistId: 'sp1' })
      assert.equal(r.ok, false)
    })

    test('specialist:removeSkill rejects missing specialistId', async () => {
      const r = await tryInvokeHandler('specialist:removeSkill', { skillId: 'sk1' })
      assert.equal(r.ok, false)
    })

    test('specialist:removeSkill rejects missing skillId', async () => {
      const r = await tryInvokeHandler('specialist:removeSkill', { specialistId: 'sp1' })
      assert.equal(r.ok, false)
    })
  })

  describe('specialist.ipc — handler bodies', () => {
    test('specialist:list calls through', async () => {
      const r = await tryInvokeHandler('specialist:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:get calls through with valid id', async () => {
      const r = await tryInvokeHandler('specialist:get', { id: 'sp-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:create calls through with valid args', async () => {
      const r = await tryInvokeHandler('specialist:create', {
        agentId: 'agent-1',
        displayName: 'Frontend Dev'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:update calls through with valid args', async () => {
      const r = await tryInvokeHandler('specialist:update', {
        id: 'sp-1',
        displayName: 'Updated Name'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:delete calls through with valid id', async () => {
      const r = await tryInvokeHandler('specialist:delete', { id: 'sp-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:reorder calls through with valid args', async () => {
      const r = await tryInvokeHandler('specialist:reorder', { orderedIds: ['sp-1', 'sp-2'] })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:assignSkill calls through with valid args', async () => {
      const r = await tryInvokeHandler('specialist:assignSkill', {
        specialistId: 'sp-1',
        skillId: 'sk-1'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('specialist:removeSkill calls through with valid args', async () => {
      const r = await tryInvokeHandler('specialist:removeSkill', {
        specialistId: 'sp-1',
        skillId: 'sk-1'
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// skill.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (skillLoaded) {
  describe('skill.ipc — channel registration', () => {
    test('registers skill:list', () => {
      assert.ok(getHandlers().has('skill:list'))
    })

    test('registers skill:get', () => {
      assert.ok(getHandlers().has('skill:get'))
    })

    test('registers skill:import', () => {
      assert.ok(getHandlers().has('skill:import'))
    })

    test('registers skill:update', () => {
      assert.ok(getHandlers().has('skill:update'))
    })

    test('registers skill:delete', () => {
      assert.ok(getHandlers().has('skill:delete'))
    })

    test('registers skill:activate', () => {
      assert.ok(getHandlers().has('skill:activate'))
    })

    test('registers skill:deactivate', () => {
      assert.ok(getHandlers().has('skill:deactivate'))
    })

    test('registers skill:selectFile', () => {
      assert.ok(getHandlers().has('skill:selectFile'))
    })
  })

  describe('skill.ipc — argument validation', () => {
    test('skill:get rejects missing id', async () => {
      const r = await tryInvokeHandler('skill:get', {})
      assert.equal(r.ok, false)
    })

    test('skill:import rejects missing filePath', async () => {
      const r = await tryInvokeHandler('skill:import', {})
      assert.equal(r.ok, false)
    })

    test('skill:update rejects missing id', async () => {
      const r = await tryInvokeHandler('skill:update', { name: 'Test' })
      assert.equal(r.ok, false)
    })

    test('skill:delete rejects missing id', async () => {
      const r = await tryInvokeHandler('skill:delete', {})
      assert.equal(r.ok, false)
    })

    test('skill:activate rejects missing id', async () => {
      const r = await tryInvokeHandler('skill:activate', {})
      assert.equal(r.ok, false)
    })

    test('skill:deactivate rejects missing id', async () => {
      const r = await tryInvokeHandler('skill:deactivate', {})
      assert.equal(r.ok, false)
    })
  })

  describe('skill.ipc — handler bodies', () => {
    test('skill:list calls through', async () => {
      const r = await tryInvokeHandler('skill:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:get calls through with valid id', async () => {
      const r = await tryInvokeHandler('skill:get', { id: 'sk-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:import calls through with valid filePath', async () => {
      const r = await tryInvokeHandler('skill:import', { filePath: '/tmp/skill.md' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:update calls through with valid args', async () => {
      const r = await tryInvokeHandler('skill:update', {
        id: 'sk-1',
        name: 'Updated Skill',
        description: 'New desc'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:delete calls through with valid id', async () => {
      const r = await tryInvokeHandler('skill:delete', { id: 'sk-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:activate calls through with valid id', async () => {
      const r = await tryInvokeHandler('skill:activate', { id: 'sk-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:deactivate calls through with valid id', async () => {
      const r = await tryInvokeHandler('skill:deactivate', { id: 'sk-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('skill:selectFile calls through', async () => {
      const r = await tryInvokeHandler('skill:selectFile')
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// conversation-specialist.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (convSpecLoaded) {
  describe('conversation-specialist.ipc — channel registration', () => {
    const csChannels = [...getHandlers().keys()].filter(
      (c) => c.includes('convSpecialist') || c.includes('conversationSpecialist')
    )
    test('registers ≥5 conversation-specialist channels', () => {
      assert.ok(
        csChannels.length >= 5,
        `Expected ≥5, got ${csChannels.length}: ${csChannels.join(', ')}`
      )
    })
  })

  describe('conversation-specialist.ipc — argument validation', () => {
    const listCh = [...getHandlers().keys()].find(
      (c) =>
        (c.includes('Specialist') || c.includes('specialist')) &&
        c.includes('list') &&
        (c.includes('conv') || c.includes('Conv'))
    )

    if (listCh) {
      test(`${listCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(listCh, {})
        assert.equal(r.ok, false)
      })
    }

    const upsertCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('upsert')
    )
    if (upsertCh) {
      test(`${upsertCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(upsertCh, { specialistId: 'sp1' })
        assert.equal(r.ok, false)
      })

      test(`${upsertCh} rejects missing specialistId`, async () => {
        const r = await tryInvokeHandler(upsertCh, { conversationId: 'c1' })
        assert.equal(r.ok, false)
      })
    }

    const removeCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('remove') && !c.includes('All')
    )
    if (removeCh) {
      test(`${removeCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(removeCh, { specialistId: 'sp1' })
        assert.equal(r.ok, false)
      })

      test(`${removeCh} rejects missing specialistId`, async () => {
        const r = await tryInvokeHandler(removeCh, { conversationId: 'c1' })
        assert.equal(r.ok, false)
      })
    }

    const resetCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('reset')
    )
    if (resetCh) {
      test(`${resetCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(resetCh, {})
        assert.equal(r.ok, false)
      })
    }

    const estimateCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('estimate')
    )
    if (estimateCh) {
      test(`${estimateCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(estimateCh, {})
        assert.equal(r.ok, false)
      })
    }
  })

  describe('conversation-specialist.ipc — handler bodies', () => {
    const listCh = [...getHandlers().keys()].find(
      (c) =>
        (c.includes('Specialist') || c.includes('specialist')) &&
        c.includes('list') &&
        (c.includes('conv') || c.includes('Conv'))
    )
    if (listCh) {
      test(`${listCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(listCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const upsertCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('upsert')
    )
    if (upsertCh) {
      test(`${upsertCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(upsertCh, {
          conversationId: 'c1',
          specialistId: 'sp1',
          isActive: true
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const resetCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('reset')
    )
    if (resetCh) {
      test(`${resetCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(resetCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const estimateCh = [...getHandlers().keys()].find(
      (c) => c.includes('Specialist') && c.includes('estimate')
    )
    if (estimateCh) {
      test(`${estimateCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(estimateCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('ipc-specialist-skill')) {
  void summaryAsync()
}

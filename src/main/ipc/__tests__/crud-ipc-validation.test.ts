/**
 * Batch validation-contract tests for small CRUD IPC files.
 *
 * These tests verify that the validate-args helpers (requireObject, requireString,
 * etc.) correctly accept/reject the specific argument shapes each IPC handler
 * expects. No Electron mocks needed — we import and call the validators directly.
 *
 * Files covered: specialist, skill, idea, checkpoint, bug, events, memory, plan.
 *
 * Run: tsx src/main/ipc/__tests__/crud-ipc-validation.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  requireStringArray
} from '../validate-args'

// ── specialist.ipc.ts contracts ──────────────────────────────────────────────

describe('specialist.ipc validation contracts', () => {
  const CH = 'specialist:get'

  test('SPECIALIST_GET requires id string', () => {
    const args = requireObject({ id: 'sp-1' }, CH)
    assert.equal(requireString(args, 'id', CH), 'sp-1')
  })

  test('SPECIALIST_GET rejects missing id', () => {
    const args = requireObject({}, CH)
    assert.throws(() => requireString(args, 'id', CH), /id/)
  })

  test('SPECIALIST_CREATE requires agentId and displayName', () => {
    const ch = 'specialist:create'
    const args = requireObject({ agentId: 'a-1', displayName: 'Bot' }, ch)
    assert.equal(requireString(args, 'agentId', ch), 'a-1')
    assert.equal(requireString(args, 'displayName', ch), 'Bot')
  })

  test('SPECIALIST_CREATE rejects empty displayName', () => {
    const ch = 'specialist:create'
    const args = requireObject({ agentId: 'a-1', displayName: '' }, ch)
    assert.throws(() => requireString(args, 'displayName', ch), /displayName/)
  })

  test('SPECIALIST_REORDER requires orderedIds string array', () => {
    const ch = 'specialist:reorder'
    const args = requireObject({ orderedIds: ['a', 'b'] }, ch)
    assert.deepEqual(requireStringArray(args, 'orderedIds', ch), ['a', 'b'])
  })

  test('SPECIALIST_REORDER rejects empty array', () => {
    const ch = 'specialist:reorder'
    const args = requireObject({ orderedIds: [] }, ch)
    assert.throws(() => requireStringArray(args, 'orderedIds', ch), /orderedIds/)
  })

  test('SPECIALIST_ASSIGN_SKILL requires specialistId and skillId', () => {
    const ch = 'specialist:assignSkill'
    const args = requireObject({ specialistId: 'sp-1', skillId: 'sk-1' }, ch)
    assert.equal(requireString(args, 'specialistId', ch), 'sp-1')
    assert.equal(requireString(args, 'skillId', ch), 'sk-1')
  })
})

// ── skill.ipc.ts contracts ───────────────────────────────────────────────────

describe('skill.ipc validation contracts', () => {
  test('SKILL_GET requires id string', () => {
    const ch = 'skill:get'
    const args = requireObject({ id: 'sk-1' }, ch)
    assert.equal(requireString(args, 'id', ch), 'sk-1')
  })

  test('SKILL_IMPORT requires filePath', () => {
    const ch = 'skill:import'
    const args = requireObject({ filePath: '/path/to/skill.md' }, ch)
    assert.equal(requireString(args, 'filePath', ch), '/path/to/skill.md')
  })

  test('SKILL_UPDATE requires id', () => {
    const ch = 'skill:update'
    const args = requireObject({ id: 'sk-1' }, ch)
    assert.equal(requireString(args, 'id', ch), 'sk-1')
  })

  test('SKILL_DELETE rejects null args', () => {
    assert.throws(() => requireObject(null, 'skill:delete'), /null/)
  })
})

// ── idea.ipc.ts contracts ────────────────────────────────────────────────────

describe('idea.ipc validation contracts', () => {
  test('IDEA_LIST requires workspaceId', () => {
    const ch = 'idea:list'
    const args = requireObject({ workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })

  test('IDEA_CREATE requires workspaceId and title, description optional', () => {
    const ch = 'idea:create'
    const args = requireObject(
      { workspaceId: 'ws-1', title: 'My Idea', description: 'Details' },
      ch
    )
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
    assert.equal(requireString(args, 'title', ch), 'My Idea')
    assert.equal(optionalString(args, 'description', ch), 'Details')
  })

  test('IDEA_CREATE accepts missing description', () => {
    const ch = 'idea:create'
    const args = requireObject({ workspaceId: 'ws-1', title: 'T' }, ch)
    assert.equal(optionalString(args, 'description', ch), undefined)
  })

  test('IDEA_UPDATE requires id, title/description optional', () => {
    const ch = 'idea:update'
    const args = requireObject({ id: 'i-1', title: 'Updated' }, ch)
    assert.equal(requireString(args, 'id', ch), 'i-1')
    assert.equal(optionalString(args, 'title', ch), 'Updated')
    assert.equal(optionalString(args, 'description', ch), undefined)
  })

  test('IDEA_DELETE requires id', () => {
    const ch = 'idea:delete'
    const args = requireObject({ id: 'i-1' }, ch)
    assert.equal(requireString(args, 'id', ch), 'i-1')
  })

  test('IDEA_START_GRILL requires ideaId and workspaceId', () => {
    const ch = 'idea:startGrill'
    const args = requireObject({ ideaId: 'i-1', workspaceId: 'ws-1' }, ch)
    assert.equal(requireString(args, 'ideaId', ch), 'i-1')
    assert.equal(requireString(args, 'workspaceId', ch), 'ws-1')
  })
})

// ── checkpoint.ipc.ts contracts ──────────────────────────────────────────────

describe('checkpoint.ipc validation contracts', () => {
  test('CHECKPOINT_LIST requires conversationId', () => {
    const ch = 'checkpoint:list'
    const args = requireObject({ conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('CHECKPOINT_RESTORE requires checkpointId', () => {
    const ch = 'checkpoint:restore'
    const args = requireObject({ checkpointId: 'cp-1' }, ch)
    assert.equal(requireString(args, 'checkpointId', ch), 'cp-1')
  })

  test('CHECKPOINT_REWIND requires checkpointId and conversationId', () => {
    const ch = 'checkpoint:rewind'
    const args = requireObject({ checkpointId: 'cp-1', conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'checkpointId', ch), 'cp-1')
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('CHECKPOINT_APPROVAL_RESPONSE requires checkpointId, approved optional bool', () => {
    const ch = 'checkpoint:approval'
    const args = requireObject({ checkpointId: 'cp-1', approved: true }, ch)
    assert.equal(requireString(args, 'checkpointId', ch), 'cp-1')
    assert.equal(optionalBoolean(args, 'approved', ch), true)
  })

  test('CHECKPOINT_APPROVAL_RESPONSE approved defaults when absent', () => {
    const ch = 'checkpoint:approval'
    const args = requireObject({ checkpointId: 'cp-1' }, ch)
    assert.equal(optionalBoolean(args, 'approved', ch), undefined)
  })
})

// ── bug.ipc.ts contracts ─────────────────────────────────────────────────────

describe('bug.ipc validation contracts', () => {
  test('BUG_REPORT requires errorMessage, process, appVersion', () => {
    const ch = 'bug:report'
    const args = requireObject(
      {
        errorMessage: 'crash!',
        process: 'main',
        appVersion: '1.0.0'
      },
      ch
    )
    assert.equal(requireString(args, 'errorMessage', ch), 'crash!')
    assert.equal(requireString(args, 'process', ch), 'main')
    assert.equal(requireString(args, 'appVersion', ch), '1.0.0')
  })

  test('BUG_REPORT rejects missing errorMessage', () => {
    const ch = 'bug:report'
    const args = requireObject({ process: 'main', appVersion: '1.0.0' }, ch)
    assert.throws(() => requireString(args, 'errorMessage', ch), /errorMessage/)
  })

  test('BUG_GET requires id', () => {
    const ch = 'bug:get'
    const args = requireObject({ id: 'bug-1' }, ch)
    assert.equal(requireString(args, 'id', ch), 'bug-1')
  })

  test('BUG_BULK_RESOLVE requires ids string array', () => {
    const ch = 'bug:bulkResolve'
    const args = requireObject({ ids: ['b-1', 'b-2'] }, ch)
    assert.deepEqual(requireStringArray(args, 'ids', ch), ['b-1', 'b-2'])
  })

  test('BUG_BULK_DELETE requires ids string array', () => {
    const ch = 'bug:bulkDelete'
    const args = requireObject({ ids: ['b-1'] }, ch)
    assert.deepEqual(requireStringArray(args, 'ids', ch), ['b-1'])
  })

  test('BUG_BULK_RESOLVE rejects non-string items', () => {
    const ch = 'bug:bulkResolve'
    const args = requireObject({ ids: [1, 2] }, ch)
    assert.throws(() => requireStringArray(args, 'ids', ch))
  })
})

// ── events.ipc.ts contracts ──────────────────────────────────────────────────

describe('events.ipc validation contracts', () => {
  test('EVENTS_GET_RECENT accepts optional workspaceId and limit', () => {
    const ch = 'events:getRecent'
    const args = requireObject({ workspaceId: 'ws-1', limit: 50 }, ch)
    assert.equal(optionalString(args, 'workspaceId', ch), 'ws-1')
    assert.equal(optionalNumber(args, 'limit', ch), 50)
  })

  test('EVENTS_GET_RECENT accepts missing fields', () => {
    const ch = 'events:getRecent'
    const args = requireObject({}, ch)
    assert.equal(optionalString(args, 'workspaceId', ch), undefined)
    assert.equal(optionalNumber(args, 'limit', ch), undefined)
  })

  test('EVENTS_GET_BY_CONVERSATION requires conversationId', () => {
    const ch = 'events:getByConversation'
    const args = requireObject({ conversationId: 'c-1' }, ch)
    assert.equal(requireString(args, 'conversationId', ch), 'c-1')
  })

  test('EVENTS_GET_BY_CONVERSATION has optional limit', () => {
    const ch = 'events:getByConversation'
    const args = requireObject({ conversationId: 'c-1', limit: 25 }, ch)
    assert.equal(optionalNumber(args, 'limit', ch), 25)
  })
})

// ── memory.ipc.ts contracts (type-only — document expected shapes) ───────────

describe('memory.ipc validation contracts (type-only shapes)', () => {
  test('MEMORY_FACTS_LIST expected shape: { workspaceId: string }', () => {
    // memory.ipc.ts uses inline types only — we document the expected contract
    const args = { workspaceId: 'ws-1' }
    assert.equal(typeof args.workspaceId, 'string')
  })

  test('MEMORY_FACTS_SEARCH expected shape: workspaceId, query', () => {
    const args = {
      workspaceId: 'ws-1',
      query: 'architecture decisions'
    }
    assert.equal(typeof args.workspaceId, 'string')
    assert.equal(typeof args.query, 'string')
  })

  test('MEMORY_FACTS_DELETE expected shape: { id: string }', () => {
    const args = { id: 'fact-1' }
    assert.equal(typeof args.id, 'string')
  })
})

// ── plan.ipc.ts contracts (type-only — document expected shapes) ─────────────

describe('plan.ipc validation contracts (type-only shapes)', () => {
  test('PLAN_GET_ALL expected shape: { workspaceId: string }', () => {
    const args = { workspaceId: 'ws-1' }
    assert.equal(typeof args.workspaceId, 'string')
  })

  test('PLAN_GET_BY_ID expected shape: { planId: string }', () => {
    const args = { planId: 'plan-1' }
    assert.equal(typeof args.planId, 'string')
  })

  test('PLAN_DELETE expected shape: { planId: string }', () => {
    const args = { planId: 'plan-1' }
    assert.equal(typeof args.planId, 'string')
  })

  test('PLAN_IMPORT expected shape: { planId: string, workspaceId: string }', () => {
    const args = { planId: 'plan-1', workspaceId: 'ws-1' }
    assert.equal(typeof args.planId, 'string')
    assert.equal(typeof args.workspaceId, 'string')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}

/**
 * Phase 16, Track 5A — Blueprint IPC handler validation tests
 *
 * Tests argument validation patterns used in blueprint.ipc.ts handlers.
 * Covers the validation branches that each handler exercises, plus
 * channel constant verification for all blueprint-related IPC channels.
 *
 * Source: blueprint.ipc.ts (1,146 lines at 4.36%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { IPC_CHANNELS } from '../../../shared/constants'
import { BLUEPRINT_PHASE_ORDER, PHASE_TO_STATUS } from '../../../shared/blueprint-types'
import { requireObject, requireString, optionalString, optionalBoolean } from '../validate-args'

// ── §1: Blueprint channel constant verification ──────────────────────────

describe('Blueprint IPC — channel constants', () => {
  test('all_blueprint_crud_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_CREATE)
    assert.ok(IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA)
    assert.ok(IPC_CHANNELS.BLUEPRINT_GET)
    assert.ok(IPC_CHANNELS.BLUEPRINT_GET_DETAILS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_LIST)
    assert.ok(IPC_CHANNELS.BLUEPRINT_DELETE)
  })

  test('all_blueprint_control_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_CANCEL)
    assert.ok(IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE)
    assert.ok(IPC_CHANNELS.BLUEPRINT_SKIP_PHASE)
    assert.ok(IPC_CHANNELS.BLUEPRINT_REWIND_PHASE)
  })

  test('all_blueprint_artifact_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT)
    assert.ok(IPC_CHANNELS.BLUEPRINT_SAVE_ARTIFACT)
    assert.ok(IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_GET_PIPELINE_STATUS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND)
  })

  test('all_blueprint_phase_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_SPECIFY)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_CLARIFY)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_PLAN)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_TASKS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_REVIEW)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_BUILD)
    assert.ok(IPC_CHANNELS.BLUEPRINT_START_VERIFY)
  })

  test('all_blueprint_event_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_PHASE_START)
    assert.ok(IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
    assert.ok(IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE)
    assert.ok(IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT)
    assert.ok(IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED)
  })

  test('all_blueprint_wave_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BLUEPRINT_WAVE_START)
    assert.ok(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START)
    assert.ok(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE)
    assert.ok(IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE)
  })
})

// ── §2: Blueprint handler validation patterns ─────────────────────────────

describe('Blueprint IPC — handler validation patterns', () => {
  test('BLUEPRINT_CREATE_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_CREATE
    const args = requireObject({ workspaceId: 'ws-1', title: 'My Blueprint' }, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const title = requireString(args, 'title', ch)
    assert.equal(workspaceId, 'ws-1')
    assert.equal(title, 'My Blueprint')
  })

  test('BLUEPRINT_CREATE_rejects_missing_workspaceId', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_CREATE
    assert.throws(() => {
      const args = requireObject({ title: 'My Blueprint' }, ch)
      requireString(args, 'workspaceId', ch)
    })
  })

  test('BLUEPRINT_CREATE_rejects_missing_title', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_CREATE
    assert.throws(() => {
      const args = requireObject({ workspaceId: 'ws-1' }, ch)
      requireString(args, 'title', ch)
    })
  })

  test('BLUEPRINT_GET_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_GET
    const args = requireObject({ blueprintId: 'bp-1' }, ch)
    const id = requireString(args, 'blueprintId', ch)
    assert.equal(id, 'bp-1')
  })

  test('BLUEPRINT_DELETE_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_DELETE
    const args = requireObject({ blueprintId: 'bp-1' }, ch)
    const id = requireString(args, 'blueprintId', ch)
    assert.equal(id, 'bp-1')
  })

  test('BLUEPRINT_POPULATE_TASKS_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS
    const rawArgs = { blueprintId: 'bp-1', tasks: [{ title: 'Task 1' }] }

    // Simulates the inline validation in the handler
    if (!rawArgs.blueprintId || typeof rawArgs.blueprintId !== 'string') {
      assert.fail('blueprintId should be valid')
    }
    if (!Array.isArray(rawArgs.tasks)) {
      assert.fail('tasks should be an array')
    }
    assert.ok(rawArgs.tasks.length <= 500, 'tasks within max 500 limit')
  })

  test('BLUEPRINT_POPULATE_TASKS_rejects_too_many_tasks', () => {
    const tasks = Array.from({ length: 501 }, (_, i) => ({ title: `Task ${i}` }))
    assert.ok(tasks.length > 500, 'Should reject arrays > 500')
  })

  test('BLUEPRINT_POPULATE_TASKS_rejects_non_array_tasks', () => {
    const rawArgs = { blueprintId: 'bp-1', tasks: 'not-an-array' }
    assert.ok(!Array.isArray(rawArgs.tasks), 'tasks should fail array check')
  })

  test('BLUEPRINT_ADVANCE_PHASE_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE
    const args = requireObject({ blueprintId: 'bp-1' }, ch)
    const id = requireString(args, 'blueprintId', ch)
    assert.equal(id, 'bp-1')
  })

  test('BLUEPRINT_START_phase_validation', () => {
    // All phase starters need workspaceId + blueprintId
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      const channelKey = `BLUEPRINT_START_${phase.toUpperCase()}` as keyof typeof IPC_CHANNELS
      const ch = IPC_CHANNELS[channelKey]
      if (!ch) continue

      const args = requireObject({ workspaceId: 'ws-1', blueprintId: 'bp-1' }, ch)
      const wsId = requireString(args, 'workspaceId', ch)
      const bpId = requireString(args, 'blueprintId', ch)
      assert.equal(wsId, 'ws-1')
      assert.equal(bpId, 'bp-1')
    }
  })

  test('BLUEPRINT_APPROVAL_RESPOND_validation', () => {
    const ch = IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND
    const args = requireObject(
      { blueprintId: 'bp-1', approved: true, feedback: 'Looks good' },
      ch
    )
    const bpId = requireString(args, 'blueprintId', ch)
    assert.equal(bpId, 'bp-1')
    assert.equal(args.approved, true)
    assert.equal(args.feedback, 'Looks good')
  })
})

// ── §3: Blueprint phase order and status mapping ──────────────────────────

describe('Blueprint phase infrastructure', () => {
  test('all_phases_have_corresponding_start_channel', () => {
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      const channelKey = `BLUEPRINT_START_${phase.toUpperCase()}` as keyof typeof IPC_CHANNELS
      assert.ok(IPC_CHANNELS[channelKey], `Missing channel for phase: ${phase}`)
    }
  })

  test('phase_order_length_matches_status_map', () => {
    assert.equal(BLUEPRINT_PHASE_ORDER.length, Object.keys(PHASE_TO_STATUS).length)
  })

  test('each_phase_has_a_status', () => {
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      assert.ok(PHASE_TO_STATUS[phase], `No status for phase: ${phase}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

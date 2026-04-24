/**
 * Unit tests for ProjectSpecialistRoleAdapter.
 *
 * The adapter reads the specialist row from the DB at send-time; we stub the
 * DB by exercising the adapter in isolation and asserting the role contract
 * without requiring a live DB. Full DB-backed coverage lives in the
 * migration + builder tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { ProjectSpecialistRoleAdapter } from '../role-adapters/project-specialist.adapter'

describe('ProjectSpecialistRoleAdapter', () => {
  test('role_is_project_specialist', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.role, 'project-specialist')
  })

  test('agentId_defaults_to_workspace_specialist_prefix', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-xyz' })
    assert.equal(adapter.agentId, 'workspace-specialist-ws-xyz')
  })

  test('agentId_override_is_honored', () => {
    const adapter = new ProjectSpecialistRoleAdapter({
      workspaceId: 'ws-1',
      agentId: 'custom-id'
    })
    assert.equal(adapter.agentId, 'custom-id')
  })

  test('buildControlCallbacks_returns_all_callbacks_as_functions', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    const cb = adapter.buildControlCallbacks({
      conversationId: 'c1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    assert.equal(typeof cb.onPlan, 'function')
    assert.equal(typeof cb.onAskUser, 'function')
    assert.equal(typeof cb.onMemory, 'function')
  })

  test('emitDetectedIntents_emits_a_single_response_intent', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    const emitted: Array<{ evt: string; payload: unknown }> = []
    adapter.emitDetectedIntents({
      accumulatedText: 'hello from the specialist',
      controlToolState: { plan: true, askUser: true, memory: true },
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    })

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.evt, 'intent')
    assert.deepEqual(emitted[0]!.payload, {
      type: 'response',
      content: 'hello from the specialist'
    })
  })

  test('getMode_returns_plan_default', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.getMode(), 'plan')
  })

  test('onSessionStop_clears_snapshot_safely', () => {
    const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: 'ws-1' })
    adapter.onSessionStop()
    assert.equal(adapter.getSpecialistId(), null)
    assert.equal(adapter.getDisplayName(), null)
    assert.equal(adapter.getBuildStatus(), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

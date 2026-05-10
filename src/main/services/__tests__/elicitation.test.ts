/**
 * Unit tests for ElicitationService — resolves pending elicitation callbacks
 * from the SDK. Small service (27 lines) with 2 core behaviors.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createElicitationService } from './helpers/agent-factory'

describe('ElicitationService', () => {
  test('resolveElicitation_ignores_unknown_requestId', () => {
    const { service } = createElicitationService()
    // Should not throw or crash when resolving an unknown requestId
    service.resolveElicitation('nonexistent-id', { action: 'accept' })
    // If we reach here without throwing, the test passes
    assert.ok(true, 'No crash on unknown requestId')
  })

  test('resolveElicitation_resolves_pending_and_removes', () => {
    const { service } = createElicitationService()

    let resolvedWith: { action: string; content?: Record<string, unknown> } | null = null

    // Manually inject a pending elicitation to simulate SDK registration
    const pendingMap = (service as any).pendingElicitations as Map<
      string,
      { resolve: (result: any) => void; serverName: string }
    >
    pendingMap.set('req-1', {
      resolve: (result) => {
        resolvedWith = result
      },
      serverName: 'test-server'
    })

    // Verify the pending entry exists
    assert.equal(pendingMap.size, 1, 'Should have 1 pending elicitation')

    // Resolve it
    service.resolveElicitation('req-1', { action: 'accept', content: { name: 'test' } })

    // Callback should have been fired with the result
    assert.deepEqual(resolvedWith, { action: 'accept', content: { name: 'test' } })

    // Entry should be removed from the map
    assert.equal(pendingMap.size, 0, 'Pending entry should be removed after resolve')
  })

  test('resolveElicitation_with_decline_action', () => {
    const { service } = createElicitationService()
    const pendingMap = (service as any).pendingElicitations as Map<
      string,
      { resolve: (result: any) => void; serverName: string }
    >
    let resolved: unknown = null
    pendingMap.set('req-2', {
      resolve: (r) => {
        resolved = r
      },
      serverName: 'svr'
    })
    service.resolveElicitation('req-2', { action: 'decline' })
    assert.deepEqual(resolved, { action: 'decline' })
  })

  test('resolveElicitation_with_cancel_action', () => {
    const { service } = createElicitationService()
    const pendingMap = (service as any).pendingElicitations as Map<
      string,
      { resolve: (result: any) => void; serverName: string }
    >
    let resolved: unknown = null
    pendingMap.set('req-3', {
      resolve: (r) => {
        resolved = r
      },
      serverName: 'svr'
    })
    service.resolveElicitation('req-3', { action: 'cancel' })
    assert.deepEqual(resolved, { action: 'cancel' })
  })

  test('double_resolveElicitation_is_safe_no_double_callback', () => {
    const { service } = createElicitationService()
    const pendingMap = (service as any).pendingElicitations as Map<
      string,
      { resolve: (result: any) => void; serverName: string }
    >
    let callCount = 0
    pendingMap.set('req-4', {
      resolve: () => {
        callCount++
      },
      serverName: 'svr'
    })
    service.resolveElicitation('req-4', { action: 'accept' })
    service.resolveElicitation('req-4', { action: 'accept' }) // second call — entry already gone
    assert.equal(callCount, 1, 'callback fires exactly once')
  })

  test('concurrent_pending_elicitations_resolve_independently', () => {
    const { service } = createElicitationService()
    const pendingMap = (service as any).pendingElicitations as Map<
      string,
      { resolve: (result: any) => void; serverName: string }
    >
    const resolutions: Record<string, { action: string; content?: Record<string, unknown> }> = {}
    for (const id of ['a', 'b', 'c']) {
      pendingMap.set(id, {
        resolve: (r) => {
          resolutions[id] = r
        },
        serverName: 'svr'
      })
    }
    assert.equal(pendingMap.size, 3)

    service.resolveElicitation('b', { action: 'accept', content: { v: 'b-value' } })
    assert.equal(pendingMap.size, 2)
    assert.deepEqual(resolutions.b, { action: 'accept', content: { v: 'b-value' } })

    service.resolveElicitation('a', { action: 'decline' })
    service.resolveElicitation('c', { action: 'cancel' })
    assert.equal(pendingMap.size, 0)
    assert.equal(resolutions.a.action, 'decline')
    assert.equal(resolutions.c.action, 'cancel')
  })
})

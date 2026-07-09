/**
 * Blueprint store guard — pure function tests.
 *
 * Validates:
 * 1. resolveBlueprintEventAction — adopt-or-drop guard for workspace matching
 * 2. shouldDropCancelledEvent — blocks late IPC events for recently-cancelled blueprints
 *
 * Pure logic: no filesystem, no network, no Electron/React dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// Import the pure function directly from the store module
// Note: In the actual store file it's exported as a named export.
// For test isolation, we replicate the logic here since the store
// file imports React/zustand which can't run in Node.
function resolveBlueprintEventAction(
  activeWorkspaceId: string | null,
  viewedWorkspaceId: string | null,
  eventWorkspaceId: string
): 'process' | 'adopt' | 'drop' {
  if (activeWorkspaceId === eventWorkspaceId) return 'process'
  if (!activeWorkspaceId && viewedWorkspaceId === eventWorkspaceId) return 'adopt'
  return 'drop'
}

/**
 * Replicated from blueprint.store.ts shouldDropCancelledEvent.
 * Returns true if the blueprintId is in the recently-cancelled set.
 */
function shouldDropCancelledEvent(
  cancelledIds: ReadonlySet<string>,
  blueprintId: string
): boolean {
  return cancelledIds.has(blueprintId)
}

// ── process path ──

describe('resolveBlueprintEventAction — process', () => {
  test('event matches active workspace → process', () => {
    assert.equal(resolveBlueprintEventAction('ws-1', 'ws-1', 'ws-1'), 'process')
  })

  test('event matches active workspace (different from viewed) → process', () => {
    assert.equal(resolveBlueprintEventAction('ws-1', 'ws-2', 'ws-1'), 'process')
  })

  test('event matches active workspace (viewed is null) → process', () => {
    assert.equal(resolveBlueprintEventAction('ws-1', null, 'ws-1'), 'process')
  })
})

// ── adopt path (self-healing) ──

describe('resolveBlueprintEventAction — adopt', () => {
  test('no active workspace + event matches viewed → adopt', () => {
    assert.equal(resolveBlueprintEventAction(null, 'ws-1', 'ws-1'), 'adopt')
  })
})

// ── drop path ──

describe('resolveBlueprintEventAction — drop', () => {
  test('event does not match active workspace → drop', () => {
    assert.equal(resolveBlueprintEventAction('ws-1', 'ws-1', 'ws-2'), 'drop')
  })

  test('no active workspace + event does not match viewed → drop', () => {
    assert.equal(resolveBlueprintEventAction(null, 'ws-1', 'ws-2'), 'drop')
  })

  test('no active workspace + no viewed workspace → drop', () => {
    assert.equal(resolveBlueprintEventAction(null, null, 'ws-1'), 'drop')
  })

  test('different active workspace, different viewed workspace → drop', () => {
    assert.equal(resolveBlueprintEventAction('ws-1', 'ws-2', 'ws-3'), 'drop')
  })
})

// ── shouldDropCancelledEvent ──

describe('shouldDropCancelledEvent — drops cancelled ids', () => {
  test('returns true when blueprintId is in cancelled set', () => {
    const cancelled = new Set(['bp-1', 'bp-2'])
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-1'), true)
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-2'), true)
  })

  test('returns false when blueprintId is NOT in cancelled set', () => {
    const cancelled = new Set(['bp-1'])
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-999'), false)
  })

  test('returns false for empty set', () => {
    const cancelled = new Set<string>()
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-1'), false)
  })
})

describe('shouldDropCancelledEvent — cleared after retry', () => {
  test('removing id from set allows events through again', () => {
    const cancelled = new Set(['bp-1'])
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-1'), true)

    // Simulate retryPhase clearing the entry
    cancelled.delete('bp-1')
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-1'), false)
  })

  test('other ids remain blocked when one is cleared', () => {
    const cancelled = new Set(['bp-1', 'bp-2'])
    cancelled.delete('bp-1')
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-1'), false)
    assert.equal(shouldDropCancelledEvent(cancelled, 'bp-2'), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

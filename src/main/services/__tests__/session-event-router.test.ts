/**
 * Unit tests for session-event-router.ts — IPC dispatch with workspaceId tagging.
 *
 * `electron` is a type-only import (erased), so a mock window with a spied
 * webContents.send drives the class. The module singleton is exercised via
 * init→get (no reset export, so the uninitialized-throw branch is order-
 * dependent and intentionally not asserted in the aggregate runner).
 */
import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { test, describe, summaryAsync, createSpy } from './test-harness'
import type { Spy } from './test-harness'
import {
  SessionEventRouter,
  initSessionEventRouter,
  getSessionEventRouter
} from '../session-event-router'
import { IPC_CHANNELS } from '../../../shared/constants'

function mockWindow(): { window: BrowserWindow; send: Spy<[string, unknown], void> } {
  const send = createSpy<[string, unknown], void>()
  const window = {
    isDestroyed: () => false,
    webContents: { send }
  } as unknown as BrowserWindow
  return { window, send }
}

describe('SessionEventRouter', () => {
  test('send forwards channel + payload to webContents.send', () => {
    const { window, send } = mockWindow()
    const router = new SessionEventRouter(window)
    const payload = { workspaceId: 'ws1', foo: 'bar' }
    router.send('my-channel', payload)
    assert.equal(send.callCount, 1)
    assert.deepEqual(send.calls[0], ['my-channel', payload])
  })

  test('sendWorkspaceEvent injects workspaceId into the payload', () => {
    const { window, send } = mockWindow()
    const router = new SessionEventRouter(window)
    router.sendWorkspaceEvent('chan', 'ws-42', { status: 'busy' })
    const [channel, payload] = send.calls[0] as [string, Record<string, unknown>]
    assert.equal(channel, 'chan')
    assert.equal(payload.workspaceId, 'ws-42')
    assert.equal(payload.status, 'busy')
  })

  test('sendPermissionRequest uses the PERMISSION_REQUEST channel', () => {
    const { window, send } = mockWindow()
    const router = new SessionEventRouter(window)
    const permission = { workspaceId: 'ws1', permissionId: 'p1' } as never
    router.sendPermissionRequest(permission)
    const [channel] = send.calls[0]
    assert.equal(channel, IPC_CHANNELS.PERMISSION_REQUEST)
  })
})

describe('SessionEventRouter singleton', () => {
  test('init then get returns a working instance', () => {
    const { window, send } = mockWindow()
    initSessionEventRouter(window)
    const router = getSessionEventRouter()
    router.send('c', { workspaceId: 'w' })
    assert.equal(send.callCount, 1)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

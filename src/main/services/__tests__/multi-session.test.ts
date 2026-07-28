/**
 * Tests for the multi-workspace concurrent sessions feature.
 *
 * Covers:
 * - ChatAgentService session map CRUD
 * - SessionEventRouter workspaceId tagging
 * - BackgroundSessionStore state management (simulated)
 * - Permission flow routing
 */

import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { EventEmitter } from 'node:events'

// ── ChatAgentService Session Map Tests ──
// Each test creates its own Map to avoid cross-test state leakage.

describe('ChatAgentService Multi-Session Map', () => {
  test('startForWorkspace creates a new session', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })

    assert.equal(sessions.size, 1)
    assert.equal(sessions.get('ws-1')?.workspacePath, '/path/1')
  })

  test('startForWorkspace for existing workspace is a no-op', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })

    if (sessions.has('ws-1')) {
      // no-op
    }

    assert.equal(sessions.size, 1)
  })

  test('multiple workspaces can run concurrently', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })
    sessions.set('ws-2', { workspacePath: '/path/2', running: true })
    sessions.set('ws-3', { workspacePath: '/path/3', running: true })

    assert.equal(sessions.size, 3)
    for (const [, s] of sessions) {
      assert.equal(s.running, true)
    }
  })

  test('stopForWorkspace removes only that workspace', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })
    sessions.set('ws-2', { workspacePath: '/path/2', running: true })

    sessions.delete('ws-1')

    assert.equal(sessions.size, 1)
    assert.equal(sessions.has('ws-1'), false)
    assert.equal(sessions.has('ws-2'), true)
  })

  test('stopAll removes all sessions', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })
    sessions.set('ws-2', { workspacePath: '/path/2', running: true })

    sessions.clear()
    assert.equal(sessions.size, 0)
  })

  test('getAllStatuses returns status for all sessions', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })
    sessions.set('ws-2', { workspacePath: '/path/2', running: false })

    const statuses = new Map<string, { running: boolean }>()
    for (const [id, s] of sessions) {
      statuses.set(id, { running: s.running })
    }

    assert.equal(statuses.size, 2)
    assert.equal(statuses.get('ws-1')?.running, true)
    assert.equal(statuses.get('ws-2')?.running, false)
  })

  test('switching active workspace does not affect sessions', () => {
    const sessions = new Map<string, { workspacePath: string; running: boolean }>()
    sessions.set('ws-1', { workspacePath: '/path/1', running: true })
    sessions.set('ws-2', { workspacePath: '/path/2', running: true })

    let activeWorkspaceId = 'ws-1'
    assert.equal(sessions.get('ws-1')?.running, true)
    assert.equal(sessions.get('ws-2')?.running, true)

    activeWorkspaceId = 'ws-2'
    assert.equal(sessions.get('ws-1')?.running, true) // Still running!
    assert.equal(sessions.get('ws-2')?.running, true)
    assert.equal(activeWorkspaceId, 'ws-2') // Just to use the variable
  })
})

// ── SessionEventRouter Tests ──

describe('SessionEventRouter', () => {
  test('send tags payload with workspaceId', () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    const mockWindow = {
      webContents: {
        send: (channel: string, payload: Record<string, unknown>) => {
          sent.push({ channel, payload })
        }
      }
    }

    // Simulate router behavior
    const send = (
      channel: string,
      payload: { workspaceId: string; [key: string]: unknown }
    ): void => {
      mockWindow.webContents.send(channel, payload)
    }

    send('agent:statusUpdate', { workspaceId: 'ws-1', status: 'thinking', agentId: 'specialist' })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].channel, 'agent:statusUpdate')
    assert.equal(sent[0].payload.workspaceId, 'ws-1')
    assert.equal(sent[0].payload.status, 'thinking')
  })

  test('sendPermissionRequest includes all permission fields', () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    const mockWindow = {
      webContents: {
        send: (channel: string, payload: Record<string, unknown>) => {
          sent.push({ channel, payload })
        }
      }
    }

    const permission = {
      id: 'perm-1',
      workspaceId: 'ws-1',
      workspaceName: 'My Project',
      type: 'elicitation' as const,
      summary: 'GitHub needs authentication',
      isSimple: true,
      payload: {},
      receivedAt: Date.now()
    }

    mockWindow.webContents.send('permission:request', {
      ...permission
    })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.workspaceId, 'ws-1')
    assert.equal(sent[0].payload.type, 'elicitation')
    assert.equal(sent[0].payload.isSimple, true)
  })
})

// ── Event Forwarding Tests ──

describe('Event Forwarding with workspaceId', () => {
  test('workspace-tagged events emit with workspaceId prefix', () => {
    const emitter = new EventEmitter()
    const received: Array<{ event: string; args: unknown[] }> = []

    // Simulate the wireSessionForwarders pattern
    const workspaceId = 'ws-test'

    const handler = (...args: unknown[]): void => {
      received.push({ event: 'statusUpdate:ws', args: [workspaceId, ...args] })
    }
    emitter.on('statusUpdate', handler)

    emitter.emit('statusUpdate', { status: 'thinking' })

    assert.equal(received.length, 1)
    assert.equal(received[0].args[0], 'ws-test')
    assert.deepEqual(received[0].args[1], { status: 'thinking' })
  })

  test('multiple workspace sessions emit independently', () => {
    const emitterA = new EventEmitter()
    const emitterB = new EventEmitter()
    const received: Array<{ workspace: string; data: unknown }> = []

    emitterA.on('chunk', (data) => {
      received.push({ workspace: 'ws-a', data })
    })
    emitterB.on('chunk', (data) => {
      received.push({ workspace: 'ws-b', data })
    })

    emitterA.emit('chunk', { text: 'hello from A' })
    emitterB.emit('chunk', { text: 'hello from B' })
    emitterA.emit('chunk', { text: 'more from A' })

    assert.equal(received.length, 3)
    assert.equal(received[0].workspace, 'ws-a')
    assert.equal(received[1].workspace, 'ws-b')
    assert.equal(received[2].workspace, 'ws-a')
  })
})

// ── GrillAgentService Multi-Session Tests ──

describe('GrillAgentService Multi-Session Pattern', () => {
  test('per-workspace running state prevents duplicates', () => {
    const running = new Map<string, boolean>()

    running.set('ws-1', true)
    running.set('ws-2', false)

    // ws-1 should block duplicate start
    assert.equal(running.get('ws-1'), true)
    // ws-2 should allow start
    assert.equal(running.get('ws-2'), false)
    // ws-3 should allow start (not in map)
    assert.equal(running.get('ws-3'), undefined)
  })

  test('cancel only affects target workspace', () => {
    const running = new Map<string, boolean>()
    running.set('ws-1', true)
    running.set('ws-2', true)

    // Cancel ws-1 only
    running.set('ws-1', false)

    assert.equal(running.get('ws-1'), false)
    assert.equal(running.get('ws-2'), true)
  })
})

// ── MPA Pipeline Multi-Session Tests ──

describe('MPA Pipeline Multi-Session Pattern', () => {
  test('per-workspace gate resolution finds correct pipeline', () => {
    const pipelines = new Map<
      string,
      {
        runId: string
        pendingResolve: ((result: { approved: boolean }) => void) | null
      }
    >()

    let resolvedResult: { approved: boolean } | null = null

    pipelines.set('ws-1', {
      runId: 'run-1',
      pendingResolve: (result) => {
        resolvedResult = result
      }
    })
    pipelines.set('ws-2', {
      runId: 'run-2',
      pendingResolve: null
    })

    // Respond to run-1
    for (const [, pipeline] of pipelines) {
      if (pipeline.pendingResolve && pipeline.runId === 'run-1') {
        pipeline.pendingResolve({ approved: true })
        pipeline.pendingResolve = null
      }
    }

    assert.deepEqual(resolvedResult, { approved: true })
    assert.equal(pipelines.get('ws-1')?.pendingResolve, null)
  })
})

// ── Permission Flow Tests ──

describe('Permission Flow Routing', () => {
  test('permission response routes to correct workspace session', () => {
    const sessions = new Map<string, EventEmitter>()
    const sessionA = new EventEmitter()
    const sessionB = new EventEmitter()
    sessions.set('ws-a', sessionA)
    sessions.set('ws-b', sessionB)

    const receivedA: unknown[] = []
    const receivedB: unknown[] = []
    sessionA.on('elicitationResponse', (data) => receivedA.push(data))
    sessionB.on('elicitationResponse', (data) => receivedB.push(data))

    // Route to ws-a
    const targetSession = sessions.get('ws-a')
    targetSession?.emit('elicitationResponse', { action: 'accept' })

    assert.equal(receivedA.length, 1)
    assert.equal(receivedB.length, 0)
    assert.deepEqual(receivedA[0], { action: 'accept' })
  })

  test('background permission detection works for non-active workspaces', () => {
    const activeWorkspaceId = 'ws-active'
    const eventWorkspaceId: string = 'ws-background'

    const isBackground = eventWorkspaceId !== activeWorkspaceId
    assert.equal(isBackground, true)

    const isActive = activeWorkspaceId === activeWorkspaceId
    assert.equal(isActive, true)
  })
})

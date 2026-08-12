/**
 * Tests for NotificationService — OS notification dispatcher.
 *
 * Verifies: window-state routing, rate limiting, preference toggle,
 * dock bounce, title building, sound mapping, and fallback behavior.
 *
 * Note: Each test creates its own service instance because the test harness
 * runs tests concurrently (Promise.all).
 */

import assert from 'node:assert/strict'
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync } from './test-harness'

// Install electron stubs BEFORE importing the service
setupElectronStub()

// Access the notification mock state from the electron mock

const electronMock = require('./__electron_mock.cjs')

// ── Import the service under test (after stub is active) ────────────────────

const { NotificationService } = require('../notification.service') as {
  NotificationService: new () => {
    setMainWindow: (win: unknown) => void
    setEnabled: (enabled: boolean) => void
    isEnabled: () => boolean
    dispatch: (notification: {
      workspaceId: string
      workspaceName: string
      service: string
      status: string
      summary: string
      targetPage?: string
      entityId?: string
    }) => void
  }
}

// ── Mock Window Factory ─────────────────────────────────────────────────────

function createMockWindow(
  opts: {
    visible?: boolean
    focused?: boolean
  } = {}
): {
  isVisible: () => boolean
  isFocused: () => boolean
  isMinimized: () => boolean
  isDestroyed: () => boolean
  show: () => void
  restore: () => void
  focus: () => void
  webContents: { send: (channel: string, ...args: unknown[]) => void }
  sentMessages: { channel: string; args: unknown[] }[]
} {
  const sentMessages: { channel: string; args: unknown[] }[] = []
  return {
    isVisible: () => opts.visible ?? true,
    isFocused: () => opts.focused ?? true,
    isMinimized: () => false,
    isDestroyed: () => false,
    show: () => {},
    restore: () => {},
    focus: () => {},
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        sentMessages.push({ channel, args })
      }
    },
    sentMessages
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNotification(overrides: Record<string, unknown> = {}): {
  workspaceId: string
  workspaceName: string
  service: string
  status: string
  summary: string
  targetPage?: string
  entityId?: string
} {
  return {
    workspaceId: 'ws-123',
    workspaceName: 'Test Workspace',
    service: 'audit',
    status: 'completed',
    summary: 'Audit complete — score 85',
    targetPage: 'audit',
    ...overrides
  }
}

/** Create a fresh service + window pair (isolated per test) */
function setup(windowOpts?: { visible?: boolean; focused?: boolean }): {
  service: InstanceType<typeof NotificationService>
  win: ReturnType<typeof createMockWindow>
} {
  const service = new NotificationService()
  const win = createMockWindow(windowOpts)
  service.setMainWindow(win)
  return { service, win }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  test('sends in-app toast when window is focused', () => {
    const { service, win } = setup({ visible: true, focused: true })

    service.dispatch(makeNotification())

    assert.equal(win.sentMessages.length, 1)
    assert.equal(win.sentMessages[0].channel, 'workspace:completion')
  })

  test('sends in-app toast + dock bounce when visible but not focused', () => {
    const { service, win } = setup({ visible: true, focused: false })

    service.dispatch(makeNotification({ service: 'vis-unfocused-test' }))

    assert.equal(win.sentMessages.length, 1, 'should send in-app toast')
  })

  test('shows OS notification when window is hidden', () => {
    const { service, win } = setup({ visible: false, focused: false })

    // Use unique service name to avoid cross-test rate limiting
    service.dispatch(makeNotification({ service: 'hidden-test' }))

    assert.equal(win.sentMessages.length, 0, 'should NOT send in-app toast when hidden')
    // OS notification should have been created
    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated, 'should show OS notification')
    assert.equal(lastCreated._shown, true)
  })

  test('uses critical dock bounce for needs_input status', () => {
    const { service } = setup({ visible: true, focused: false })

    service.dispatch(makeNotification({ status: 'needs_input', service: 'critical-bounce-test' }))

    assert.equal(electronMock.__notificationMock.lastDockBounceType, 'critical')
  })

  test('does not dispatch when disabled', () => {
    const { service, win } = setup({ visible: true, focused: true })
    service.setEnabled(false)

    service.dispatch(makeNotification({ service: 'disabled-test' }))

    assert.equal(win.sentMessages.length, 0)
  })

  test('re-enables after being disabled', () => {
    const { service, win } = setup({ visible: true, focused: true })
    service.setEnabled(false)
    assert.equal(service.isEnabled(), false)

    service.setEnabled(true)
    assert.equal(service.isEnabled(), true)

    service.dispatch(makeNotification({ service: 're-enable-test' }))
    assert.equal(win.sentMessages.length, 1)
  })

  test('rate-limits notifications per service', () => {
    const { service, win } = setup({ visible: true, focused: true })

    service.dispatch(makeNotification({ service: 'rate-limit-svc' }))
    assert.equal(win.sentMessages.length, 1)

    // Same service within 3s — should be rate-limited
    service.dispatch(makeNotification({ service: 'rate-limit-svc' }))
    assert.equal(win.sentMessages.length, 1, 'second dispatch should be rate-limited')

    // Different service should NOT be rate-limited
    service.dispatch(makeNotification({ service: 'rate-limit-svc-2' }))
    assert.equal(win.sentMessages.length, 2, 'different service should pass')
  })

  test('builds correct title — completed', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'completed', service: 'grill' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated, 'should create OS notification')
    assert.equal(lastCreated.title, 'Grill Me — ✓ Complete')
  })

  test('builds correct title — failed', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'failed', service: 'mpa' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated)
    assert.equal(lastCreated.title, 'Multi-Phase Agent — ✗ Failed')
  })

  test('builds correct title — needs_input', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'needs_input', service: 'blueprint' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated)
    assert.equal(lastCreated.title, 'Blueprint — ⏸ Needs Your Input')
  })

  test('falls back to in-app when Notification not supported', () => {
    electronMock.__notificationMock.supported = false
    const { service, win } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ service: 'fallback-test' }))

    assert.equal(win.sentMessages.length, 1, 'should fallback to in-app toast')
    // Restore for other tests
    electronMock.__notificationMock.supported = true
  })

  test('uses Glass sound for needs_input (macOS) or silent (other)', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'needs_input', service: 'sound-glass-test' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated)
    if (process.platform === 'darwin') {
      assert.equal(lastCreated.sound, 'Glass')
    } else {
      assert.equal(lastCreated.sound, undefined)
    }
  })

  test('uses Purr sound for completed (macOS) or silent (other)', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'completed', service: 'sound-purr-test' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated)
    if (process.platform === 'darwin') {
      assert.equal(lastCreated.sound, 'Purr')
    } else {
      assert.equal(lastCreated.sound, undefined)
    }
  })

  test('uses Basso sound for failed (macOS) or silent (other)', () => {
    const { service } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ status: 'failed', service: 'sound-basso-test' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated)
    if (process.platform === 'darwin') {
      assert.equal(lastCreated.sound, 'Basso')
    } else {
      assert.equal(lastCreated.sound, undefined)
    }
  })

  test('falls back to in-app when OS notification fails at show-time', () => {
    const { service, win } = setup({ visible: false, focused: false })

    service.dispatch(makeNotification({ service: 'failed-event-test' }))

    const lastCreated = electronMock.__notificationMock.lastCreated
    assert.ok(lastCreated, 'should create OS notification')
    assert.equal(win.sentMessages.length, 0, 'no in-app toast yet')

    // Simulate OS notification failure (common in unsigned dev builds)
    const failedHandlers = lastCreated._listeners['failed']
    assert.ok(
      failedHandlers && failedHandlers.length > 0,
      'should have registered a failed handler'
    )
    failedHandlers[0](null, 'Notification failed: unsigned build')

    // Should have sent in-app fallback
    assert.equal(win.sentMessages.length, 1, 'should fall back to in-app toast')
    assert.equal(win.sentMessages[0].channel, 'workspace:completion')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * API-ERROR-FAIL — clarify turn that died with an API/model error must FAIL
 * the phase instead of degrading to the awaitingInput free-text fallback.
 *
 * Regression guard for the GLM `api_error` strand: a turn with no parseable
 * blocks AND terminalReason=api_error used to send the corrective nudge (which
 * cannot fix a dead API call), then fall through to clarifyAwaitingInput —
 * stranding the user with no retry path.
 *
 * Strategy: construct BlueprintSpecService with a mocked blueprintService
 * (getMachine), seed clarifySessions with a fake session carrying
 * lastTerminalReason, and drive handleClarifyTurnEnd via (any) private access.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, describe } from './test-harness'

// ── Module loading ───────────────────────────────────────────────────
let BlueprintSpecService: any
let ClarifyApiError: any
let specLoaded = false

try {
  const mod = require('../blueprint-spec.service')
  BlueprintSpecService = mod.BlueprintSpecService
  ClarifyApiError = mod.ClarifyApiError
  specLoaded = true
} catch (err) {
  console.log(`⚠ blueprint-spec.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

/** Minimal BlueprintStateMachine stand-in — records transitions + emits. */
class FakeMachine extends EventEmitter {
  transitions: string[] = []
  currentState = 'phase-running'
  transition(event: string): boolean {
    this.transitions.push(event)
    if (event === 'awaitingInput') this.currentState = 'awaiting-clarify-input'
    return true
  }
  isAwaitingInput(): boolean {
    return this.currentState.startsWith('awaiting')
  }
}

/** Minimal AgentSessionService stand-in. */
class FakeSession extends EventEmitter {
  sent: string[] = []
  async send(msg: string): Promise<void> {
    this.sent.push(msg)
  }
  getStreamedContent(): string {
    return ''
  }
  async stop(): Promise<void> {}
}

function makeService(): { svc: any; machine: FakeMachine; restore: () => void } {
  const machine = new FakeMachine()
  const svc = new BlueprintSpecService()
  // Mock blueprintService.getMachine — the only collaborator handleClarifyTurnEnd needs.
  const blueprintService = require('../blueprint.service').blueprintService as any
  const origGetMachine = blueprintService.getMachine
  blueprintService.getMachine = () => machine
  return {
    svc,
    machine,
    restore(): void {
      blueprintService.getMachine = origGetMachine
    }
  }
}

describe('clarify api_error terminal reason (API-ERROR-FAIL)', () => {
  if (!specLoaded) {
    test('module unavailable — skipped', () => {
      assert.ok(true)
    })
    return
  }

  test('ClarifyApiError is exported and carries the terminal reason', () => {
    const err = new ClarifyApiError('api_error')
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'ClarifyApiError')
    assert.ok(err.message.includes('api_error'))
    assert.ok(err.message.includes('Retry'))
  })

  test('api_error + no parseable blocks → throws (phase fails), no awaitingInput', async () => {
    const { svc, machine, restore } = makeService()
    try {
      const session = new FakeSession()
      ;(svc as any).clarifySessions.set('bp-1', {
        session,
        conversationId: 'conv-1',
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        activeWatchdog: null,
        pendingAskUserRequestId: null,
        lastTerminalReason: 'api_error'
      })

      const events: string[] = []
      svc.on('clarifyAwaitingInput', () => events.push('awaitingInput'))

      await assert.rejects(
        () => (svc as any).handleClarifyTurnEnd('bp-1', 'ws-1', 'Model errored out mid-turn.'),
        (err: Error) => err instanceof ClarifyApiError || err.name === 'ClarifyApiError'
      )

      // No nudge was sent (a dead API call can't be nudged)
      assert.equal(session.sent.length, 0, 'no corrective nudge on api_error')
      // No awaitingInput transition or emit
      assert.equal(
        machine.transitions.includes('awaitingInput'),
        false,
        'machine must not enter awaitingInput on api_error'
      )
      assert.equal(events.length, 0, 'no clarifyAwaitingInput emit on api_error')
    } finally {
      restore()
    }
  })

  test('model_error + no parseable blocks → throws', async () => {
    const { svc, restore } = makeService()
    try {
      ;(svc as any).clarifySessions.set('bp-2', {
        session: new FakeSession(),
        conversationId: 'conv-2',
        blueprintId: 'bp-2',
        workspaceId: 'ws-1',
        activeWatchdog: null,
        pendingAskUserRequestId: null,
        lastTerminalReason: 'model_error'
      })
      await assert.rejects(() => (svc as any).handleClarifyTurnEnd('bp-2', 'ws-1', ''))
    } finally {
      restore()
    }
  })

  test('empty text + completed terminal reason → nudge path unchanged (no throw)', async () => {
    const { svc, machine, restore } = makeService()
    try {
      const session = new FakeSession()
      ;(svc as any).clarifySessions.set('bp-3', {
        session,
        conversationId: 'conv-3',
        blueprintId: 'bp-3',
        workspaceId: 'ws-1',
        activeWatchdog: null,
        pendingAskUserRequestId: null,
        lastTerminalReason: 'completed'
      })

      // Genuinely empty completion: the corrective nudge is the right response.
      // (The nudge's retry turn also comes back empty → falls through to
      // awaitingInput — the pre-existing behavior for empty completions.)
      await (svc as any).handleClarifyTurnEnd('bp-3', 'ws-1', '')
      assert.ok(
        session.sent.length >= 1,
        'corrective nudge sent for empty-but-completed turn'
      )
      assert.ok(
        !machine.transitions.includes('fail'),
        'completed terminal reason never fails the phase'
      )
    } finally {
      restore()
    }
  })

  test('no session state (unknown blueprint) + empty text → nudge skipped, awaitingInput fallback', async () => {
    const { svc, machine, restore } = makeService()
    try {
      await (svc as any).handleClarifyTurnEnd('bp-unknown', 'ws-1', '')
      assert.equal(
        machine.transitions.includes('awaitingInput'),
        true,
        'falls back to awaitingInput when no terminal reason is known'
      )
    } finally {
      restore()
    }
  })
})

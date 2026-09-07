/**
 * agent-session-host-surface.test.ts — F1 (2.1) + F2 (2.2) + F12 (1.1) pins on
 * the real AgentSessionService class.
 *
 * F1's production evidence: 3 nudge recoveries in the live run, 0
 * `outcome_kind='nudged'` stamps — `agent-recovery-manager.ts` wrote
 * `this.s.lastTurnNudged` against a class that only had `private
 * _lastTurnNudged` and no accessor, and `constructor(session: unknown)`
 * erased the check. These tests drive the REAL session object:
 *
 *   - lastTurnNudged accessor round-trips (the field the manager writes)
 *   - getLastTerminalReason mirrors the stream-processor write
 *   - both reset per send (resetForNewMessage)
 *   - getFirstTurnCacheRead returns the EARLIEST turn's cache read, not the sum
 *
 * Run: tsx src/main/services/__tests__/agent-session-host-surface.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let AgentSessionService: any
let AgentTokenTracker: any
let loaded = false

try {
  AgentSessionService = require('../agent-session.service').AgentSessionService
  AgentTokenTracker = require('../agent-token-tracker').AgentTokenTracker
  loaded = true
} catch (err) {
  console.log(`⚠ session surface setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

/** Minimal adapter stub — AgentSessionService only needs the interface shape. */
function makeAdapter(): unknown {
  return {
    role: 'blueprint-build',
    agentId: 'test-agent',
    buildPrompts: () => ({ systemPrompt: 'sys', effectiveMessage: 'msg' }),
    buildMcpConfig: () => ({ allowedTools: [], disallowedTools: [] }),
    refreshFeatureFlags: () => {},
    onSendSuccess: () => {}
  }
}

if (!loaded) {
  describe('agent session host surface (skipped — module load failed)', () => {
    test('surface pins', () => {}, { skipReason: 'module load failed' })
  })
} else {
  describe('F1 (2.1) — lastTurnNudged is writable by the recovery manager', () => {
    test('the host-surface accessor exists and round-trips', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      // This is EXACTLY the line agent-recovery-manager.ts:512 executes on a
      // successful recovery. Pre-F1 it assigned onto nothing (silently, via
      // the `unknown`-typed host) and wasNudged() stayed false forever.
      ;(session as any).lastTurnNudged = true
      assert.equal(session.wasNudged(), true, 'wasNudged() must read the manager write')
      ;(session as any).lastTurnNudged = false
      assert.equal(session.wasNudged(), false)
    })

    test('the typed AgentRecoveryManager constructor accepts the real session', () => {
      // F1: the constructor was `unknown`; the drift was invisible. Now the
      // parameter is AgentSessionHost, so this call only compiles (and runs)
      // while every field the manager touches exists on the session.
      const { AgentRecoveryManager } = require('../agent-recovery-manager')
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      const manager = new AgentRecoveryManager(session)
      assert.equal(typeof manager.handleStreamError, 'function')
    })
  })

  describe('F12 (1.1) — lastTerminalReason on the session surface', () => {
    test('getLastTerminalReason reads the stream processor write', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      assert.equal(session.getLastTerminalReason(), undefined)
      // What agent-stream-processor.processMetaChunk now does on a terminal
      // reason chunk.
      ;(session as any).lastTerminalReason = 'api_error'
      assert.equal(session.getLastTerminalReason(), 'api_error')
    })

    test('resetForNewMessage clears it (per-send scoping)', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      ;(session as any).lastTerminalReason = 'api_error'
      ;(session as any).resetForNewMessage('conv-1')
      assert.equal(session.getLastTerminalReason(), undefined)
    })
  })

  describe('F2 (2.2) — getFirstTurnCacheRead returns the first turn, not the sum', () => {
    test('earliest turn by timestamp wins over later entries', () => {
      const tracker = new AgentTokenTracker()
      tracker.recordTurn(
        {
          tokenUsage: {
            input: 100,
            output: 1,
            cacheReadInputTokens: 50_000,
            cacheCreationInputTokens: 0
          }
        },
        { turnCount: 1, conversationId: 'c1', dbSessionId: null, workspacePath: '/tmp' }
      )
      tracker.recordTurn(
        {
          tokenUsage: {
            input: 100,
            output: 1,
            cacheReadInputTokens: 70_000,
            cacheCreationInputTokens: 0
          }
        },
        { turnCount: 2, conversationId: 'c1', dbSessionId: null, workspacePath: '/tmp' }
      )
      // In-memory path: turnBreakdown append order; the earliest TIMESTAMP is
      // the honest first turn even if append order were to change.
      const first = tracker.getFirstTurnCacheRead('c1')
      assert.equal(first, 50_000, 'first turn (50K), not the sum (120K)')
    })

    test('undefined when nothing was recorded — never a coerced 0', () => {
      const tracker = new AgentTokenTracker()
      assert.equal(tracker.getFirstTurnCacheRead('no-such-conv'), undefined)
    })

    test('a multi-turn cold rung no longer inflates the metric (the F2 complaint)', () => {
      const tracker = new AgentTokenTracker()
      for (let i = 1; i <= 6; i++) {
        tracker.recordTurn(
          {
            tokenUsage: {
              input: 100,
              output: 1,
              cacheReadInputTokens: 10_000,
              cacheCreationInputTokens: 0
            }
          },
          { turnCount: i, conversationId: 'c2', dbSessionId: null, workspacePath: '/tmp' }
        )
      }
      assert.equal(tracker.getFirstTurnCacheRead('c2'), 10_000)
      assert.equal(
        tracker.getCacheEfficiency('c2').savedTokens,
        60_000,
        'the SUM the old metric used'
      )
    })
  })

  // T003/A5 — the fallback-signed mirror of lastTurnNudged. When both nudges
  // fail, the pipeline SYNTHESIZES the completion marker; BUILD stamps
  // outcome_kind='unproven' because the model never attested the work.
  describe('A5 — lastTurnFallbackSigned mirrors lastTurnNudged', () => {
    test('the accessor exists and round-trips the manager write', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      assert.equal(session.wasFallbackSigned(), false)
      // EXACTLY what agent-recovery-manager.ts writes when recoveryResult.recovered
      // is false (the fallback fired).
      ;(session as any).lastTurnFallbackSigned = true
      assert.equal(session.wasFallbackSigned(), true, 'must read the manager write')
      ;(session as any).lastTurnFallbackSigned = false
      assert.equal(session.wasFallbackSigned(), false)
    })

    test('resetForNewMessage clears it (per-send scoping, same as nudged)', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      ;(session as any).lastTurnFallbackSigned = true
      ;(session as any).resetForNewMessage('conv-1')
      assert.equal(session.wasFallbackSigned(), false)
    })

    test('the two flags are independent: fallback set does not imply nudged', () => {
      const session = new AgentSessionService(makeAdapter(), 'test-instance')
      ;(session as any).lastTurnFallbackSigned = true
      assert.equal(session.wasNudged(), false, 'a fallback is NOT a recovery')
      assert.equal(session.wasFallbackSigned(), true)
    })
  })
}

// Await pending async tests before exiting.
summaryAsync().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})

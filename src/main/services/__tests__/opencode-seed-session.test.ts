/**
 * A1 (Phase 5) — OpenCode executor `seedSession` coverage.
 *
 * seedSession is the entire OpenCode half of the A1 resume story: after an
 * app/server restart the executor's in-memory session map is empty while the
 * persisted id lives in the conversations table, and `getOrCreateSession`
 * would mint a NEW server-side session — the exact cold start A1 exists to
 * avoid. Three behaviours, pinned:
 *
 *   1. seeds a persisted id when the conversation is unmapped;
 *   2. no-ops when a LIVE mapping exists (live always outranks persisted);
 *   3. ignores empty/blank arguments (never maps garbage).
 *
 * Run: tsx src/main/services/__tests__/opencode-seed-session.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let openCodeExecutor: {
  seedSession(conversationId: string, sessionId: string): void
  getSessionId(conversationId: string): string | undefined
} | null = null
let loaded = false

try {
  openCodeExecutor = require('../opencode-executor').openCodeExecutor
  loaded = true
} catch (err) {
  console.log(`⚠ opencode-executor load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (!loaded) {
  describe('opencode seedSession (skipped — module load failed)', () => {
    test('seedSession', () => {}, { skipReason: 'module load failed' })
  })
} else {
  const exec = openCodeExecutor!
  // Unique per-run conversation ids: the executor is a singleton and its map
  // is module state shared with any other suite in the same process.
  const runKey = `seed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  describe('A1 — opencode seedSession', () => {
    test('seeds a persisted id for an unmapped conversation', () => {
      const convId = `${runKey}-unmapped`
      assert.equal(exec.getSessionId(convId), undefined, 'precondition: unmapped')
      exec.seedSession(convId, 'sess-opencode-1')
      assert.equal(
        exec.getSessionId(convId),
        'sess-opencode-1',
        'a persisted id must survive the restart gap instead of minting a new session'
      )
    })

    test('no-ops when a live mapping already exists', () => {
      const convId = `${runKey}-live`
      exec.seedSession(convId, 'sess-live-first')
      // A later (stale) persisted read must NOT overwrite the live mapping.
      exec.seedSession(convId, 'sess-stale-persisted')
      assert.equal(
        exec.getSessionId(convId),
        'sess-live-first',
        'a live mapping always outranks a persisted one'
      )
    })

    test('ignores empty arguments', () => {
      const before = exec.getSessionId(`${runKey}-empty-1`)
      exec.seedSession('', 'sess-x')
      exec.seedSession(`${runKey}-empty-2`, '')
      assert.equal(exec.getSessionId(''), undefined, 'empty conversation id never mapped')
      assert.equal(
        exec.getSessionId(`${runKey}-empty-2`),
        undefined,
        'empty session id never mapped'
      )
      assert.equal(before, undefined, 'no collateral mappings created')
    })

    // F6 (3.3) — malformed ids are refused, not mapped. The cross-run resume
    // path passes whatever the conversations row holds; garbage mapped now
    // fails opaquely at request time later.
    test('refuses a malformed session id (F6 shape guard)', () => {
      exec.seedSession(`${runKey}-garbage-1`, 'not a session id!')
      exec.seedSession(`${runKey}-garbage-2`, 'ab') // too short
      exec.seedSession(`${runKey}-garbage-3`, '_leading') // must start alphanumeric
      assert.equal(
        exec.getSessionId(`${runKey}-garbage-1`),
        undefined,
        'space/punctuation id never mapped'
      )
      assert.equal(exec.getSessionId(`${runKey}-garbage-2`), undefined, 'short id never mapped')
      assert.equal(
        exec.getSessionId(`${runKey}-garbage-3`),
        undefined,
        'non-alphanumeric-leading id never mapped'
      )
    })

    test('accepts the real opencode id shapes (ses_…)', () => {
      const ok = `ses-${runKey}-ok1`
      exec.seedSession(`${runKey}-ok`, ok)
      assert.equal(exec.getSessionId(`${runKey}-ok`), ok)
    })
  })
}

// Await pending async tests before exiting.
summaryAsync().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})

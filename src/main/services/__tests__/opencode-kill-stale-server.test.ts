/**
 * selectStaleServerPids — pure-helper tests for the SELF-KILL FIX.
 *
 * Regression guard for the v1.0.89 crash loop: `killStaleServer()` ran
 * `lsof -ti :4096` WITHOUT a LISTEN filter, which matched the Electron app's
 * own client sockets (remote port 4096) in addition to the server listener.
 * The loop then SIGTERMed the app itself at the tasks→review transition.
 *
 * These tests pin the two defenses:
 *   1. The caller now passes `-sTCP:LISTEN` output (listeners only).
 *   2. Even if that filter regresses, the helper NEVER selects the own PID.
 */

import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { selectStaleServerPids } from '../opencode-executor'

const OWN_PID = 4242

describe('selectStaleServerPids (SELF-KILL FIX)', () => {
  // ── Happy path: real listeners ──

  test('selects a single listener PID', () => {
    assert.deepEqual(selectStaleServerPids('24346\n', OWN_PID), [24346])
  })

  test('selects multiple listener PIDs', () => {
    assert.deepEqual(selectStaleServerPids('111\n222\n333\n', OWN_PID), [111, 222, 333])
  })

  test('deduplicates repeated PIDs', () => {
    assert.deepEqual(selectStaleServerPids('111\n111\n222\n', OWN_PID), [111, 222])
  })

  // ── The self-kill guard ──

  test('NEVER selects the own PID even when lsof matches it (LISTEN filter regression)', () => {
    // This is exactly the v1.0.89 scenario: the app's own PID appears in lsof
    // output because its client sockets match on the remote port.
    assert.deepEqual(selectStaleServerPids(`${OWN_PID}\n`, OWN_PID), [])
  })

  test('excludes own PID but keeps the real server PID', () => {
    assert.deepEqual(selectStaleServerPids(`${OWN_PID}\n24346\n`, OWN_PID), [24346])
  })

  test('own PID embedded in a longer number is not stripped (exact match only)', () => {
    // 42421 contains "4242" as a substring — must still be selected.
    assert.deepEqual(selectStaleServerPids('42421\n', OWN_PID), [42421])
  })

  // ── Empty / malformed output ──

  test('empty string → no kills', () => {
    assert.deepEqual(selectStaleServerPids('', OWN_PID), [])
  })

  test('whitespace-only output → no kills', () => {
    assert.deepEqual(selectStaleServerPids('   \n  \n', OWN_PID), [])
  })

  test('non-numeric lines are ignored (lsof warnings on stdout)', () => {
    assert.deepEqual(selectStaleServerPids('lsof: warning: something\n24346\n', OWN_PID), [24346])
  })

  test('float / negative / zero values are ignored', () => {
    assert.deepEqual(selectStaleServerPids('1.5\n-3\n0\n24346\n', OWN_PID), [24346])
  })

  test('trailing whitespace around PIDs is tolerated', () => {
    assert.deepEqual(selectStaleServerPids('  24346  \n', OWN_PID), [24346])
  })
})

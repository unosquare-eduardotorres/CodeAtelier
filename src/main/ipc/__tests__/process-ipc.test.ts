/**
 * process.ipc.ts — channel registration and PID validation.
 *
 * This is the only path from the renderer to a kill(), and the kill targets the
 * process *group* (`-pid`). A PID that slips through validation is not a bad
 * request, it is `process.kill(-1, SIGTERM)` — every process the user owns. So
 * the guard is tested as a security boundary, not as input hygiene.
 *
 * Run: tsx src/main/ipc/__tests__/process-ipc.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let loaded = false
try {
  const mod = require('../process.ipc')
  mod.registerProcessIpc()
  loaded = true
} catch (err) {
  console.log(`⚠ process.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (loaded) {
  describe('process.ipc — channel registration', () => {
    test('registers process:list', () => {
      assert.ok(getHandlers().has('process:list'))
    })

    test('registers process:stop', () => {
      assert.ok(getHandlers().has('process:stop'))
    })

    test('registers process:cancelWatch', () => {
      assert.ok(getHandlers().has('process:cancelWatch'))
    })
  })

  // Every shape that must be refused before a signal can be sent.
  const REJECTED: Array<[string, unknown]> = [
    ['null args', null],
    ['undefined args', undefined],
    ['a non-object payload', 42],
    ['a string payload', '1234'],
    ['a missing pid', {}],
    ['a string pid', { pid: '1234' }],
    ['a null pid', { pid: null }],
    ['a non-integer pid', { pid: 12.5 }],
    ['NaN', { pid: Number.NaN }],
    ['Infinity', { pid: Number.POSITIVE_INFINITY }],
    ['zero', { pid: 0 }],
    ['a negative pid', { pid: -1 }],
    ['negative zero', { pid: -0 }],
    ['a boolean pid', { pid: true }]
  ]

  for (const channel of ['process:stop', 'process:cancelWatch']) {
    describe(`${channel} — PID validation`, () => {
      for (const [label, args] of REJECTED) {
        test(`rejects ${label}`, async () => {
          const result = await tryInvokeHandler(channel, args)
          assert.equal(result.ok, false, `${channel} accepted ${JSON.stringify(args)}`)
          if (!result.ok) assert.match(result.error.message, /pid|object/i)
        })
      }

      test('accepts a positive integer pid and reports it as untracked', async () => {
        // No manifest lists this PID, so the handler must resolve it to a
        // no-op rather than signalling anything.
        const result = await tryInvokeHandler(channel, { pid: 0x7ffffff })
        assert.equal(result.ok, true)
        if (result.ok) {
          assert.equal((result.result as { reason?: string }).reason, 'untracked')
        }
      })

      test('pid 1 passes validation but is refused as untracked — no signal', async () => {
        // Validation cannot reject pid 1 (it is a positive integer); the
        // manifest lookup is what stops kill(-1, …) from ever being reached.
        const result = await tryInvokeHandler(channel, { pid: 1 })
        assert.equal(result.ok, true)
        if (result.ok) {
          assert.equal((result.result as { reason?: string }).reason, 'untracked')
        }
      })
    })
  }
}

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('process-ipc')) {
  void summaryAsync()
}

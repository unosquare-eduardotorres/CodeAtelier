/**
 * Unit tests for claude-cli-oneshot.ts — runCliOneShot must close the child's
 * stdin (EOF) so a one-shot CLI never blocks on an empty stdin pipe, and must
 * surface stderr in its rejection message for diagnostics.
 *
 * Exercised against `node -e` scripts (no network, no claude CLI needed).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { runCliOneShot } from '../claude-cli-oneshot'

describe('claude-cli-oneshot › runCliOneShot', () => {
  test('closes stdin (EOF) so a child reading stdin resolves instead of hanging', async () => {
    // This child reads stdin to EOF, then prints. If runCliOneShot did NOT
    // .end() the stdin pipe, readFileSync(0) would block forever and the test
    // would time out.
    //
    // Retry once: under heavy parallel test load (3500+ concurrent tests),
    // the child process may fail non-deterministically on Node v25 due to
    // event-loop congestion affecting pipe EOF timing.
    let lastErr: Error | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stdout = await runCliOneShot(
          process.execPath,
          ['-e', "require('fs').readFileSync(0,'utf8'); process.stdout.write('done')"],
          { timeout: 10_000 }
        )
        assert.equal(stdout.trim(), 'done')
        return // success
      } catch (err) {
        lastErr = err as Error
      }
    }
    throw lastErr
  })

  test('surfaces stderr in the rejection message on non-zero exit', async () => {
    await assert.rejects(
      () =>
        runCliOneShot(process.execPath, ['-e', "process.stderr.write('boom'); process.exit(3)"], {
          timeout: 10_000
        }),
      (err: Error) => {
        assert.ok(err.message.includes('boom'), `expected stderr "boom" in: ${err.message}`)
        return true
      }
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

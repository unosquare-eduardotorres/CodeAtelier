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
    const stdout = await runCliOneShot(
      process.execPath,
      ['-e', "require('fs').readFileSync(0,'utf8'); process.stdout.write('done')"],
      { timeout: 10_000 }
    )
    assert.equal(stdout.trim(), 'done')
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

/**
 * Regression guard: a dying CLI process must not clobber its successor.
 *
 * Reported symptom — after pressing Stop, the very next message always failed
 * with "CLI produced no output (empty-exit, exit null)" and worked on retry.
 *
 * Cause: killProcess() drops `cliProcess` synchronously, but the child takes
 * seconds to actually die (MCP servers tearing down; SIGKILL escalation is 5s
 * out). Its late `exit` event then ran against whatever process was current by
 * then — nulling the NEW process, destroying the NEW process's stdout,
 * overwriting `lastExitCode` with the killed process's `null`, and disarming
 * the live read. The next turn therefore read zero NDJSON messages and was
 * classified as an empty-exit turn.
 *
 * These tests drive the handlers directly with fake children, so they assert
 * the ownership rule rather than a timing coincidence.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let CLIExecutor: any
let loaded = false
try {
  ;({ CLIExecutor } = require('../cli-executor'))
  loaded = true
} catch (err) {
  console.log('⚠ cli-executor.ts load failed — process-identity tests skipped.')
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

/** Minimal ChildProcess stand-in: records whether its stdout was destroyed. */
function fakeChild(): any {
  const child: any = new EventEmitter()
  child.killed = false
  child.exitCode = null
  child.stdoutDestroyed = false
  child.signals = [] as string[]
  child.stdout = {
    destroy: () => {
      child.stdoutDestroyed = true
    }
  }
  child.stdin = { write: () => true }
  child.kill = (sig: string) => {
    child.signals.push(sig)
    child.killed = true
    return true
  }
  return child
}

const owned = (): { file: string | null } => ({ file: null })

if (loaded) {
  describe('CLIExecutor — late exit from a superseded process', () => {
    test('does not evict the live process', () => {
      const exec = new CLIExecutor()
      const dying = fakeChild()
      const live = fakeChild()
      ;(exec as any).cliProcess = live

      // The killed process finally exits, AFTER the next turn spawned `live`.
      ;(exec as any).handleChildExit(dying, owned(), null, 'SIGTERM')

      assert.equal(
        (exec as any).cliProcess,
        live,
        'the live process was evicted by an older process exiting'
      )
    })

    test('does not destroy the live process stdout', () => {
      const exec = new CLIExecutor()
      const dying = fakeChild()
      const live = fakeChild()
      ;(exec as any).cliProcess = live
      ;(exec as any).handleChildExit(dying, owned(), null, 'SIGTERM')

      assert.equal(live.stdoutDestroyed, false, 'the live NDJSON stream was destroyed')
      assert.equal(dying.stdoutDestroyed, true, 'the exiting process must still release its stdout')
    })

    test('does not overwrite lastExitCode — the source of "exit null"', () => {
      const exec = new CLIExecutor()
      const live = fakeChild()
      ;(exec as any).cliProcess = live
      ;(exec as any).lastExitCode = undefined

      // Signal-killed processes report code null; that null is exactly what
      // surfaced as "CLI produced no output (empty-exit, exit null)".
      ;(exec as any).handleChildExit(fakeChild(), owned(), null, 'SIGTERM')

      assert.notEqual((exec as any).lastExitCode, null, 'a stale exit code leaked into a new turn')
    })

    test('does not disarm the live read', () => {
      const exec = new CLIExecutor()
      ;(exec as any).cliProcess = fakeChild()
      ;(exec as any).armExitSignal()
      const armed = (exec as any).exitSignal

      ;(exec as any).handleChildExit(fakeChild(), owned(), null, 'SIGTERM')

      assert.equal((exec as any).exitSignal, armed, "an older process broke the live turn's read")
    })

    test('a superseded error event is equally inert', () => {
      const exec = new CLIExecutor()
      const live = fakeChild()
      ;(exec as any).cliProcess = live
      ;(exec as any).handleChildError(fakeChild(), owned(), new Error('spawn ENOENT'))
      assert.equal((exec as any).cliProcess, live)
    })

    test('still deletes only its OWN prompt file', () => {
      const exec = new CLIExecutor()
      const deleted: (string | null)[] = []
      ;(exec as any).deleteSystemPromptFile = (p: string | null) => deleted.push(p)
      ;(exec as any).cliProcess = fakeChild()

      const mine = { file: '/tmp/prompt-dying.txt' }
      ;(exec as any).handleChildExit(fakeChild(), mine, null, 'SIGTERM')

      assert.deepEqual(deleted, ['/tmp/prompt-dying.txt'])
      assert.equal(mine.file, null, 'ownership is released after deletion')
    })
  })

  describe('CLIExecutor — current process exit still applies', () => {
    test('the live process exiting clears state as before', () => {
      const exec = new CLIExecutor()
      const live = fakeChild()
      ;(exec as any).cliProcess = live
      ;(exec as any).spawnSignature = { model: 'claude-sonnet-4-6' }

      ;(exec as any).handleChildExit(live, owned(), 0, null)

      assert.equal((exec as any).cliProcess, null)
      assert.equal((exec as any).spawnSignature, null)
      assert.equal((exec as any).lastExitCode, 0)
      assert.equal(live.stdoutDestroyed, true)
    })
  })

  describe('CLIExecutor — killProcess is joinable', () => {
    test('a second caller waits for the in-flight termination', async () => {
      const exec = new CLIExecutor()
      const proc = fakeChild()
      ;(exec as any).cliProcess = proc

      let firstDone = false
      const first = exec.killProcess().then(() => {
        firstDone = true
      })

      // `cliProcess` is already null here — this is the exact state
      // spawnCLIProcess's `await this.killProcess()` guard used to sail past.
      let secondDone = false
      const second = exec.killProcess().then(() => {
        secondDone = true
      })

      await new Promise((r) => setTimeout(r, 20))
      assert.equal(firstDone, false, 'termination should still be pending')
      assert.equal(secondDone, false, 'the second caller must not return before the process dies')

      proc.emit('exit', null, 'SIGTERM')
      await Promise.all([first, second])
      assert.ok(firstDone && secondDone)
    })

    test('killProcess on an idle executor returns immediately', async () => {
      const exec = new CLIExecutor()
      await exec.killProcess()
      assert.equal((exec as any).killPromise, null)
    })
  })

  describe('CLIExecutor — killChild targets one process', () => {
    test("a stale turn's abort never kills the current process", async () => {
      const exec = new CLIExecutor()
      const stale = fakeChild()
      const live = fakeChild()
      ;(exec as any).cliProcess = live

      // Turn N's abort listener fires after turn N+1 already spawned `live`.
      await (exec as any).killChild(stale)

      assert.equal((exec as any).cliProcess, live, 'a stale abort killed the new turn')
      assert.deepEqual(stale.signals, ['SIGTERM'], 'the stale child is still cleaned up')
      assert.deepEqual(live.signals, [])
    })

    test('aborting the current process does kill it', async () => {
      const exec = new CLIExecutor()
      const live = fakeChild()
      ;(exec as any).cliProcess = live
      const killed = (exec as any).killChild(live)
      live.emit('exit', null, 'SIGTERM')
      await killed
      assert.deepEqual(live.signals, ['SIGTERM'])
      assert.equal((exec as any).cliProcess, null)
    })
  })
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('cli-executor-process-identity.test.ts')

if (isDirectRun) {
  void summaryAsync()
}

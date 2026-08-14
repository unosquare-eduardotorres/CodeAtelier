/**
 * Regression guards for what a spawn is allowed to name in its argv.
 *
 * Two field failures, both first seen on Windows right after pressing Stop:
 *
 *  1. `claude … --resume <session>` was spawned for a session whose previous
 *     turn had been killed mid-flight. The resumed process died in under a
 *     second with zero NDJSON — "CLI produced no output (empty-exit, exit
 *     null)". AgentSessionService is supposed to drop such a session, but
 *     `[turn:end]` never appeared in the logs, so that bookkeeping cannot be
 *     the only defence. These tests pin the guard at the point of use.
 *
 *  2. `System prompt file not found: …\system-prompt-….md` followed by exit 1 —
 *     argv named a temp file that was gone by the time the CLI opened it.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let CLIExecutor: any
let loaded = false
try {
  ;({ CLIExecutor } = require('../cli-executor'))
  loaded = true
} catch (err) {
  console.log('⚠ cli-executor.ts load failed — spawn-guard tests skipped.')
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

/** Minimal valid options — no systemPrompt, so buildCLIArgs writes no temp file. */
const baseOptions = (extra: Record<string, unknown> = {}): any => ({
  prompt: 'hello',
  systemPrompt: '',
  model: 'claude-sonnet-4-6',
  cwd: '/tmp',
  permissionMode: 'default',
  ...extra
})

const SESSION = '9133fe16-aaaa-bbbb-cccc-000000000001'

if (loaded) {
  describe('CLIExecutor — poisoned sessions are never resumed', () => {
    test('a clean session still resumes', () => {
      const exec = new CLIExecutor()
      const args: string[] = (exec as any).buildCLIArgs(baseOptions({ resume: SESSION }))
      assert.ok(args.includes('--resume'), 'a healthy session must still resume')
      assert.equal(args[args.indexOf('--resume') + 1], SESSION)
    })

    test('a poisoned session is dropped from argv', () => {
      const exec = new CLIExecutor()
      exec.markSessionPoisoned(SESSION, 'test')
      const args: string[] = (exec as any).buildCLIArgs(baseOptions({ resume: SESSION }))
      assert.ok(
        !args.includes('--resume'),
        'argv still named a session that was left with an unanswered user turn'
      )
      assert.ok(!args.includes(SESSION))
    })

    test('--resume-session-at does not survive a refused resume', () => {
      const exec = new CLIExecutor()
      exec.markSessionPoisoned(SESSION, 'test')
      const args: string[] = (exec as any).buildCLIArgs(
        baseOptions({ resume: SESSION, resumeSessionAt: 'msg-42' })
      )
      assert.ok(
        !args.includes('--resume-session-at'),
        'a fresh session was pointed at a message inside the abandoned one'
      )
    })

    test('only the poisoned session is refused', () => {
      const exec = new CLIExecutor()
      exec.markSessionPoisoned(SESSION, 'test')
      const other = '77770000-dddd-eeee-ffff-000000000002'
      const args: string[] = (exec as any).buildCLIArgs(baseOptions({ resume: other }))
      assert.equal(args[args.indexOf('--resume') + 1], other)
    })

    test('marking is idempotent and bounded', () => {
      const exec = new CLIExecutor()
      for (let i = 0; i < 100; i++) exec.markSessionPoisoned(`session-${i}`, 'test')
      exec.markSessionPoisoned('session-99', 'test')
      const ids: Set<string> = (exec as any).poisonedSessionIds
      assert.ok(ids.size <= 32, `poisoned set grew unbounded (${ids.size})`)
      assert.ok(ids.has('session-99'), 'the most recent id must be retained')
    })
  })

  describe('CLIExecutor — killing a live turn poisons its session', () => {
    /** Child stub that never exits on its own; the test drives 'exit'. */
    const fakeChild = (): any => {
      const child: any = new (require('node:events').EventEmitter)()
      child.stdout = { destroy: () => {} }
      child.kill = () => {
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
        return true
      }
      return child
    }

    test('Stop mid-turn means the next send does not resume', async () => {
      const exec = new CLIExecutor()
      ;(exec as any).cliProcess = fakeChild()
      ;(exec as any).sessionId = SESSION
      // The CLI has not reported back that it is ready for input — a turn is live.
      ;(exec as any).cliReadyForInput = false

      await exec.killProcess()

      const args: string[] = (exec as any).buildCLIArgs(baseOptions({ resume: SESSION }))
      assert.ok(!args.includes('--resume'), 'the stopped turn’s session was resumed anyway')
    })

    test('killing an idle process leaves the session resumable', async () => {
      const exec = new CLIExecutor()
      ;(exec as any).cliProcess = fakeChild()
      ;(exec as any).sessionId = SESSION
      // A `result` event arrived: the turn was answered, nothing is unanswered.
      ;(exec as any).cliReadyForInput = true

      await exec.killProcess()

      const args: string[] = (exec as any).buildCLIArgs(baseOptions({ resume: SESSION }))
      assert.ok(args.includes('--resume'), 'a completed turn must not cost the session')
    })
  })

  describe('CLIExecutor — the prompt file argv names must exist', () => {
    test('a vanished prompt file is rebuilt rather than handed to the CLI', () => {
      const exec = new CLIExecutor()
      const dir = mkdtempSync(join(tmpdir(), 'prompt-guard-'))
      const file = join(dir, 'system-prompt-test.md')
      try {
        // State as left by buildCLIArgs, then the file goes away underneath us.
        ;(exec as any).pendingSystemPromptFile = file
        ;(exec as any).pendingSystemPromptContent = 'you are a helpful agent'
        assert.equal(existsSync(file), false)

        ;(exec as any).verifySystemPromptFile()

        assert.equal(existsSync(file), true, 'spawn would have named a file that does not exist')
        assert.equal(readFileSync(file, 'utf-8'), 'you are a helpful agent')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('an unrebuildable prompt file fails loudly instead of silently', () => {
      const exec = new CLIExecutor()
      ;(exec as any).pendingSystemPromptFile = join(tmpdir(), 'gone-forever.md')
      ;(exec as any).pendingSystemPromptContent = null
      assert.throws(
        () => (exec as any).verifySystemPromptFile(),
        /disappeared before spawn/,
        'a doomed spawn was allowed to proceed'
      )
    })

    test('an intact prompt file is left exactly as written', () => {
      const exec = new CLIExecutor()
      const dir = mkdtempSync(join(tmpdir(), 'prompt-guard-'))
      const file = join(dir, 'system-prompt-test.md')
      try {
        writeFileSync(file, 'original', 'utf-8')
        ;(exec as any).pendingSystemPromptFile = file
        ;(exec as any).pendingSystemPromptContent = 'rewritten'

        ;(exec as any).verifySystemPromptFile()

        assert.equal(readFileSync(file, 'utf-8'), 'original', 'a healthy prompt file was clobbered')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('cli-executor-spawn-guards.test.ts')

if (isDirectRun) {
  void summaryAsync()
}

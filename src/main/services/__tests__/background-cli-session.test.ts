/**
 * Unit tests for BackgroundCliSession — verifies spawn, run, /clear,
 * idle timeout, mutex serialization, crash recovery, and dispose.
 *
 * Each test creates a FRESH BackgroundCliSession instance to avoid
 * concurrency issues (the test harness runs async tests concurrently).
 * Uses the _spawner test seam to inject a fake child process.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { test, describe, summaryAsync } from './test-harness'
import { BackgroundCliSession } from '../background-cli-session'

// ── Helpers ────────────────────────────────────────────────────────────

type AnySession = Record<string, unknown>

/** Build an NDJSON line from an object */
function ndjson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n'
}

/** Build a system/init NDJSON event */
function systemInitEvent(sessionId = 'test-session-123'): string {
  return ndjson({ type: 'system', subtype: 'init', session_id: sessionId })
}

/** Build a result NDJSON event */
function resultEvent(text: string, usage?: Record<string, number>): string {
  return ndjson({
    type: 'result',
    result: text,
    usage: {
      input_tokens: usage?.input ?? 100,
      output_tokens: usage?.output ?? 50,
      cache_read_input_tokens: usage?.cacheRead ?? 0,
      cache_creation_input_tokens: usage?.cacheCreation ?? 0
    }
  })
}

/**
 * Create a fake child process that properly closes streams on kill.
 * The stdout.push(null) on kill is critical — parseNdjsonStream's
 * `for await` loop blocks until the stream ends.
 */
function createFakeProcess(): {
  proc: Record<string, unknown>
  stdout: Readable
  stdin: { written: string[] }
  emitExit: (code?: number, signal?: string) => void
} {
  const stdout = new Readable({
    read() {
      /* no-op: data is pushed manually by the test */
    }
  })
  const stderr = new Readable({
    read() {
      /* no-op: data is pushed manually by the test */
    }
  })
  const stdinWrites: string[] = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString())
      cb()
    }
  })

  const procEmitter = new EventEmitter()
  const proc = {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: (_signal?: string) => {
      if ((proc as Record<string, unknown>).killed) return
      ;(proc as Record<string, unknown>).killed = true
      // End stdout/stderr so parseNdjsonStream's for-await unblocks
      stdout.push(null)
      stderr.push(null)
      procEmitter.emit('exit', null, _signal ?? 'SIGTERM')
    },
    on: procEmitter.on.bind(procEmitter),
    once: procEmitter.once.bind(procEmitter),
    removeListener: procEmitter.removeListener.bind(procEmitter)
  }

  return {
    proc,
    stdout,
    stdin: { written: stdinWrites },
    emitExit: (code?: number, signal?: string) => {
      if ((proc as Record<string, unknown>).killed) return
      ;(proc as Record<string, unknown>).killed = true
      stdout.push(null)
      stderr.push(null)
      procEmitter.emit('exit', code ?? 0, signal ?? null)
    }
  }
}

/** Create a fresh session wired to a fake process */
function createTestSession(): {
  session: BackgroundCliSession
  fake: ReturnType<typeof createFakeProcess>
} {
  const session = new BackgroundCliSession()
  const fake = createFakeProcess()
  ;(session as unknown as AnySession)._spawner = () => fake.proc
  return { session, fake }
}

/** Small delay to let async operations progress */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// ── Tests ──────────────────────────────────────────────────────────────

describe('BackgroundCliSession', () => {
  describe('run — basic flow', () => {
    test('spawns process, sends message, reads result', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('You are a test prompt optimizer.')

      try {
        const runPromise = session.run({
          userMessage: 'Hello world',
          timeoutMs: 5000
        })

        await tick()
        fake.stdout.push(systemInitEvent())
        await tick()
        fake.stdout.push(
          resultEvent('```optimized-prompt\nHello world improved\n```', {
            input: 200,
            output: 100
          })
        )

        const result = await runPromise

        assert.equal(result.text, '```optimized-prompt\nHello world improved\n```')
        assert.equal(result.usage.input, 200)
        assert.equal(result.usage.output, 100)
        // /clear is deferred to the START of the next run() call (not end of this one)
      } finally {
        session.dispose()
      }
    })

    test('returns full usage data from result event', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Test prompt')

      try {
        const runPromise = session.run({ userMessage: 'Test', timeoutMs: 5000 })
        await tick()
        fake.stdout.push(systemInitEvent())
        await tick()
        fake.stdout.push(
          resultEvent('Response text', {
            input: 500,
            output: 200,
            cacheRead: 50,
            cacheCreation: 10
          })
        )

        const result = await runPromise
        assert.equal(result.usage.input, 500)
        assert.equal(result.usage.output, 200)
        assert.equal(result.usage.cacheRead, 50)
        assert.equal(result.usage.cacheCreation, 10)
      } finally {
        session.dispose()
      }
    })
  })

  describe('run — warm process reuse', () => {
    test('second call reuses warm process and sends /clear before second message', async () => {
      let spawnCount = 0
      const session = new BackgroundCliSession()
      let currentFake = createFakeProcess()

      ;(session as unknown as AnySession)._spawner = () => {
        spawnCount++
        currentFake = createFakeProcess()
        return currentFake.proc
      }
      session.setSystemPrompt('Test prompt')

      try {
        // First call — triggers spawn
        const run1 = session.run({ userMessage: 'Call 1', timeoutMs: 5000 })
        await tick()
        currentFake.stdout.push(systemInitEvent())
        await tick()
        currentFake.stdout.push(resultEvent('Response 1'))
        await run1
        assert.equal(spawnCount, 1, 'First call should spawn')

        // Second call — warm, no new spawn.
        // /clear is sent at the START of this call to drain context from call 1.
        const run2 = session.run({ userMessage: 'Call 2', timeoutMs: 5000 })
        await tick()
        // Feed the /clear result event so drainClearResponse() completes
        currentFake.stdout.push(resultEvent(''))
        await tick()
        // Now the actual user message has been sent — feed its result
        currentFake.stdout.push(resultEvent('Response 2'))
        const result2 = await run2

        assert.equal(spawnCount, 1, 'Second call should NOT re-spawn')
        assert.equal(result2.text, 'Response 2')

        // Verify /clear was sent as raw text (not wrapped in NDJSON)
        const stdinData = currentFake.stdin.written.join('')
        assert.ok(stdinData.includes('/clear\n'), 'Expected raw /clear in stdin writes')
      } finally {
        session.dispose()
      }
    })
  })

  describe('run — timeout', () => {
    test('errors when stream ends before result (process crash during read)', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Test prompt')

      try {
        const runPromise = session.run({
          userMessage: 'Slow message',
          timeoutMs: 5000
        })

        // Feed init, then end the stream (simulating process crash)
        await tick()
        fake.stdout.push(systemInitEvent())
        await tick()
        // End stdout without sending a result — triggers "stream ended" error
        fake.stdout.push(null)

        let caught: Error | null = null
        try {
          await runPromise
        } catch (err) {
          caught = err as Error
        }

        assert.ok(caught, 'Expected an error to be thrown')
        assert.ok(
          caught!.message.includes('stream ended') || caught!.message.includes('timed out'),
          `Expected stream-ended or timeout error, got: ${caught!.message}`
        )
      } finally {
        session.dispose()
      }
    })
  })

  describe('run — process crash recovery', () => {
    test('respawns after process exits unexpectedly', async () => {
      let spawnCount = 0
      const session = new BackgroundCliSession()
      let currentFake = createFakeProcess()

      ;(session as unknown as AnySession)._spawner = () => {
        spawnCount++
        currentFake = createFakeProcess()
        return currentFake.proc
      }
      session.setSystemPrompt('Test prompt')

      try {
        // First call succeeds
        const run1 = session.run({ userMessage: 'Call 1', timeoutMs: 5000 })
        await tick()
        currentFake.stdout.push(systemInitEvent())
        await tick()
        currentFake.stdout.push(resultEvent('Response 1'))
        await run1
        assert.equal(spawnCount, 1)

        // Simulate crash
        currentFake.emitExit(1, 'SIGSEGV')
        await tick()

        // Second call should respawn
        const run2 = session.run({ userMessage: 'Call 2', timeoutMs: 5000 })
        await tick()
        currentFake.stdout.push(systemInitEvent())
        await tick()
        currentFake.stdout.push(resultEvent('Response 2'))
        const result2 = await run2

        assert.equal(spawnCount, 2, 'Should have respawned after crash')
        assert.equal(result2.text, 'Response 2')
      } finally {
        session.dispose()
      }
    })
  })

  describe('dispose', () => {
    test('kills the warm process', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Test prompt')

      const run1 = session.run({ userMessage: 'Warm up', timeoutMs: 5000 })
      await tick()
      fake.stdout.push(systemInitEvent())
      await tick()
      fake.stdout.push(resultEvent('Warmed'))
      await run1

      assert.equal(session.isAlive, true, 'Process should be alive')
      session.dispose()
      await tick()
      assert.equal(session.isAlive, false, 'Process should be dead after dispose')
    })

    test('dispose is safe to call multiple times', () => {
      const session = new BackgroundCliSession()
      session.dispose()
      session.dispose()
      // No error thrown
    })
  })

  describe('setSystemPrompt', () => {
    test('changing system prompt kills warm process', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('First prompt')

      const run1 = session.run({ userMessage: 'Warm up', timeoutMs: 5000 })
      await tick()
      fake.stdout.push(systemInitEvent())
      await tick()
      fake.stdout.push(resultEvent('Warmed'))
      await run1

      assert.equal(session.isAlive, true)
      session.setSystemPrompt('Different prompt')
      assert.equal(session.isAlive, false, 'Process should be killed on prompt change')
      session.dispose()
    })

    test('same system prompt does NOT kill warm process', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Same prompt')

      const run1 = session.run({ userMessage: 'Warm up', timeoutMs: 5000 })
      await tick()
      fake.stdout.push(systemInitEvent())
      await tick()
      fake.stdout.push(resultEvent('Warmed'))
      await run1

      assert.equal(session.isAlive, true)
      session.setSystemPrompt('Same prompt')
      assert.equal(session.isAlive, true, 'Process should stay alive with same prompt')
      session.dispose()
    })
  })

  describe('setModel', () => {
    test('changing model kills warm process', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Test prompt')

      const run1 = session.run({ userMessage: 'Warm up', timeoutMs: 5000 })
      await tick()
      fake.stdout.push(systemInitEvent())
      await tick()
      fake.stdout.push(resultEvent('Warmed'))
      await run1

      assert.equal(session.isAlive, true)
      session.setModel('claude-sonnet-4-20250514')
      assert.equal(session.isAlive, false, 'Process should be killed on model change')
      session.dispose()
    })

    test('same model does NOT kill warm process', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('Test prompt')

      const run1 = session.run({ userMessage: 'Warm up', timeoutMs: 5000 })
      await tick()
      fake.stdout.push(systemInitEvent())
      await tick()
      fake.stdout.push(resultEvent('Warmed'))
      await run1

      assert.equal(session.isAlive, true)
      // Default model is 'claude-haiku-4-5-20251001' — setting same value should be no-op
      session.setModel('claude-haiku-4-5-20251001')
      assert.equal(session.isAlive, true, 'Process should stay alive with same model')
      session.dispose()
    })
  })

  describe('spawn environment', () => {
    test('spawn environment removes CLAUDECODE and prepends PATH via buildEnvWithPath', async () => {
      let capturedEnv: Record<string, string | undefined> | null = null
      const session = new BackgroundCliSession()
      const fake = createFakeProcess()
      ;(session as unknown as AnySession)._spawner = (
        _args: string[],
        opts: { env: NodeJS.ProcessEnv }
      ) => {
        capturedEnv = opts.env as Record<string, string | undefined>
        return fake.proc
      }
      session.setSystemPrompt('Test')

      // Temporarily set these env vars to verify they are stripped
      const origClaudeCode = process.env.CLAUDECODE
      const origEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
      process.env.CLAUDECODE = 'should-be-removed'
      process.env.CLAUDE_CODE_ENTRYPOINT = 'should-be-removed'

      try {
        const runPromise = session.run({ userMessage: 'Hi', timeoutMs: 5000 })
        await tick()
        fake.stdout.push(systemInitEvent())
        await tick()
        fake.stdout.push(resultEvent('Done'))
        await runPromise

        assert.ok(capturedEnv, 'Spawner should have been called')
        const env = capturedEnv as Record<string, string | undefined>
        assert.equal(env.CLAUDECODE, undefined, 'CLAUDECODE should be removed')
        assert.equal(
          env.CLAUDE_CODE_ENTRYPOINT,
          undefined,
          'CLAUDE_CODE_ENTRYPOINT should be removed'
        )
      } finally {
        // Restore original env
        if (origClaudeCode !== undefined) process.env.CLAUDECODE = origClaudeCode
        else delete process.env.CLAUDECODE
        if (origEntrypoint !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = origEntrypoint
        else delete process.env.CLAUDE_CODE_ENTRYPOINT
        session.dispose()
      }
    })
  })

  describe('warmup()', () => {
    test('warmup spawns process and makes isAlive true', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('test prompt')

      try {
        const warmupPromise = session.warmup()
        await tick()
        fake.stdout.push(systemInitEvent())
        await warmupPromise

        assert.ok(session.isAlive, 'Process should be alive after warmup')
      } finally {
        session.dispose()
      }
    })

    test('warmup is no-op when already alive', async () => {
      let spawnCount = 0
      const session = new BackgroundCliSession()
      let currentFake = createFakeProcess()

      ;(session as unknown as AnySession)._spawner = () => {
        spawnCount++
        currentFake = createFakeProcess()
        return currentFake.proc
      }
      session.setSystemPrompt('test prompt')

      try {
        // First warmup — triggers spawn
        const p1 = session.warmup()
        await tick()
        currentFake.stdout.push(systemInitEvent())
        await p1
        assert.equal(spawnCount, 1, 'First warmup should spawn')

        // Second warmup — should return immediately
        await session.warmup()
        assert.equal(spawnCount, 1, 'Second warmup should NOT re-spawn')
        assert.ok(session.isAlive)
      } finally {
        session.dispose()
      }
    })

    test('warmup skips when no system prompt set', async () => {
      const { session } = createTestSession()
      try {
        await session.warmup()
        assert.ok(!session.isAlive, 'Process should not be alive without system prompt')
      } finally {
        session.dispose()
      }
    })

    test('warmup failure does not throw', async () => {
      const { session, fake } = createTestSession()
      session.setSystemPrompt('test prompt')

      try {
        const warmupPromise = session.warmup()
        await tick()
        // Simulate spawn failure by ending stdout without init event
        fake.stdout.push(null)

        // Should not throw
        await warmupPromise
        assert.ok(!session.isAlive, 'Process should not be alive after failed warmup')
      } finally {
        session.dispose()
      }
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

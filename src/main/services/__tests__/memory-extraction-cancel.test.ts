/**
 * memory-extraction-cancel.test.ts
 *
 * Pins the extraction retry loop's two cost-control rules:
 *   - `isRetryableExtractionError` classifies upstream throttling as retryable
 *     and local faults (missing CLI, bad usage) as not. The patterns are an
 *     assumption about what the Claude CLI prints; this is where that
 *     assumption is written down.
 *   - A cancelled run stops after the current attempt. Without the signal the
 *     loop sleeps 2s + 4s + 8s and spawns three more summarizers per in-flight
 *     chunk — work that is thrown away the moment it completes.
 *
 * No child processes and no DB: `spawnSummarizer` is replaced on the instance,
 * so the throw happens before any fact write.
 *
 * NOTE: other files in the shared runner replace `extractFromContent` as an own
 * property of the singleton. The prototype method is therefore called directly,
 * so this file measures the real implementation regardless of load order.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let isRetryableExtractionError: (err: unknown) => boolean
let memoryExtractionService: any
let extractFromContent: (...args: any[]) => Promise<number>
let loaded = false

try {
  // db/index first — base-repository imports it, so requiring the service cold
  // trips a TDZ cycle (`Cannot access 'BaseRepository'`).
  require('../../db/index')
  const mod = require('../memory-extraction.service')
  isRetryableExtractionError = mod.isRetryableExtractionError
  memoryExtractionService = mod.memoryExtractionService
  extractFromContent = Object.getPrototypeOf(memoryExtractionService).extractFromContent
  loaded = true
} catch (err) {
  console.error('[memory-extraction-cancel] module load failed:', err)
}

const CONTENT = 'A document with more than twenty characters of body text in it.'

/**
 * Drive the real `extractFromContent` with a `spawnSummarizer` that always
 * throws, counting attempts. Returns the attempt count and elapsed time.
 *
 * The harness starts async tests concurrently and this patch lands on a shared
 * singleton, so the cases take turns on the harness-wide exclusive lock.
 */
function countAttempts(
  message: string,
  signal?: AbortSignal,
  onAttempt?: (attempt: number) => void
): Promise<{ attempts: number; elapsedMs: number; error: unknown }> {
  return runExclusive(async () => {
    let attempts = 0
    const hadOwn = Object.prototype.hasOwnProperty.call(memoryExtractionService, 'spawnSummarizer')
    const original = memoryExtractionService.spawnSummarizer
    memoryExtractionService.spawnSummarizer = async (): Promise<string> => {
      attempts++
      onAttempt?.(attempts)
      throw new Error(message)
    }

    const startedAt = Date.now()
    let error: unknown = null
    try {
      await extractFromContent.call(
        memoryExtractionService,
        'ws-test',
        '/tmp/ws-test',
        'doc.md',
        CONTENT,
        undefined,
        signal ? { signal } : undefined
      )
    } catch (err) {
      error = err
    } finally {
      if (hadOwn) memoryExtractionService.spawnSummarizer = original
      else delete memoryExtractionService.spawnSummarizer
    }

    return { attempts, elapsedMs: Date.now() - startedAt, error }
  })
}

// ── Classifier ──────────────────────────────────────────────────────────────

describe('isRetryableExtractionError', () => {
  test('module loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-extraction.service must be requireable')
    assert.equal(typeof isRetryableExtractionError, 'function', 'must be exported for pinning')
  })

  for (const msg of [
    'Extraction failed (exit 1): API Error 429 rate limit exceeded',
    'Overloaded (529)',
    'upstream returned 503',
    'Error: overloaded_error',
    'Rate limit reached for model',
    'too many requests, slow down'
  ]) {
    test(`retryable: ${msg.slice(0, 44)}`, () => {
      if (!loaded) return
      assert.equal(isRetryableExtractionError(new Error(msg)), true)
    })
  }

  for (const msg of [
    'spawn claude ENOENT',
    '/bin/sh: claude: command not found',
    'Extraction failed (exit 1): usage: claude [options] [command]',
    'Extraction summarizer timed out after 5 minutes'
  ]) {
    test(`not retryable: ${msg.slice(0, 44)}`, () => {
      if (!loaded) return
      assert.equal(isRetryableExtractionError(new Error(msg)), false)
    })
  }
})

// ── Retry loop cost control ─────────────────────────────────────────────────

describe('extraction retry loop honours the cancel signal', () => {
  test('an already-aborted run makes exactly one attempt on a retryable error', async () => {
    if (!loaded) return
    const controller = new AbortController()
    controller.abort()

    const { attempts, elapsedMs, error } = await countAttempts(
      'API Error 429 rate limit',
      controller.signal
    )

    assert.equal(attempts, 1, 'a cancelled run must not pay for further attempts')
    assert.ok(
      elapsedMs < 500,
      `expected no backoff sleep on a cancelled run, took ${elapsedMs}ms (unsignalled: ~14000ms)`
    )
    assert.ok(error instanceof Error, 'the failure still propagates so the hash gate stays closed')
  })

  test('a non-retryable error makes exactly one attempt even without a signal', async () => {
    if (!loaded) return
    const { attempts, elapsedMs } = await countAttempts('/bin/sh: claude: command not found')
    assert.equal(attempts, 1, 'a missing CLI will still be missing in 2 seconds')
    assert.ok(elapsedMs < 500, `expected no backoff, took ${elapsedMs}ms`)
  })

  test('a retryable error does retry when the run is live (guards the cases above)', async () => {
    if (!loaded) return
    // Cancel from inside the second attempt so the guard costs one 2s backoff
    // rather than the full 2s + 4s + 8s schedule.
    const controller = new AbortController()
    const { attempts } = await countAttempts('API Error 429 rate limit', controller.signal, (n) => {
      if (n >= 2) controller.abort()
    })
    assert.equal(
      attempts,
      2,
      'if this were 1 the cancelled case above would pass for the wrong reason'
    )
  })
})

// ── Spawn shape ──────────────────────────────────────────────────────────────

const childProcess = require('node:child_process')

/** The slice of the ChildProcess surface `spawnSummarizer` actually touches. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdinWrites: string[] = []
  stdin = {
    on: (): void => {},
    end: (data?: string): void => {
      if (data !== undefined) this.stdinWrites.push(data)
    }
  }
}

interface SpawnCall {
  args: string[]
  opts: any
  child: FakeChild
}

/**
 * Swap `child_process.spawn` for the duration of `fn`. The service resolves
 * `spawn` off the module object at call time, so replacing the property is
 * enough — no loader hook needed, and nothing is actually executed.
 */
async function withFakeSpawn<T>(fn: (calls: SpawnCall[]) => Promise<T>): Promise<T> {
  const calls: SpawnCall[] = []
  const original = childProcess.spawn
  childProcess.spawn = (_cmd: string, args: string[], opts: any): FakeChild => {
    const child = new FakeChild()
    calls.push({ args, opts, child })
    return child
  }
  try {
    return await fn(calls)
  } finally {
    childProcess.spawn = original
  }
}

const spawnSummarizer = (): any => Object.getPrototypeOf(memoryExtractionService).spawnSummarizer

/**
 * A prompt passed as a positional argument counts against the OS command-line
 * ceiling — 32,767 characters on Windows, environment included. Every chunk
 * above it failed to spawn at all, deterministically, with an error that named
 * neither the prompt nor its size. The prompt belongs on stdin.
 */
describe('spawnSummarizer keeps the prompt off the command line', () => {
  const WINDOWS_ARGV_CEILING = 32_767

  test('a 200K prompt leaves argv small and arrives on stdin', async () => {
    if (!loaded) return
    const prompt = 'X'.repeat(200_000)

    const out = await runExclusive(() =>
      withFakeSpawn(async (calls) => {
        const promise: Promise<string> = spawnSummarizer().call(memoryExtractionService, prompt)

        assert.equal(calls.length, 1, 'expected exactly one spawn')
        const { args, opts, child } = calls[0]

        assert.ok(
          !args.includes(prompt),
          'the prompt must not be a positional argument — that is the ENAMETOOLONG path'
        )
        assert.ok(
          args.join(' ').length < WINDOWS_ARGV_CEILING,
          `argv is ${args.join(' ').length} chars, above the ${WINDOWS_ARGV_CEILING} Windows ceiling`
        )
        assert.equal(opts.stdio[0], 'pipe', 'stdin must be a pipe for the prompt to be writable')
        assert.equal(
          child.stdinWrites.join(''),
          prompt,
          'the whole prompt must reach the child on stdin'
        )

        child.stdout.emit('data', Buffer.from('FACT: something'))
        child.emit('exit', 0)
        return promise
      })
    )

    assert.equal(out, 'FACT: something')
  })

  test('-p stays a bare flag so --model is not swallowed as its value', async () => {
    if (!loaded) return
    await runExclusive(() =>
      withFakeSpawn(async (calls) => {
        const promise: Promise<string> = spawnSummarizer().call(memoryExtractionService, 'hello')
        const { args, child } = calls[0]

        assert.equal(args[0], '-p')
        assert.equal(args[1], '--model', '`-p` is boolean --print; the next arg must be --model')
        assert.ok(args.includes('--output-format'))

        child.stdout.emit('data', Buffer.from('ok'))
        child.emit('exit', 0)
        await promise
      })
    )
  })
})

// ── Suspend-aware timeout ───────────────────────────────────────────────────────

/**
 * A laptop that sleeps mid-extraction burns the 5-minute budget on wall clock
 * the child never got to use, so the timer fires the instant the host wakes and
 * kills healthy work. The child must survive the wake.
 */
describe('extraction timeout survives a host suspend', () => {
  test('a resume event re-arms the timer instead of aborting the child', async () => {
    if (!loaded) return
    const electron = require('electron')
    const before = electron.__powerMonitorMock.listenerCount('resume')

    await runExclusive(() =>
      withFakeSpawn(async (calls) => {
        const promise: Promise<string> = spawnSummarizer().call(memoryExtractionService, 'hello')
        const { opts, child } = calls[0]

        assert.equal(
          electron.__powerMonitorMock.listenerCount('resume'),
          before + 1,
          'an in-flight extraction must watch for the host waking up'
        )

        electron.__powerMonitorMock.emit('resume')
        assert.equal(opts.signal.aborted, false, 'waking the host must not kill a healthy child')

        child.stdout.emit('data', Buffer.from('ok'))
        child.emit('exit', 0)
        await promise

        assert.equal(
          electron.__powerMonitorMock.listenerCount('resume'),
          before,
          'the listener must be released when the child exits, or every spawn leaks one'
        )
      })
    )
  })
})

// summaryAsync calls process.exit — unguarded it kills the whole suite when this
// file is imported by a runner, taking every later test file with it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

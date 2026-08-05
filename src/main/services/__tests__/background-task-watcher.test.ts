/**
 * Tests for the long-running-command loop:
 *   - `wait_process`'s three exit paths (process exit / timeout / transport close)
 *   - the background task watcher's exit detection, notification summary,
 *     resume prompt, and the guards that stop it burning tokens unattended.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe } from './test-harness'
import { clampWaitTimeout, waitForProcessExit } from '../../mcp-servers/process-manager-server'
import {
  formatDuration,
  summarizeExit,
  buildResumePrompt,
  isProcessAlive,
  killProcessTree,
  BackgroundTaskWatcherService,
  type WatchedProcess,
  type ProcessExitInfo,
  type ProcessManifestEntry
} from '../background-task-watcher.service'

// ── Fixtures ──

function makeWatched(overrides: Partial<WatchedProcess> = {}): WatchedProcess {
  return {
    pid: 4242,
    label: 'docker compose build',
    command: 'docker compose build',
    cwd: '/repo',
    logFile: '123-4242.log',
    startedAt: Date.now() - 60_000,
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    resumeAttempts: 0,
    ...overrides
  }
}

function makeExit(overrides: Partial<ProcessExitInfo> = {}): ProcessExitInfo {
  return {
    pid: 4242,
    exitCode: 0,
    exitedAt: Date.now(),
    tail: 'Successfully built abc123',
    ...overrides
  }
}

/** A PID that is essentially guaranteed not to exist. */
const DEAD_PID = 0x7ffffff

function makeManifestEntry(overrides: Partial<ProcessManifestEntry> = {}): ProcessManifestEntry {
  return {
    pid: DEAD_PID,
    label: 'docker compose build',
    command: 'docker compose build',
    cwd: '/repo',
    startedAt: 1000,
    logFile: 'a.log',
    ...overrides
  }
}

/**
 * Run `fn` with `process.kill` intercepted, so a test can prove that *no*
 * signal was sent. Liveness probes (signal 0) pass through untouched — they are
 * how the service asks "is it alive", not an attempt to kill anything.
 */
async function withKillSpy(
  fn: (signals: Array<{ pid: number; signal: unknown }>) => unknown | Promise<unknown>
): Promise<Array<{ pid: number; signal: unknown }>> {
  const signals: Array<{ pid: number; signal: unknown }> = []
  const original = process.kill
  process.kill = ((pid: number, signal?: unknown): boolean => {
    if (signal === 0) return (original as (p: number, s?: unknown) => boolean).call(process, pid, 0)
    signals.push({ pid, signal })
    return true
  }) as typeof process.kill
  try {
    await fn(signals)
  } finally {
    process.kill = original
  }
  return signals
}



// ── wait_process: budget clamping ──

describe('clampWaitTimeout', () => {
  test('defaults to 120s when no timeout is given', () => {
    assert.equal(clampWaitTimeout(undefined), 120_000)
  })

  test('caps at the 480s hard maximum — must stay under the 10min turn timeout', () => {
    assert.equal(clampWaitTimeout(999_999_999), 480_000)
  })

  test('floors at the poll interval so the loop always runs at least once', () => {
    assert.equal(clampWaitTimeout(1), 2000)
  })

  test('passes a sane value through unchanged', () => {
    assert.equal(clampWaitTimeout(30_000), 30_000)
  })

  test('falls back to the default for a non-finite timeout', () => {
    assert.equal(clampWaitTimeout(Number.NaN), 120_000)
    assert.equal(clampWaitTimeout(Number.POSITIVE_INFINITY), 120_000)
  })
})

// ── wait_process: the three exit paths ──

describe('waitForProcessExit', () => {
  test('returns as soon as the process exits', async () => {
    let polls = 0
    const outcome = await waitForProcessExit({
      // Generous budget so the early return is unambiguous even on a loaded machine
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      isExited: () => ++polls >= 3,
      isTransportClosed: () => false
    })
    assert.equal(outcome.exited, true)
    assert.equal(outcome.aborted, false)
    assert.ok(outcome.waitedMs < 30_000, 'should return well before the deadline')
  })

  test('returns stillRunning when the budget is exhausted', async () => {
    const outcome = await waitForProcessExit({
      timeoutMs: 40,
      pollIntervalMs: 5,
      isExited: () => false,
      isTransportClosed: () => false
    })
    assert.equal(outcome.exited, false)
    assert.equal(outcome.aborted, false)
    assert.ok(outcome.waitedMs >= 30, 'should have consumed roughly the whole budget')
  })

  test('bails immediately when the transport closes — a cancelled turn must not spin', async () => {
    const outcome = await waitForProcessExit({
      timeoutMs: 10_000,
      pollIntervalMs: 5,
      isExited: () => false,
      isTransportClosed: () => true
    })
    assert.equal(outcome.aborted, true)
    assert.equal(outcome.exited, false)
    assert.ok(outcome.waitedMs < 1000, 'must not wait out the budget after an abort')
  })

  test('re-checks liveness after the budget expires — an exit on the last tick is not missed', async () => {
    // timeoutMs 0 means the poll loop never runs, isolating the final re-check
    const outcome = await waitForProcessExit({
      timeoutMs: 0,
      isExited: () => true,
      isTransportClosed: () => false
    })
    assert.equal(outcome.exited, true)
    assert.equal(outcome.aborted, false)
  })

  test('a still-running process after an expired budget reports stillRunning', async () => {
    const outcome = await waitForProcessExit({
      timeoutMs: 0,
      isExited: () => false,
      isTransportClosed: () => false
    })
    assert.equal(outcome.exited, false)
    assert.equal(outcome.aborted, false)
  })

  test('an exit takes priority over a simultaneous transport close', async () => {
    const outcome = await waitForProcessExit({
      timeoutMs: 1000,
      pollIntervalMs: 5,
      isExited: () => true,
      isTransportClosed: () => true
    })
    assert.equal(outcome.exited, true)
    assert.equal(outcome.aborted, false)
  })
})

// ── Pure helpers ──

describe('formatDuration', () => {
  test('seconds only', () => {
    assert.equal(formatDuration(45_000), '45s')
  })

  test('minutes and seconds', () => {
    assert.equal(formatDuration(723_000), '12m 3s')
  })

  test('hours and minutes', () => {
    assert.equal(formatDuration(7_320_000), '2h 2m')
  })

  test('never renders a negative duration', () => {
    assert.equal(formatDuration(-5000), '0s')
  })
})

describe('summarizeExit', () => {
  test('exit code 0 is reported as completed', () => {
    const result = summarizeExit(makeWatched(), makeExit({ exitCode: 0 }))
    assert.equal(result.status, 'completed')
    assert.ok(result.summary.includes('docker compose build'))
    assert.ok(result.summary.includes('successfully'))
  })

  test('a non-zero exit code is reported as failed with the code', () => {
    const result = summarizeExit(makeWatched(), makeExit({ exitCode: 1 }))
    assert.equal(result.status, 'failed')
    assert.ok(result.summary.includes('code 1'))
  })

  test('an unknown exit code is reported as failed, not silently as success', () => {
    const result = summarizeExit(makeWatched(), makeExit({ exitCode: null }))
    assert.equal(result.status, 'failed')
    assert.ok(result.summary.includes('unknown'))
  })

  test('summary includes the elapsed time', () => {
    const startedAt = 1_000_000
    const result = summarizeExit(
      makeWatched({ startedAt }),
      makeExit({ exitCode: 0, exitedAt: startedAt + 723_000 })
    )
    assert.ok(result.summary.includes('12m 3s'))
  })
})

describe('buildResumePrompt', () => {
  test('carries the command, pid, exit code and output tail', () => {
    const prompt = buildResumePrompt(makeWatched(), makeExit({ exitCode: 0 }))
    assert.ok(prompt.includes('docker compose build'))
    assert.ok(prompt.includes('4242'))
    assert.ok(prompt.includes('exit code 0'))
    assert.ok(prompt.includes('Successfully built abc123'))
  })

  test('tells the agent to report the result and not re-run the command', () => {
    const prompt = buildResumePrompt(makeWatched(), makeExit())
    assert.ok(/report this result/i.test(prompt))
    assert.ok(/do not re-run/i.test(prompt))
  })

  test('truncates a huge log tail so a wake-up cannot blow the context window', () => {
    const prompt = buildResumePrompt(makeWatched(), makeExit({ tail: 'x'.repeat(50_000) }))
    assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars`)
  })

  test('keeps the END of the tail — the failure is at the bottom of a build log', () => {
    const tail = 'noise\n'.repeat(2000) + 'ERROR: the real failure'
    const prompt = buildResumePrompt(makeWatched(), makeExit({ tail }))
    assert.ok(prompt.includes('ERROR: the real failure'))
  })

  test('handles an empty tail without producing an empty code block', () => {
    const prompt = buildResumePrompt(makeWatched(), makeExit({ tail: '' }))
    assert.ok(prompt.includes('(no output captured)'))
  })
})

describe('isProcessAlive', () => {
  test('the current process is alive', () => {
    assert.equal(isProcessAlive(process.pid), true)
  })

  test('an unused PID is dead', () => {
    assert.equal(isProcessAlive(DEAD_PID), false)
  })
})

// ── Watcher behaviour ──

describe('BackgroundTaskWatcherService', () => {
  let tmpRoot: string

  function setup(): {
    service: BackgroundTaskWatcherService
    repoPath: string
    stateDir: string
  } {
    tmpRoot = join(tmpdir(), `btw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const repoPath = join(tmpRoot, 'repo')
    const stateDir = join(repoPath, '.pm-state')
    mkdirSync(join(stateDir, 'logs'), { recursive: true })

    const service = new BackgroundTaskWatcherService()
    // Stub workspace enumeration — avoids needing a real database
    ;(service as unknown as { workspacePaths: () => unknown }).workspacePaths = () => [
      { workspaceId: 'ws-1', repoPath }
    ]
    return { service, repoPath, stateDir }
  }

  function cleanup(): void {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  test('lists processes from a workspace manifest with liveness', () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([
          {
            pid: process.pid,
            label: 'live one',
            command: 'npm run build',
            cwd: '/repo',
            startedAt: Date.now() - 1000,
            logFile: 'a.log',
            notifyOnExit: true
          },
          {
            pid: DEAD_PID,
            label: 'dead one',
            command: 'npm test',
            cwd: '/repo',
            startedAt: Date.now() - 2000,
            logFile: 'b.log'
          }
        ])
      )

      const list = service.listProcesses()
      assert.equal(list.length, 2)
      const live = list.find((p) => p.pid === process.pid)
      const dead = list.find((p) => p.pid === DEAD_PID)
      assert.equal(live?.alive, true)
      assert.equal(live?.workspaceId, 'ws-1', 'manifest entries bind to their workspace')
      assert.equal(dead?.alive, false)
    } finally {
      cleanup()
    }
  })

  test('a malformed manifest yields an empty list instead of throwing', () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(join(stateDir, 'manifest.json'), 'not json at all')
      assert.deepEqual(service.listProcesses(), [])
    } finally {
      cleanup()
    }
  })

  /** detectExit is private — bind it once, typed, instead of casting per call. */
  function detectExitOf(
    service: BackgroundTaskWatcherService
  ): (w: WatchedProcess) => ProcessExitInfo | 'cancelled' | null {
    return (
      service as unknown as {
        detectExit: (w: WatchedProcess) => ProcessExitInfo | 'cancelled' | null
      }
    ).detectExit.bind(service)
  }

  test('detectExit consumes the exit record and reports the real exit code', () => {
    const { service, stateDir } = setup()
    try {
      const recordPath = join(stateDir, 'exit-4242.json')
      writeFileSync(
        recordPath,
        JSON.stringify({ exitCode: 137, exitedAt: 1234, tail: 'killed' })
      )

      const exit = detectExitOf(service)(makeWatched({ pid: 4242 })) as ProcessExitInfo
      assert.equal(exit.exitCode, 137)
      assert.equal(exit.tail, 'killed')
      assert.equal(existsSync(recordPath), false, 'record must be consumed, not re-fired')
    } finally {
      cleanup()
    }
  })

  test('detectExit falls back to liveness when the MCP server left no record', () => {
    const { service, stateDir } = setup()
    try {
      // Still listed in the manifest = the MCP server died before its child.
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([makeManifestEntry({ pid: process.pid }), makeManifestEntry()])
      )
      const detect = detectExitOf(service)

      assert.equal(detect(makeWatched({ pid: process.pid })), null, 'a live process has not exited')

      const exit = detect(makeWatched({ pid: DEAD_PID }))
      assert.ok(exit && exit !== 'cancelled', 'a dead process is detected without a record')
      assert.equal(
        (exit as ProcessExitInfo).exitCode,
        null,
        'exit code is unknown on the fallback path'
      )
    } finally {
      cleanup()
    }
  })

  test('detectExit reports cancelled when the manifest entry is gone — the agent stopped it', () => {
    const { service, stateDir } = setup()
    try {
      // stop_process removes the entry and writes no exit record. Reporting a
      // failure here would alarm the user about a kill they asked for.
      writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify([]))

      assert.equal(detectExitOf(service)(makeWatched({ pid: DEAD_PID })), 'cancelled')
    } finally {
      cleanup()
    }
  })

  test('an exit record still wins over a missing manifest entry', () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify([]))
      writeFileSync(
        join(stateDir, `exit-${DEAD_PID}.json`),
        JSON.stringify({ exitCode: 0, exitedAt: 5000, tail: 'done' })
      )

      const exit = detectExitOf(service)(makeWatched({ pid: DEAD_PID }))
      assert.notEqual(exit, 'cancelled', 'a real exit record is authoritative')
      assert.equal((exit as ProcessExitInfo).exitCode, 0)
    } finally {
      cleanup()
    }
  })

  test('a corrupt exit record is discarded rather than re-read forever', () => {
    const { service, stateDir } = setup()
    try {
      const recordPath = join(stateDir, 'exit-4242.json')
      writeFileSync(recordPath, '{ broken')

      detectExitOf(service)(makeWatched({ pid: 4242 }))
      assert.equal(existsSync(recordPath), false)
    } finally {
      cleanup()
    }
  })

  test('cancelWatch disarms auto-resume and reports whether a watch existed', () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify([makeManifestEntry({ pid: 4242 })]))
      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      watched.set(4242, makeWatched())

      assert.deepEqual(service.cancelWatch(4242), { cancelled: true })
      assert.equal(watched.has(4242), false)
      assert.deepEqual(service.cancelWatch(4242), { cancelled: false }, 'cancelling twice is a no-op')
    } finally {
      cleanup()
    }
  })

  test('cancelWatch on a pid we never spawned says so', () => {
    const { service } = setup()
    try {
      assert.deepEqual(service.cancelWatch(DEAD_PID), { cancelled: false, reason: 'untracked' })
    } finally {
      cleanup()
    }
  })

  test('stopProcess disarms the watch — a user-initiated stop must not wake the agent', async () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify([makeManifestEntry()]))
      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      watched.set(DEAD_PID, makeWatched({ pid: DEAD_PID }))

      const result = await service.stopProcess(DEAD_PID)
      assert.equal(result.alreadyExited, true)
      assert.equal(watched.has(DEAD_PID), false, 'stopping must not leave a wake-up armed')
    } finally {
      cleanup()
    }
  })

  test('stopProcess refuses an untracked pid and sends no signal at all', async () => {
    const { service } = setup()
    try {
      let result: Awaited<ReturnType<BackgroundTaskWatcherService['stopProcess']>> | null = null
      const signals = await withKillSpy(async () => {
        // pid 1 is the worst case: killProcessTree negates it, and kill(-1, …)
        // signals every process this user owns.
        result = await service.stopProcess(1)
      })

      assert.deepEqual(result, { stopped: false, alreadyExited: false, reason: 'untracked' })
      assert.deepEqual(signals, [], 'an untracked pid must never be signalled')
    } finally {
      cleanup()
    }
  })

  test('stopProcess removes the entry from the manifest so the UI stops listing it', async () => {
    const { service, stateDir } = setup()
    try {
      const manifestPath = join(stateDir, 'manifest.json')
      writeFileSync(
        manifestPath,
        JSON.stringify([makeManifestEntry({ label: 'gone', command: 'x', startedAt: 1 })])
      )

      await service.stopProcess(DEAD_PID)
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf-8')), [])
    } finally {
      cleanup()
    }
  })

  test('discovery only arms watches for processes that opted in', async () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([
          {
            pid: process.pid,
            label: 'dev server',
            command: 'npm run dev',
            cwd: '/repo',
            startedAt: Date.now(),
            logFile: 'a.log'
            // no notifyOnExit — a watcher/dev server must never trigger a wake-up
          }
        ])
      )
      ;(
        service as unknown as { resolveConversationId: () => Promise<string | null> }
      ).resolveConversationId = async () => 'conv-1'
      ;(service as unknown as { saveState: () => void }).saveState = () => {}
      await (
        service as unknown as { discoverNewWatches: () => Promise<void> }
      ).discoverNewWatches.call(service)

      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      assert.equal(watched.size, 0, 'opt-out processes must not be watched')
    } finally {
      cleanup()
    }
  })

  test('discovery ignores a notifyOnExit process that is already dead (no stale wake-up)', async () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([
          {
            pid: DEAD_PID,
            label: 'build that finished while the app was closed',
            command: 'npm run build',
            cwd: '/repo',
            startedAt: Date.now(),
            logFile: 'a.log',
            notifyOnExit: true
          }
        ])
      )
      ;(
        service as unknown as { resolveConversationId: () => Promise<string | null> }
      ).resolveConversationId = async () => 'conv-1'
      ;(service as unknown as { saveState: () => void }).saveState = () => {}
      await (
        service as unknown as { discoverNewWatches: () => Promise<void> }
      ).discoverNewWatches.call(service)

      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      assert.equal(watched.size, 0)
    } finally {
      cleanup()
    }
  })

  test('a cancelled process is dropped silently — no notification, no wake-up', async () => {
    const { service, stateDir } = setup()
    try {
      // The agent called stop_process: manifest entry gone, no exit record.
      writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify([]))

      const notified: number[] = []
      const resumed: string[] = []
      ;(service as unknown as { notify: (w: WatchedProcess) => void }).notify = (w) => {
        notified.push(w.pid)
      }
      ;(service as unknown as { canResume: () => boolean }).canResume = () => true
      ;(service as unknown as { doResume: (id: string) => Promise<void> }).doResume = async (id) => {
        resumed.push(id)
      }
      ;(service as unknown as { saveState: () => void }).saveState = () => {}
      ;(service as unknown as { emitChanged: () => void }).emitChanged = () => {}

      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      watched.set(DEAD_PID, makeWatched({ pid: DEAD_PID }))

      await (service as unknown as { processExits: () => Promise<void> }).processExits.call(service)

      assert.equal(watched.size, 0, 'the watch is dropped')
      assert.deepEqual(notified, [], 'a deliberate kill must not be reported as a failure')
      assert.deepEqual(resumed, [], 'and must not wake the agent')
    } finally {
      cleanup()
    }
  })

  test('loadState drops a restored watch whose PID was recycled', () => {
    const { service, repoPath, stateDir } = setup()
    try {
      const statePath = join(tmpRoot, 'background-watches.json')
      writeFileSync(
        statePath,
        JSON.stringify([
          makeWatched({ pid: process.pid, startedAt: 1000, command: 'npm run build' })
        ])
      )
      // Same live PID, but the manifest says it belongs to a different launch.
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([
          makeManifestEntry({ pid: process.pid, startedAt: 9999, command: 'npm run build' })
        ])
      )
      ;(service as unknown as { stateFilePath: string }).stateFilePath = statePath
      ;(service as unknown as { loadState: () => void }).loadState.call(service)

      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      assert.equal(watched.size, 0, 'a startedAt mismatch means this is not our process')

      // Exact identity match → restored.
      writeFileSync(
        join(repoPath, '.pm-state', 'manifest.json'),
        JSON.stringify([
          makeManifestEntry({ pid: process.pid, startedAt: 1000, command: 'npm run build' })
        ])
      )
      ;(service as unknown as { loadState: () => void }).loadState.call(service)
      assert.equal(watched.size, 1)
    } finally {
      cleanup()
    }
  })

  test('a tick resolves the workspace list once, not once per watched process', async () => {
    const { service, stateDir } = setup()
    try {
      writeFileSync(
        join(stateDir, 'manifest.json'),
        JSON.stringify([
          makeManifestEntry({ pid: DEAD_PID }),
          makeManifestEntry({ pid: DEAD_PID + 1 }),
          makeManifestEntry({ pid: DEAD_PID + 2 })
        ])
      )

      let lookups = 0
      ;(service as unknown as { workspacePaths: () => unknown }).workspacePaths = () => {
        lookups++
        return [{ workspaceId: 'ws-1', repoPath: join(tmpRoot, 'repo') }]
      }
      ;(service as unknown as { notify: () => void }).notify = () => {}
      ;(service as unknown as { canResume: () => boolean }).canResume = () => true
      ;(service as unknown as { doResume: () => Promise<void> }).doResume = async () => {}
      ;(service as unknown as { saveState: () => void }).saveState = () => {}
      ;(service as unknown as { emitChanged: () => void }).emitChanged = () => {}

      const watched = (service as unknown as { watched: Map<number, WatchedProcess> }).watched
      watched.set(DEAD_PID, makeWatched({ pid: DEAD_PID }))
      watched.set(DEAD_PID + 1, makeWatched({ pid: DEAD_PID + 1 }))
      watched.set(DEAD_PID + 2, makeWatched({ pid: DEAD_PID + 2 }))

      await (service as unknown as { tick: () => Promise<void> }).tick.call(service)

      assert.equal(lookups, 1, `workspacePaths() ran ${lookups}× in one tick`)
    } finally {
      cleanup()
    }
  })
})

// ── PID safety ──

describe('killProcessTree', () => {
  test('refuses pid 1 — kill(-1) would signal every process the user owns', async () => {
    const signals = await withKillSpy(() => killProcessTree(1, 'SIGTERM'))
    assert.deepEqual(signals, [])
  })

  test('refuses 0, negative and non-integer pids', async () => {
    const signals = await withKillSpy(() => {
      killProcessTree(0, 'SIGKILL')
      killProcessTree(-99, 'SIGTERM')
      killProcessTree(Number.NaN, 'SIGTERM')
      killProcessTree(1.5, 'SIGTERM')
    })
    assert.deepEqual(signals, [])
  })
})

// ── Conversation binding ──

describe('BackgroundTaskWatcherService conversation binding', () => {
  const WORKSPACE_OF: Record<string, string> = {
    'conv-streaming': 'ws-1',
    'conv-last-active': 'ws-1',
    'conv-other-workspace': 'ws-2',
    'conv-first': 'ws-1'
  }

  /**
   * Bind pid → conversation with each source instrumented, so the *order* of
   * the fallbacks is asserted and not just the winner.
   *
   * Every source is stubbed on the instance: the repository and lifecycle
   * singletons are shared, and the harness runs async tests concurrently, so
   * mutating them here would leak into other tests.
   */
  async function resolve(opts: {
    streaming: string | null
    lastActive: string | null
  }): Promise<{ result: string | null; order: string[] }> {
    const order: string[] = []
    const service = new BackgroundTaskWatcherService() as unknown as {
      streamingConversationId: (ws: string) => string | null
      lastActiveConversationId: () => Promise<string | null>
      conversationWorkspaceId: (id: string) => string | null
      firstConversationId: (ws: string) => string | null
      resolveConversationId: (ws: string) => Promise<string | null>
    }

    service.streamingConversationId = () => {
      order.push('streaming')
      return opts.streaming
    }
    service.lastActiveConversationId = async () => {
      order.push('lastActive')
      return opts.lastActive
    }
    service.conversationWorkspaceId = (id) => WORKSPACE_OF[id] ?? null
    service.firstConversationId = () => {
      order.push('firstConversation')
      return 'conv-first'
    }

    return { result: await service.resolveConversationId('ws-1'), order }
  }

  test('prefers a conversation streaming in this workspace', async () => {
    const { result, order } = await resolve({
      streaming: 'conv-streaming',
      lastActive: 'conv-last-active'
    })
    assert.equal(result, 'conv-streaming')
    assert.deepEqual(order, ['streaming'], 'no other source should be consulted')
  })

  test('falls back to the last active chat when the spawning turn already ended', async () => {
    const { result, order } = await resolve({ streaming: null, lastActive: 'conv-last-active' })
    assert.equal(result, 'conv-last-active')
    assert.deepEqual(order, ['streaming', 'lastActive'])
  })

  test('ignores a last active chat that belongs to another workspace', async () => {
    const { result, order } = await resolve({
      streaming: null,
      lastActive: 'conv-other-workspace'
    })
    assert.equal(result, 'conv-first')
    assert.deepEqual(order, ['streaming', 'lastActive', 'firstConversation'])
  })

  test('last resort is the workspace’s first conversation', async () => {
    const { result, order } = await resolve({ streaming: null, lastActive: null })
    assert.equal(result, 'conv-first')
    assert.deepEqual(order, ['streaming', 'lastActive', 'firstConversation'])
  })
})

// ── Auto-resume guards ──

describe('BackgroundTaskWatcherService auto-resume guards', () => {
  /** Build a service with notification + resume stubbed so we can assert on the guards. */
  function harness(canResume: boolean): {
    service: BackgroundTaskWatcherService
    notified: string[]
    resumed: string[]
  } {
    const service = new BackgroundTaskWatcherService()
    const notified: string[] = []
    const resumed: string[] = []
    ;(service as unknown as { notify: (w: WatchedProcess, s: string) => void }).notify = (w) => {
      notified.push(String(w.pid))
    }
    ;(service as unknown as { canResume: () => boolean }).canResume = () => canResume
    ;(service as unknown as { doResume: (id: string) => Promise<void> }).doResume = async (id) => {
      resumed.push(id)
    }
    return { service, notified, resumed }
  }

  function handleExit(
    service: BackgroundTaskWatcherService,
    watched: WatchedProcess,
    exit: ProcessExitInfo
  ): Promise<boolean> {
    return (
      service as unknown as {
        handleExit: (w: WatchedProcess, e: ProcessExitInfo) => Promise<boolean>
      }
    ).handleExit(watched, exit)
  }

  test('a busy conversation defers the resume and keeps the watch for the next tick', async () => {
    const { service, notified, resumed } = harness(false)
    const watched = makeWatched()

    const done = await handleExit(service, watched, makeExit())
    assert.equal(done, false, 'watch must be retained so the next tick retries')
    assert.equal(resumed.length, 0)
    assert.equal(watched.resumeAttempts, 1)
    assert.deepEqual(notified, ['4242'], 'the notification still fires immediately')
  })

  test('the notification fires exactly once across busy retries', async () => {
    const { service, notified } = harness(false)
    const watched = makeWatched()

    await handleExit(service, watched, makeExit())
    await handleExit(service, watched, makeExit())
    await handleExit(service, watched, makeExit())

    assert.equal(notified.length, 1, 'retrying must not re-toast the user')
    assert.equal(watched.resumeAttempts, 3)
  })

  test('retries are abandoned after the attempt cap so a watch cannot leak forever', async () => {
    const { service } = harness(false)
    const watched = makeWatched({ resumeAttempts: 59 })

    const done = await handleExit(service, watched, makeExit())
    assert.equal(done, true, 'the watch is dropped once the cap is hit')
  })

  test('an idle conversation gets exactly one auto-resume', async () => {
    const { service, resumed } = harness(true)

    const done = await handleExit(service, makeWatched(), makeExit())
    assert.equal(done, true)
    assert.deepEqual(resumed, ['conv-1'])
  })

  test('the per-conversation cap stops runaway unattended wake-ups', async () => {
    const { service, resumed } = harness(true)

    for (let i = 0; i < 8; i++) {
      await handleExit(service, makeWatched({ pid: 1000 + i }), makeExit())
    }

    assert.equal(resumed.length, 5, 'at most 5 auto-resumes per conversation per session')
  })

  test('a process with no bound conversation notifies only', async () => {
    const { service, notified, resumed } = harness(true)

    const done = await handleExit(service, makeWatched({ conversationId: null }), makeExit())
    assert.equal(done, true)
    assert.equal(resumed.length, 0)
    assert.equal(notified.length, 1)
  })
})

import { app } from 'electron'
import { writeSync, openSync, closeSync, fsyncSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import log from './logger'

/**
 * Lifecycle + resource instrumentation for diagnosing abrupt main-process deaths.
 *
 * Why this exists: when the app is hard-killed (Force Quit / `kill -9`) or loses
 * its backing volume, it produces NO crash report, NO Crashpad minidump, and
 * electron-log's buffered file lines can be lost. The result is a log that just
 * "flatlines" with no cause. This module closes that gap by:
 *
 *   1. Writing a heartbeat of process vitals (rss/heap/etc.) to a DEDICATED file
 *      that is `fsync`'d every tick — so the last line is the app's final known
 *      state even under SIGKILL, giving a reliable "last alive" timestamp.
 *   2. Logging catchable termination signals (SIGTERM/SIGINT/SIGHUP/SIGQUIT) —
 *      so a polite `kill`/`pkill`/script shutdown is distinguishable from an
 *      uncatchable Force Quit (SIGKILL leaves no signal line, only the last
 *      heartbeat).
 *   3. Logging the synchronous `exit` event with its code — so self-inflicted
 *      `process.exit()`/`app.exit()` paths are visible.
 *   4. Tracking elapsed uptime and child process counts to make the 15-minute
 *      SEAMKILL pattern diagnosable in the vitals log itself.
 */

export const vitalsLog = log.scope('Vitals')

/** App-specific gauges, injected so this module stays dependency-free. */
interface VitalsProviders {
  /** Number of live OpenCode/oMLX sessions (detects zombie/runaway streams). */
  activeOpenCodeSessions?: () => number
  /** Number of pending retry timers (detects an unbounded retry storm). */
  pendingRetryTimers?: () => number
  /** Function to count child processes (claude/opencode/npm) — for zombie detection. */
  childProcessCount?: () => number
  /** Open the /proc/self/fd count (useful for detecting fd exhaustion kills). */
  fdCount?: () => number
}

let providers: VitalsProviders = {}
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let vitalsFd: number | undefined
let vitalsPath: string | undefined
let lastRss = 0
const processStartTime = Date.now()
let initialised = false // one-time setup (file, signals, exit handler)
let running = false     // heartbeat is actively ticking

/** Register app-specific gauges. Safe to call before or after {@link startVitals}. */
export function setVitalsProviders(p: VitalsProviders): void {
  providers = { ...providers, ...p }
}

const mb = (n: number): number => Math.round(n / 1024 / 1024)

/** Format: seconds + minutes for quick time-to-death reading. */
function elapsed(): string {
  const total = Math.floor((Date.now() - processStartTime) / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}m${secs}s`
}

function sample(): string {
  const m = process.memoryUsage()
  const parts = [
    `rss=${mb(m.rss)}MB`,
    `heapUsed=${mb(m.heapUsed)}MB`,
    `heapTotal=${mb(m.heapTotal)}MB`,
    `external=${mb(m.external)}MB`,
    `arrayBuffers=${mb(m.arrayBuffers)}MB`
  ]
  try {
    if (providers.activeOpenCodeSessions) parts.push(`ocSessions=${providers.activeOpenCodeSessions()}`)
    if (providers.pendingRetryTimers) parts.push(`retryTimers=${providers.pendingRetryTimers()}`)
    if (providers.childProcessCount) parts.push(`childProcs=${providers.childProcessCount()}`)
    if (providers.fdCount) parts.push(`fds=${providers.fdCount()}`)
  } catch {
    /* provider errors must never break instrumentation */
  }
  return parts.join(' ')
}

/**
 * Resolve the most reliable log directory for vitals.
 * Falls back from `app.getPath('logs')` → home-dir-based path → /tmp.
 */
function resolveVitalsPath(): string {
  const candidates: string[] = []

  // Candidate 1: electron's logs dir
  try {
    candidates.push(join(app.getPath('logs'), 'vitals.log'))
  } catch {
    /* app.getPath may throw if app isn't ready */
  }

  // Candidate 2: app.getPath('userData')/logs (Electron stores logs under userData)
  try {
    candidates.push(join(app.getPath('userData'), 'logs', 'vitals.log'))
  } catch {
    /* silent */
  }

  // Candidate 3: home-dir based
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    candidates.push(join(home, 'Library', 'Logs', 'code-atelier', 'vitals.log'))
  }

  // Candidate 4: /tmp as a last resort
  candidates.push(join('/tmp', 'code-atelier-vitals.log'))

  for (const candidate of candidates) {
    const dir = join(candidate, '..')
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* skip */ }
    }
    // Quick write test — does the path have write permission?
    try {
      const fd = openSync(candidate, 'a')
      writeSync(fd, `TEST: path resolution test ok\n`)
      closeSync(fd)
      try { unlinkSync(candidate) } catch { /* non-fatal */ }
      return candidate
    } catch {
      /* Not writable, try next */
      continue
    }
  }

  // If all candidates failed to pass the write test, return the first one anyway
  // (we'll catch the error on first real write — non-fatal)
  return candidates[0] ?? '/tmp/code-atelier-vitals.log'
}

/** Append one line to the dedicated vitals file and force it to disk. */
function writeVitals(prefix: string): void {
  if (vitalsFd === undefined) return
  try {
    writeSync(vitalsFd, `${new Date().toISOString()} ${prefix}${sample()}\n`)
    // fsyncSync blocks the main thread on Windows NTFS — can stall 100ms–5s+
    // after sleep/wake or under disk I/O contention. On macOS/Linux, APFS/ext4
    // fsync is fast enough to keep for crash-safety diagnostics.
    if (process.platform !== 'win32') {
      fsyncSync(vitalsFd)
    }
  } catch {
    /* best-effort — never throw from the death path */
  }
}

/**
 * Start heartbeat + lifecycle logging.
 *
 * First call performs one-time setup (file, signals, exit handler).
 * Subsequent calls (e.g. after {@link stopVitals} on power-resume) restart
 * only the heartbeat timer — signals and the exit handler are never re-registered.
 *
 * @param intervalMs heartbeat cadence (default 5s — small fsync'd lines, cheap).
 */
export function startVitals(intervalMs = 5000): void {
  if (running) return // heartbeat already ticking

  // ── One-time setup (file handle, startup marker, signal + exit handlers) ──
  if (!initialised) {
    initialised = true

    // Resolve and test a writable path for the vitals file
    vitalsPath = resolveVitalsPath()
    vitalsLog.info(`Vitals target path: ${vitalsPath}`)

    try {
      vitalsFd = openSync(vitalsPath, 'a')
      vitalsLog.info(`Vitals heartbeat → ${vitalsPath} (every ${intervalMs}ms)`)
    } catch (e) {
      vitalsLog.warn(`Could not open vitals file — heartbeat will only hit main.log:', ${e}`)
      vitalsLog.warn(`Searched path: ${vitalsPath}`)
    }

    // Startup marker: record WHERE the app is running from. A build-output
    // (`/dist/`) or mounted-DMG (`/Volumes/`) launch is deleted/unmounted out from
    // under the process on the next rebuild/eject — an uncatchable death that
    // leaves no crash report. Warn loudly so a fragile launch is obvious in logs.
    const exe = process.execPath
    const fragile = /\/dist\/|^\/Volumes\//.test(exe)
    const marker = `START v${app.getVersion()} exe=${exe} uptime=${elapsed()}`
    writeVitals(`${marker} `)
    if (fragile) {
      vitalsLog.error(
        `Running from a FRAGILE location — a rebuild or DMG eject will hard-kill the app: ${exe}. ` +
          `Install to /Applications and launch from there.`
      )
    } else {
      vitalsLog.info(marker)
    }

    // Catchable termination signals: a script/pkill sends SIGTERM; Ctrl-C sends
    // SIGINT. Logging + re-raising lets us tell these apart from an uncatchable
    // SIGKILL/Force Quit (which leaves no signal line — only the last heartbeat).
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
    for (const sig of signals) {
      process.once(sig, () => {
        vitalsLog.error(`Received ${sig} — terminating. Final vitals: ${sample()} uptime=${elapsed()}`)
        writeVitals(`SIGNAL ${sig} `)
        // Handler was `once`, so re-raising now hits the default action (terminate).
        process.kill(process.pid, sig)
      })
    }

    // Fires on normal exit and self-inflicted process.exit()/app.exit(); NOT on
    // SIGKILL. Synchronous-only context — every call here is sync.
    process.on('exit', (code) => {
      vitalsLog.info(`process 'exit' code=${code}. Final vitals: ${sample()} uptime=${elapsed()}`)
      writeVitals(`EXIT code=${code} `)
      if (vitalsFd !== undefined) {
        try {
          closeSync(vitalsFd)
        } catch {
          /* best-effort */
        }
        vitalsFd = undefined
      }
    })
  }

  // ── Start (or restart) the heartbeat timer ──
  const tick = (): void => {
    const rss = process.memoryUsage().rss
    // Surface a sudden doubling of RSS — the fingerprint of a runaway/leak
    // building toward an OOM before an external kill.
    if (lastRss > 0 && rss > lastRss * 2) {
      vitalsLog.warn(`RSS doubled since last tick (${mb(lastRss)}MB → ${mb(rss)}MB): ${sample()} uptime=${elapsed()}`)
    }
    lastRss = rss
    writeVitals('')
  }
  tick()
  heartbeatTimer = setInterval(tick, intervalMs)
  heartbeatTimer.unref?.()
  running = true
}

/**
 * Stop the heartbeat timer.
 * Used on graceful shutdown and on system suspend (power events).
 * After calling this, {@link startVitals} can be called again to resume.
 */
export function stopVitals(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  running = false
}

/**
 * Set the file descriptor count provider.
 * Call this early after app.whenReady() to track open fd count
 * (a common cause of system-level kills when the limit is reached).
 */
export function setFdCountProvider(fn: () => number): void {
  providers = { ...providers, fdCount: fn }
}

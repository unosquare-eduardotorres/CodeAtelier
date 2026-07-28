/**
 * BackgroundCliSession — persistent interactive Claude CLI process for lightweight
 * one-shot tasks (prompt optimization).
 *
 * Instead of spawning a fresh `claude -p` process per call (~3-5s overhead), this
 * keeps a warm interactive process alive and sends user messages via NDJSON stdin.
 * Before each new call, `/clear` resets the conversation context while preserving
 * the system prompt.
 *
 * Key design:
 *  - Scoped to the prompt optimizer's META_PROMPT (system prompt locked at spawn)
 *  - Promise-based mutex serializes concurrent callers
 *  - 5-minute idle timeout kills the process; respawns on next demand
 *  - Per-call 15s default timeout
 *  - Process crash → marks dead → next call respawns
 */

import { spawn, type ChildProcess } from 'node:child_process'
import log from 'electron-log'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseNdjsonStream, writeNdjsonMessage, buildUserMessage } from './cli-executor/ndjson-parser'
import type { OneShotUsage } from './one-shot-claude'

const sessionLog = log.scope('bg-cli-session')

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_CALL_TIMEOUT_MS = 15_000 // 15 seconds

export interface BackgroundCliRunResult {
  text: string
  usage: OneShotUsage
}

type Spawner = (args: string[], opts: { stdio: string[]; env: NodeJS.ProcessEnv }) => ChildProcess

/**
 * Race a promise against a timeout, returning a cleanup function for the timer.
 * Prevents unhandled rejections from dangling timeout promises.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): { result: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    if (timer.unref) timer.unref()
  })

  return {
    result: Promise.race([promise, timeoutPromise]),
    cancel: () => {
      if (timer) clearTimeout(timer)
      // Swallow the timeout promise to prevent unhandled rejection
      timeoutPromise.catch(() => {})
    }
  }
}

/**
 * Reads NDJSON events from the iterator until a `result` event is found.
 * Returns the result text and usage. Ignores all other event types.
 */
async function readOneShotResult(
  iterator: AsyncGenerator<Record<string, unknown>>,
  timeoutMs: number
): Promise<BackgroundCliRunResult> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  let usage: OneShotUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Background CLI session timed out after ${timeoutMs}ms`)
    }

    const race = raceWithTimeout(
      iterator.next(),
      remaining,
      `Background CLI session timed out after ${timeoutMs}ms`
    )

    let iterResult: IteratorResult<Record<string, unknown>>
    try {
      iterResult = await race.result
    } finally {
      race.cancel()
    }

    if (iterResult.done) {
      throw new Error('Background CLI stream ended before result event')
    }

    const event = iterResult.value
    const type = event.type as string | undefined

    if (type === 'result') {
      const resultText = typeof event.result === 'string'
        ? event.result
        : ''
      const usageObj = (event.usage ?? {}) as Record<string, unknown>
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      usage = {
        input: num(usageObj.input_tokens),
        output: num(usageObj.output_tokens),
        cacheRead: num(usageObj.cache_read_input_tokens),
        cacheCreation: num(usageObj.cache_creation_input_tokens)
      }
      text = resultText
      break
    }
  }

  return { text, usage }
}

export class BackgroundCliSession {
  private process: ChildProcess | null = null
  private ndjsonIterator: AsyncGenerator<Record<string, unknown>> | null = null
  private alive = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private systemPromptFile: string | null = null
  private mutexTail: Promise<void> = Promise.resolve()
  private needsClear = false
  private model: string = 'claude-haiku-4-5-20251001'

  /** Test seam — overrides spawn('claude', ...) for tests */
  _spawner?: Spawner

  /** System prompt to use for spawning (set externally) */
  private systemPrompt: string = ''

  /**
   * Configure the system prompt for this session.
   * Must be called before the first `run()` call.
   */
  setSystemPrompt(prompt: string): void {
    if (this.systemPrompt !== prompt) {
      this.systemPrompt = prompt
      // If the prompt changed and we have a warm process, kill it
      // so the next call spawns with the new prompt.
      if (this.alive) {
        sessionLog.info('[bg-cli] System prompt changed — disposing warm process')
        this.killProcess()
      }
    }
  }

  /**
   * Configure the model for this session.
   * If the model changes while a process is alive, the process is killed
   * so the next call spawns with the new model.
   */
  setModel(model: string): void {
    if (this.model !== model) {
      this.model = model
      if (this.alive) {
        sessionLog.info('[bg-cli] Model changed — disposing warm process')
        this.killProcess()
      }
    }
  }

  /**
   * Send a user message to the warm CLI session and return the response.
   * Serializes concurrent callers via mutex.
   */
  async run(params: {
    userMessage: string
    timeoutMs?: number
  }): Promise<BackgroundCliRunResult> {
    const { userMessage, timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = params

    // Mutex: serialize concurrent callers
    const release = this.acquireMutex()
    try {
      await release.acquired
      return await this.runInner(userMessage, timeoutMs)
    } finally {
      release.release()
    }
  }

  /**
   * Kill the warm process and clean up resources.
   * Safe to call multiple times.
   *
   * Intentionally lockless — does NOT acquire the mutex. If a `run()` is
   * in-flight, killing the process causes `readOneShotResult()` to throw
   * a stream-closed error, which `runInner()` catches and rethrows.
   * The caller (prompt optimizer) then falls back to the original prompt.
   */
  dispose(): void {
    this.clearIdleTimer()
    this.killProcess()
    sessionLog.info('[bg-cli] Session disposed')
  }

  /** Check if the process is alive */
  get isAlive(): boolean {
    return this.alive && this.process !== null && !this.process.killed
  }

  // ── Private implementation ──

  private acquireMutex(): { acquired: Promise<void>; release: () => void } {
    const acquired = new Promise<void>((resolve) => {
      // Chain onto the tail: our turn starts when the previous finishes
      this.mutexTail = this.mutexTail.then(() => resolve())
    })
    let resolveRelease: () => void
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    // Extend the tail: the NEXT caller's turn starts when we release
    this.mutexTail = releasePromise

    return {
      acquired,
      release: () => resolveRelease!()
    }
  }

  private async runInner(userMessage: string, timeoutMs: number): Promise<BackgroundCliRunResult> {
    this.resetIdleTimer()

    // Ensure process is alive
    if (!this.isAlive) {
      await this.spawnProcess()
    }

    if (!this.process?.stdin || !this.ndjsonIterator) {
      throw new Error('Background CLI session: process or iterator not available')
    }

    // Clear stale context from the previous call before sending the new message.
    // Sending /clear HERE (start of next run) instead of at the end of the
    // previous run avoids the stale-event poisoning problem: the /clear response
    // events are drained before the user message is sent.
    if (this.needsClear) {
      this.sendClear()
      await this.drainClearResponse()
      this.needsClear = false
    }

    // Write user message to stdin as NDJSON
    const msg = buildUserMessage(userMessage)
    const written = writeNdjsonMessage(this.process.stdin, msg)
    if (!written) {
      sessionLog.warn('[bg-cli] stdin backpressure on write — continuing anyway')
    }

    try {
      // Read NDJSON events until result
      const result = await readOneShotResult(this.ndjsonIterator, timeoutMs)

      // Mark that the next call needs to clear context first
      this.needsClear = true

      return result
    } catch (err) {
      // On any error (timeout, stream closed), kill the process
      // so the next call gets a fresh one
      sessionLog.warn(`[bg-cli] Error during run, killing process: ${(err as Error).message}`)
      this.killProcess()
      throw err
    }
  }

  private async spawnProcess(): Promise<void> {
    // Clean up any previous state
    this.killProcess()

    // Write system prompt to temp file
    this.systemPromptFile = this.writeSystemPromptFile(this.systemPrompt)

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--system-prompt-file', this.systemPromptFile,
      '--model', this.model,
      '--permission-mode', 'plan',
      '--verbose'
    ]

    sessionLog.info(`[bg-cli] Spawning warm process: claude ${args.join(' ')}`)

    const env = { ...process.env }

    try {
      if (this._spawner) {
        this.process = this._spawner(args, { stdio: ['pipe', 'pipe', 'pipe'], env })
      } else {
        this.process = spawn('claude', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          detached: false
        })
      }
    } catch (err) {
      this.process = null
      this.cleanupSystemPromptFile()
      throw new Error(`Failed to spawn background claude CLI: ${(err as Error).message}`)
    }

    this.alive = true

    // Wire exit handler
    this.process.on('exit', (code, signal) => {
      sessionLog.info(`[bg-cli] Process exited: code=${code}, signal=${signal}`)
      this.alive = false
      this.process = null
      this.ndjsonIterator = null
      this.cleanupSystemPromptFile()
    })

    // Wire stderr logging
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim()
        if (text) sessionLog.warn(`[bg-cli:stderr] ${text}`)
      })
    }

    // Create NDJSON iterator from stdout
    if (!this.process.stdout) {
      throw new Error('Background CLI session: no stdout stream')
    }

    this.ndjsonIterator = parseNdjsonStream(this.process.stdout, sessionLog)

    // Wait for the system/init event to confirm the session is ready
    await this.waitForInit()
  }

  /**
   * Wait for the `system` init event from the CLI.
   * The CLI emits a `{"type":"system","subtype":"init",...}` event when ready.
   */
  private async waitForInit(): Promise<void> {
    if (!this.ndjsonIterator) return

    const INIT_TIMEOUT_MS = 30_000 // 30s for initial spawn + bootstrap
    const deadline = Date.now() + INIT_TIMEOUT_MS

    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error('Background CLI session: init timeout (30s)')
      }

      const race = raceWithTimeout(
        this.ndjsonIterator.next(),
        remaining,
        'Background CLI session: init timeout (30s)'
      )

      let iterResult: IteratorResult<Record<string, unknown>>
      try {
        iterResult = await race.result
      } finally {
        race.cancel()
      }

      if (iterResult.done) {
        throw new Error('Background CLI session: stream ended during init')
      }

      const event = iterResult.value
      if (event.type === 'system' && event.subtype === 'init') {
        const sessionId = event.session_id ?? event.sessionId ?? 'unknown'
        sessionLog.info(`[bg-cli] Session initialized: ${sessionId}`)
        return
      }

      // Log and skip unexpected pre-init events
      sessionLog.info(`[bg-cli] Pre-init event: type=${event.type}`)
    }
  }

  /**
   * Send /clear as raw text to reset conversation context.
   * Slash commands must be sent as raw `"/clear\n"`, NOT wrapped in NDJSON —
   * the CLI auto-detects raw text vs NDJSON per-line when `--input-format stream-json`
   * is active. Wrapping in NDJSON would send "/clear" as a regular user prompt.
   */
  private sendClear(): void {
    if (!this.process?.stdin || !this.alive) return
    try {
      this.process.stdin.write('/clear\n')
    } catch {
      // Pipe may already be closed
    }
    sessionLog.info('[bg-cli] Sent /clear to reset context')
  }

  /**
   * Drain events emitted by `/clear` so they don't poison the next `readOneShotResult()`.
   * Reads until a `result` event is found or the timeout expires.
   */
  private async drainClearResponse(timeoutMs: number = 5000): Promise<void> {
    if (!this.ndjsonIterator) return
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        sessionLog.info('[bg-cli] Drain timeout — continuing')
        return
      }
      const race = raceWithTimeout(
        this.ndjsonIterator.next(),
        remaining,
        'drain timeout'
      )
      try {
        const iterResult = await race.result
        if (iterResult.done) return
        const event = iterResult.value
        if ((event.type as string) === 'result') {
          sessionLog.info('[bg-cli] Drained /clear result event')
          return
        }
        // Skip non-result events (assistant messages, content blocks, etc.)
      } catch {
        // Timeout — no more events pending, safe to continue
        return
      } finally {
        race.cancel()
      }
    }
  }

  private killProcess(): void {
    this.alive = false
    this.ndjsonIterator = null
    this.needsClear = false

    if (this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {
        // Process may have already exited
      }
      this.process = null
    }

    this.cleanupSystemPromptFile()
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      sessionLog.info('[bg-cli] Idle timeout reached — killing warm process')
      this.killProcess()
    }, IDLE_TIMEOUT_MS)
    // Don't keep Node alive just for the idle timer
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private writeSystemPromptFile(prompt: string): string {
    const dir = join(tmpdir(), 'agentstudio-bg-cli')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `system-prompt-${randomUUID()}.txt`)
    writeFileSync(filePath, prompt, 'utf-8')
    return filePath
  }

  private cleanupSystemPromptFile(): void {
    if (this.systemPromptFile) {
      try {
        unlinkSync(this.systemPromptFile)
      } catch {
        // File may have already been deleted
      }
      this.systemPromptFile = null
    }
  }
}

export const backgroundCliSession = new BackgroundCliSession()

import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import log from 'electron-log/main'
import { LLAMAFILE_EMBEDDING } from '../../shared/constants'
import { llamafileDownloadService } from './llamafile-download.service'
import { memoryCheckpoint } from './indexing-diagnostics'

/** Shape of an OpenAI-compatible /v1/embeddings response item. */
interface EmbeddingItem {
  index: number
  embedding: number[]
}

const MAX_RESTART_ATTEMPTS = 3

/**
 * Manages a downloaded **llamafile** server running in `--embedding` mode and
 * talks to it over its OpenAI-compatible `POST /v1/embeddings` endpoint.
 *
 * Drop-in replacement for the former WASM `EmbeddingProviderService`: same
 * public surface (`initialize` / `isReady` / `embed` / `dispose`) and the same
 * three events, so `vector-search.service.ts` and the embedding IPC layer
 * consume it unchanged.
 *
 * This is the **only** embedding backend (llamafile-only): if the binary/model
 * can't be downloaded or the server won't start, `initialize()` rejects and
 * semantic search surfaces the error rather than silently degrading.
 *
 * Events:
 * - `modelDownloadProgress` — `{ progress, loaded, total, phase }` (re-emitted from the download service)
 * - `modelReady`            — server spawned + healthy, ready for inference
 * - `modelError`            — `string` error message (download/spawn/health failure)
 */
class LlamafileEmbeddingManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private baseUrl: string | null = null
  private port = 0
  private initPromise: Promise<void> | null = null
  /** Set by the process 'error' handler so waitForHealth can fail fast (vs. polling out the full timeout). */
  private spawnError: Error | null = null
  private _isReady = false
  private disposing = false
  private restartAttempts = 0

  constructor() {
    super()
    // Bubble download progress (binary + model phases) to listeners/IPC.
    llamafileDownloadService.on('modelDownloadProgress', (p) => {
      this.emit('modelDownloadProgress', p)
    })
  }

  get isReady(): boolean {
    return this._isReady
  }

  /** Ensure artefacts are present and the embedding server is healthy. */
  async initialize(): Promise<void> {
    if (this._isReady) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit()
    return this.initPromise
  }

  private async _doInit(): Promise<void> {
    try {
      this.disposing = false
      memoryCheckpoint('LLAMAFILE_INIT_START')

      // 1. Download + verify engine binary and model (idempotent).
      await llamafileDownloadService.ensureInstalled()
      memoryCheckpoint('LLAMAFILE_ARTEFACTS_READY')

      // 2. Spawn the server on a free ephemeral port and wait for health.
      await this.startServer()

      this._isReady = true
      this.restartAttempts = 0
      memoryCheckpoint('LLAMAFILE_SERVER_READY', { port: this.port })
      this.emit('modelReady')
      log.info(`[LlamafileEmbedding] Server ready on ${this.baseUrl}`)
    } catch (error) {
      const message = (error as Error).message
      memoryCheckpoint('LLAMAFILE_INIT_FAILED', { error: message })
      log.error(`[LlamafileEmbedding] Init failed: ${message}`)
      this.killProc()
      this._isReady = false
      this.initPromise = null
      this.emit('modelError', message)
      throw error
    }
  }

  /** Spawn the llamafile server process and poll until it reports healthy. */
  private async startServer(): Promise<void> {
    const binaryPath = llamafileDownloadService.binaryPath
    const modelPath = llamafileDownloadService.modelPath
    const { host, pooling, embdNormalize, healthTimeoutSec } = LLAMAFILE_EMBEDDING.server

    this.port = await this.findFreePort()
    this.baseUrl = `http://${host}:${this.port}`

    const args = [
      '--server',
      '--embedding',
      '-m',
      modelPath,
      '--host',
      host,
      '--port',
      String(this.port),
      '--pooling',
      pooling,
      '--embd-normalize',
      embdNormalize
    ]

    log.info(`[LlamafileEmbedding] Spawning: ${binaryPath} ${args.join(' ')}`)
    this.spawnError = null
    // stdout is ignored (unused); only stderr is piped for diagnostic logs, so an
    // unconsumed stdout pipe can never stall the server.
    this.proc = spawn(binaryPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })

    this.proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) log.debug(`[llamafile] ${line}`)
    })

    this.proc.on('exit', (code, signal) => this.handleExit(code, signal))
    this.proc.on('error', (err) => {
      log.error('[LlamafileEmbedding] Process error:', err)
      // ENOENT/EACCES on a broken/missing binary: record so waitForHealth can
      // reject straight away instead of polling out the full timeout.
      this.spawnError = err
    })

    await this.waitForHealth(healthTimeoutSec)
  }

  /** Poll GET /health until the server responds 200, or time out. */
  private async waitForHealth(timeoutSec: number): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      if (this.spawnError) {
        throw new Error(`llamafile server failed to start: ${this.spawnError.message}`)
      }
      if (!this.proc || this.proc.exitCode !== null) {
        throw new Error('llamafile server exited before becoming healthy')
      }
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) return
      } catch {
        // Not up yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`llamafile server did not become healthy within ${timeoutSec}s`)
  }

  /**
   * Embed a batch of texts via POST /v1/embeddings.
   *
   * Mirrors the prior WASM safety net: if a batch fails and contains more than
   * one text, split it in half and retry each sub-batch independently before
   * giving up.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this._isReady || !this.baseUrl) {
      throw new Error('Llamafile embedding server not ready — call initialize() first')
    }
    if (texts.length === 0) return []

    // Defensively cap each input: llama.cpp /v1/embeddings ERRORS on input that
    // exceeds the model context, and batch-halving can't shrink a single chunk
    // below one. Truncating restores "never hard-fail on a big chunk" behavior.
    const { maxInputChars } = LLAMAFILE_EMBEDDING.server
    const input = texts.map((t) => (t.length > maxInputChars ? t.slice(0, maxInputChars) : t))

    try {
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, model: LLAMAFILE_EMBEDDING.model.modelName })
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`/v1/embeddings ${res.status} ${res.statusText} ${detail}`.trim())
      }
      const json = (await res.json()) as { data?: EmbeddingItem[] }
      const data = json.data ?? []
      // Order by `index` so output aligns with the input order regardless of
      // server-side reordering.
      const ordered = [...data].sort((a, b) => a.index - b.index)
      const result = ordered.map((d) => d.embedding)
      // Guard against a 200 with a short/empty `data` array: vector-search zips
      // ids[i] ↔ embeddings[i] by index, so a count mismatch (or a non-numeric
      // vector) would silently corrupt the index. Route it into the
      // batch-halving/error path instead.
      if (
        result.length !== texts.length ||
        result.some((e) => !Array.isArray(e) || e.length === 0 || typeof e[0] !== 'number')
      ) {
        throw new Error(
          `/v1/embeddings returned ${result.length} valid embeddings for ${texts.length} inputs`
        )
      }
      return result
    } catch (error) {
      if (texts.length > 1) {
        log.warn(
          `[LlamafileEmbedding] Embed failed for batch of ${texts.length} — splitting and retrying`
        )
        const mid = Math.ceil(texts.length / 2)
        const [first, second] = await Promise.all([
          this.embed(texts.slice(0, mid)),
          this.embed(texts.slice(mid))
        ])
        return [...first, ...second]
      }
      throw error
    }
  }

  /** Kill the server process. Safe to call multiple times. */
  dispose(): void {
    this.disposing = true
    this.killProc()
    this._isReady = false
    this.initPromise = null
    this.baseUrl = null
    log.info('[LlamafileEmbedding] Disposed')
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private killProc(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        // Already dead.
      }
      this.proc = null
    }
  }

  /** Handle an unexpected server exit — auto-restart with backoff if crashed. */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    log.info(`[LlamafileEmbedding] Server exited (code=${code}, signal=${signal})`)
    const wasReady = this._isReady
    this._isReady = false
    this.proc = null

    if (this.disposing) return
    if (!wasReady) return // a failed startup is handled by _doInit's reject path
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      const msg = `llamafile server crashed ${this.restartAttempts}× — giving up`
      log.error(`[LlamafileEmbedding] ${msg}`)
      this.emit('modelError', msg)
      return
    }

    this.restartAttempts++
    const backoffMs = 500 * 2 ** (this.restartAttempts - 1)
    log.warn(
      `[LlamafileEmbedding] Restarting server (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}) in ${backoffMs}ms`
    )
    this.initPromise = null
    setTimeout(() => {
      this.initialize().catch((err) => {
        log.error('[LlamafileEmbedding] Restart failed:', err)
      })
    }, backoffMs)
  }

  /** Ask the OS for a free ephemeral port to avoid clashing with oMLX (8000/8080). */
  private findFreePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.unref()
      srv.on('error', reject)
      srv.listen(0, LLAMAFILE_EMBEDDING.server.host, () => {
        const addr = srv.address()
        if (addr && typeof addr === 'object') {
          const { port } = addr
          srv.close(() => resolve(port))
        } else {
          srv.close(() => reject(new Error('Failed to resolve a free port')))
        }
      })
    })
  }
}

export const llamafileEmbeddingProvider = new LlamafileEmbeddingManager()

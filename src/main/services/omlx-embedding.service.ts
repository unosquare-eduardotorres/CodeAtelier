import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import { omlxManager } from './omlx-manager.service'
import { OMLX_EMBEDDING } from '../../shared/constants'

/** Shape of an OpenAI-compatible /v1/embeddings response item. */
interface EmbeddingItem {
  index: number
  embedding: number[]
}

/**
 * Embedding provider backed by the user's local **oMLX** server.
 *
 * oMLX exposes an OpenAI-compatible `POST /v1/embeddings` endpoint, so the
 * `embed()` method body is nearly identical to the old llamafile provider.
 * The key difference: oMLX is user-managed (no auto-download, no child
 * process). The user must have oMLX installed and running with a compatible
 * embedding model loaded.
 *
 * Same public surface as the old provider (`initialize` / `isReady` / `embed` /
 * `dispose`) and the same two events, so `vector-search.service.ts` and the
 * embedding IPC layer consume it unchanged.
 *
 * Events:
 * - `modelReady`  — oMLX is reachable + an embedding model is loaded
 * - `modelError`  — `string` error message (connection/model failure)
 */
class OmlxEmbeddingProvider extends EventEmitter {
  private _isReady = false
  private baseUrl = ''
  private modelName = ''
  private apiKey: string | undefined
  private initPromise: Promise<void> | null = null

  get isReady(): boolean {
    return this._isReady
  }

  /** The loaded embedding model's name — used as provenance for index invalidation. */
  get activeModelName(): string {
    return this.modelName
  }

  /** Ensure oMLX is running and an embedding model is loaded. */
  async initialize(baseUrl?: string, apiKey?: string): Promise<void> {
    if (this._isReady) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit(baseUrl, apiKey)
    return this.initPromise
  }

  private async _doInit(baseUrl?: string, apiKey?: string): Promise<void> {
    try {
      if (apiKey !== undefined) this.apiKey = apiKey
      const url = baseUrl ?? (this.baseUrl || 'http://127.0.0.1:8000')

      // 1. Check oMLX status (reuse existing omlxManager)
      const status = await omlxManager.checkStatus(url, apiKey)
      if (!status.running) {
        throw new Error('oMLX server is not running. Please start oMLX first.')
      }

      // 2. Find a loaded embedding model
      const embeddingModel = status.allModels?.find((m) => m.loaded && m.modelType === 'embedding')
      if (!embeddingModel) {
        throw new Error(
          'No embedding model loaded in oMLX. Please download and load an embedding model ' +
            `(recommended: ${OMLX_EMBEDDING.recommendedModel.id}) from the oMLX admin dashboard.`
        )
      }

      this.baseUrl = url
      this.modelName = embeddingModel.id
      this._isReady = true
      this.initPromise = null
      this.emit('modelReady')
      log.info(`[OmlxEmbedding] Ready — model: ${this.modelName} at ${this.baseUrl}`)
    } catch (error) {
      const message = (error as Error).message
      log.error(`[OmlxEmbedding] Init failed: ${message}`)
      this._isReady = false
      this.initPromise = null
      this.emit('modelError', message)
      throw error
    }
  }

  /**
   * Embed a batch of texts via POST /v1/embeddings.
   *
   * Mirrors the prior safety net: if a batch fails and contains more than
   * one text, split it in half and retry each sub-batch independently before
   * giving up.
   */
  async embed(texts: string[]): Promise<number[][]> {
    // Auto-reinitialize if connection was previously lost
    if (!this._isReady && this.baseUrl) {
      log.info('[OmlxEmbedding] Attempting automatic reconnection...')
      try {
        await this.initialize()
      } catch {
        // Will throw below from the !_isReady check
      }
    }

    if (!this._isReady || !this.baseUrl) {
      throw new Error('oMLX embedding not ready — call initialize() first')
    }
    if (texts.length === 0) return []

    // Defensively cap each input to avoid exceeding model context
    const { maxInputChars, requestTimeoutMs } = OMLX_EMBEDDING.server
    const input = texts.map((t) => (t.length > maxInputChars ? t.slice(0, maxInputChars) : t))

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    try {
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input, model: this.modelName }),
        signal: AbortSignal.timeout(requestTimeoutMs)
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
      // vector) would silently corrupt the index.
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
      // Batch-halving retry (same safety net as old provider)
      if (texts.length > 1) {
        log.warn(
          `[OmlxEmbedding] Embed failed for batch of ${texts.length} — splitting and retrying`
        )
        const mid = Math.ceil(texts.length / 2)
        const [first, second] = await Promise.all([
          this.embed(texts.slice(0, mid)),
          this.embed(texts.slice(mid))
        ])
        return [...first, ...second]
      }
      // Detect connection loss — mark not-ready so next call re-initializes
      const msg = (error as Error).message ?? ''
      if (
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('TimeoutError')
      ) {
        log.warn('[OmlxEmbedding] Connection lost — marking not ready for re-initialization')
        this._isReady = false
        this.initPromise = null
        this.emit('modelError', 'oMLX connection lost. Will attempt to reconnect on next use.')
      }
      throw error
    }
  }

  /**
   * Ensure embedding is ready — auto-loads the model if downloaded but not loaded,
   * auto-starts oMLX if installed but not running (macOS only).
   *
   * Called at app startup (delayed, non-fatal) and by the backfill handler.
   * Returns true if the provider is ready to embed.
   */
  async ensureEmbeddingReady(baseUrl?: string, apiKey?: string): Promise<boolean> {
    if (this._isReady) return true

    const url = baseUrl ?? (this.baseUrl || 'http://127.0.0.1:8000')
    if (apiKey !== undefined) this.apiKey = apiKey

    try {
      // 1. Check if oMLX is running
      let status = await omlxManager.checkStatus(url, this.apiKey)

      // 2. If not running, attempt auto-start (macOS)
      if (!status.running) {
        if (process.platform === 'darwin') {
          log.info('[OmlxEmbedding] oMLX not running — attempting auto-start…')
          const started = await omlxManager.startOmlx()
          if (!started) {
            log.info('[OmlxEmbedding] Auto-start failed or oMLX not installed')
            return false
          }
          // Re-check status after start
          status = await omlxManager.checkStatus(url, this.apiKey)
          if (!status.running) return false
        } else {
          return false
        }
      }

      // 3. Find an embedding model
      const embeddingModel = status.allModels?.find((m) => m.modelType === 'embedding')
      if (!embeddingModel) {
        // No embedding model downloaded at all
        return false
      }

      // 4. If downloaded but not loaded, auto-load it
      if (!embeddingModel.loaded) {
        log.info(`[OmlxEmbedding] Model ${embeddingModel.id} downloaded but not loaded — loading…`)
        try {
          await omlxManager.loadModel(embeddingModel.id, url, this.apiKey)
        } catch (loadErr) {
          log.warn(`[OmlxEmbedding] Auto-load failed: ${(loadErr as Error).message}`)
          return false
        }
      }

      // 5. Initialize the provider
      await this.initialize(url, this.apiKey)
      return true
    } catch (err) {
      log.info(`[OmlxEmbedding] ensureEmbeddingReady failed: ${(err as Error).message}`)
      return false
    }
  }

  /** Force a re-check of oMLX status — use after user restarts oMLX. */
  async reinitialize(): Promise<void> {
    this._isReady = false
    this.initPromise = null
    await this.initialize(this.baseUrl || undefined, this.apiKey)
  }

  /** Reset state. No child process to kill — oMLX is user-managed. */
  dispose(): void {
    this._isReady = false
    this.initPromise = null
    this.baseUrl = ''
    this.modelName = ''
    this.apiKey = undefined
    log.info('[OmlxEmbedding] Disposed')
  }
}

export const omlxEmbeddingProvider = new OmlxEmbeddingProvider()

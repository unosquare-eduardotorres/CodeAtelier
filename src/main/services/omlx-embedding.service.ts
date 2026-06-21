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
      const embeddingModel = status.allModels?.find(
        (m) => m.loaded && m.modelType === 'embedding'
      )
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
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('TimeoutError')) {
        log.warn('[OmlxEmbedding] Connection lost — marking not ready for re-initialization')
        this._isReady = false
        this.initPromise = null
        this.emit('modelError', 'oMLX connection lost. Will attempt to reconnect on next use.')
      }
      throw error
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

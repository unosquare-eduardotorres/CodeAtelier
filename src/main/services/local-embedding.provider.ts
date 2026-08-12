/**
 * LocalEmbeddingProvider — facade that routes embedding operations to the
 * active local backend (oMLX or Ollama).
 *
 * Same public surface as OmlxEmbeddingProvider:
 *   `isReady`, `activeModelName`, `initialize()`, `embed()`, `dispose()`,
 *   `ensureEmbeddingReady()`, `reinitialize()`, `configureForWorkspace()`
 *   Events: `modelReady`, `modelError`
 *
 * NOTE: This is a global singleton.  If two workspaces use different
 * backends, the last-configured workspace wins.  This mirrors the
 * existing oMLX baseUrl behavior and is acceptable for single-active-
 * workspace usage.
 *
 * The backend is configured per-workspace via `settings.localLlmBackend`
 * ('omlx' | 'ollama'). When oMLX, delegates everything to the existing
 * omlxEmbeddingProvider singleton. When Ollama, uses ollamaManager.embed()
 * with a user-selected embedding model.
 *
 * Windows support: Ollama is the only embedding backend available on Windows
 * (oMLX requires Apple Silicon). This facade makes the switch transparent to
 * consumers (vector-search, memory-retrieval).
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import { omlxEmbeddingProvider } from './omlx-embedding.service'
import { ollamaManager } from './ollama-manager.service'
import { workspaceRepository } from '../db/repositories'
import { OLLAMA_DEFAULT_PORT } from '../../shared/constants'
import type { LocalLLMBackend } from '../../shared/types'

const embLog = log.scope('LocalEmbedding')

class LocalEmbeddingProvider extends EventEmitter {
  private backend: LocalLLMBackend = 'omlx'
  private ollamaModel = ''
  private ollamaBaseUrl = 'http://127.0.0.1:11434'
  private _ollamaReady = false

  constructor() {
    super()
    // Forward oMLX-side events through the facade so consumers (embedding.ipc,
    // memory-engine) that listen on localEmbeddingProvider hear them regardless
    // of which backend is active.  Gated on `this.backend` to prevent
    // cross-backend noise (e.g. oMLX init noise while Ollama is selected).
    omlxEmbeddingProvider.on('modelReady', () => {
      if (this.backend === 'omlx') this.emit('modelReady')
    })
    omlxEmbeddingProvider.on('modelError', (e: string) => {
      if (this.backend === 'omlx') this.emit('modelError', e)
    })
  }

  // ── Getters ──

  get isReady(): boolean {
    return this.backend === 'omlx' ? omlxEmbeddingProvider.isReady : this._ollamaReady
  }

  get activeModelName(): string {
    return this.backend === 'omlx' ? omlxEmbeddingProvider.activeModelName : this.ollamaModel
  }

  // ── Configuration ──

  /**
   * Switch the active embedding backend. Called when workspace settings change.
   * Does NOT auto-initialize — callers should follow with `initialize()`.
   */
  setBackend(backend: LocalLLMBackend): void {
    if (backend === this.backend) return
    embLog.info(`[setBackend] Switching embedding backend: ${this.backend} → ${backend}`)
    this.backend = backend
  }

  /**
   * Set the Ollama embedding model name (e.g. 'bge-m3', 'nomic-embed-text').
   */
  setOllamaEmbeddingModel(model: string): void {
    if (model && model !== this.ollamaModel) {
      embLog.info(
        `[setOllamaModel] Embedding model changed: ${this.ollamaModel || '(none)'} → ${model}`
      )
      this.ollamaModel = model
      // Mark not-ready so next call triggers re-initialization
      this._ollamaReady = false
    }
  }

  /**
   * Set the Ollama base URL (defaults to http://127.0.0.1:11434).
   */
  setOllamaBaseUrl(baseUrl: string): void {
    this.ollamaBaseUrl = baseUrl || 'http://127.0.0.1:11434'
  }

  /**
   * Read workspace settings and configure backend + Ollama model/URL.
   * Called before embedding operations to align the facade with the
   * active workspace's persisted preferences.  The facade is a global
   * singleton, so the last-configured workspace wins — this mirrors
   * the existing oMLX baseUrl pattern and is acceptable for single-
   * active-workspace usage.
   */
  configureForWorkspace(workspaceId: string): void {
    try {
      const settings = workspaceRepository.getSettings(workspaceId)
      const backend = (settings?.localLlmBackend as LocalLLMBackend) ?? 'omlx'
      this.setBackend(backend)

      if (backend === 'ollama') {
        const host = (settings?.localHost as string) ?? '127.0.0.1'
        const port = (settings?.localPort as number) ?? OLLAMA_DEFAULT_PORT
        this.setOllamaBaseUrl(`http://${host}:${port}`)
        const embModel = (settings?.ollamaEmbeddingModel as string) ?? ''
        if (embModel) this.setOllamaEmbeddingModel(embModel)
      }
    } catch (err) {
      embLog.warn('[configureForWorkspace] Failed to read workspace settings:', err)
    }
  }

  // ── Core interface (matches OmlxEmbeddingProvider) ──

  async initialize(baseUrl?: string, apiKey?: string): Promise<void> {
    if (this.backend === 'omlx') {
      return omlxEmbeddingProvider.initialize(baseUrl, apiKey)
    }
    // Ollama: apply baseUrl if provided (EMBEDDING_INITIALIZE passes the
    // workspace-resolved URL), then verify server + model availability.
    if (baseUrl) this.setOllamaBaseUrl(baseUrl)
    await this._initOllama()
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.backend === 'omlx') {
      return omlxEmbeddingProvider.embed(texts)
    }
    return this._embedOllama(texts)
  }

  async ensureEmbeddingReady(baseUrl?: string, apiKey?: string): Promise<boolean> {
    if (this.backend === 'omlx') {
      return omlxEmbeddingProvider.ensureEmbeddingReady(baseUrl, apiKey)
    }
    try {
      await this._initOllama()
      return this._ollamaReady
    } catch {
      return false
    }
  }

  async reinitialize(): Promise<void> {
    if (this.backend === 'omlx') {
      return omlxEmbeddingProvider.reinitialize()
    }
    this._ollamaReady = false
    await this._initOllama()
  }

  dispose(): void {
    // Always dispose oMLX state (prevents leak when switching away from oMLX)
    omlxEmbeddingProvider.dispose()
    this._ollamaReady = false
    this.ollamaModel = ''
  }

  // ── Ollama internals ──

  private async _initOllama(): Promise<void> {
    if (this._ollamaReady) return

    if (!this.ollamaModel) {
      const msg =
        'No Ollama embedding model configured. Select one in Model Configuration → Local Models.'
      embLog.warn(`[initOllama] ${msg}`)
      this.emit('modelError', msg)
      throw new Error(msg)
    }

    try {
      const status = await ollamaManager.checkStatus(this.ollamaBaseUrl)
      if (!status.running) {
        const msg = 'Ollama is not running. Start Ollama to enable embeddings.'
        embLog.warn(`[initOllama] ${msg}`)
        this.emit('modelError', msg)
        throw new Error(msg)
      }

      // Check if model is available
      const modelAvailable = status.models.some(
        (m) => m === this.ollamaModel || m.startsWith(`${this.ollamaModel}:`)
      )
      if (!modelAvailable) {
        const msg = `Embedding model '${this.ollamaModel}' not found in Ollama. Pull it with: ollama pull ${this.ollamaModel}`
        embLog.warn(`[initOllama] ${msg}`)
        this.emit('modelError', msg)
        throw new Error(msg)
      }

      // Test a small embed to confirm the model works
      await ollamaManager.embed(this.ollamaModel, ['test'], this.ollamaBaseUrl)

      this._ollamaReady = true
      embLog.info(`[initOllama] Ollama embedding ready: model=${this.ollamaModel}`)
      this.emit('modelReady')
    } catch (err) {
      this._ollamaReady = false
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('not running') && !msg.includes('not found')) {
        embLog.error(`[initOllama] Initialization failed: ${msg}`)
        this.emit('modelError', msg)
      }
      throw err
    }
  }

  private async _embedOllama(texts: string[]): Promise<number[][]> {
    if (!this._ollamaReady) {
      await this._initOllama()
    }

    try {
      return await ollamaManager.embed(this.ollamaModel, texts, this.ollamaBaseUrl)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Detect connection loss
      if (
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('TimeoutError')
      ) {
        this._ollamaReady = false
        this.emit('modelError', 'Ollama connection lost. Will attempt to reconnect on next use.')
      }
      throw err
    }
  }
}

/** Singleton facade — import this instead of omlxEmbeddingProvider directly. */
export const localEmbeddingProvider = new LocalEmbeddingProvider()

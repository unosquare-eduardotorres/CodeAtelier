/**
 * Embedding Worker Manager
 *
 * Manages an Electron utilityProcess that runs the WASM embedding model
 * off the main thread. Provides the same embed() interface as
 * EmbeddingProviderService but delegates work to the isolated process.
 *
 * Architecture (Option C — Hybrid):
 *   - Utility Process: runs WASM inference (CPU-intensive, 99% CPU)
 *   - Main Process: handles SQLite writes + coordinates the pipeline
 *   - Message overhead: ~48KB per batch (32 × 384-dim × 4 bytes) — negligible
 *
 * Usage:
 *   const mgr = new EmbeddingWorkerManager()
 *   await mgr.initialize(cacheDir)
 *   const embeddings = await mgr.embed(['hello world', 'foo bar'])
 *   mgr.dispose()
 */

import { utilityProcess } from 'electron'
import { app } from 'electron'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import log from 'electron-log/main'

// ── Worker message types (must match embedding-worker.ts protocol) ────────

interface EmbedResultMessage {
  type: 'embed-result'
  batchId: number
  embeddings: number[][]
}

interface EmbedErrorMessage {
  type: 'embed-error'
  batchId: number
  error: string
}

interface InitCompleteMessage {
  type: 'init-complete'
}

interface InitProgressMessage {
  type: 'init-progress'
  progress: { progress: number; loaded: number; total: number }
}

interface InitErrorMessage {
  type: 'init-error'
  error: string
}

interface DisposedMessage {
  type: 'disposed'
}

type WorkerResponse =
  | EmbedResultMessage
  | EmbedErrorMessage
  | InitCompleteMessage
  | InitProgressMessage
  | InitErrorMessage
  | DisposedMessage

// ── Pending request tracking ──────────────────────────────────────────────

interface PendingEmbed {
  resolve: (embeddings: number[][]) => void
  reject: (error: Error) => void
}

/**
 * Manages an Electron utility process for off-thread embedding.
 *
 * Events:
 * - 'modelDownloadProgress' — download progress during first-time model fetch
 * - 'modelReady'            — worker initialized, ready for embed calls
 * - 'modelError'            — worker init failed
 * - 'workerExit'            — worker process exited (code, signal)
 */
export class EmbeddingWorkerManager extends EventEmitter {
  private worker: Electron.UtilityProcess | null = null
  private initPromise: Promise<void> | null = null
  private _isReady = false
  private nextBatchId = 0
  private pendingEmbeds = new Map<number, PendingEmbed>()

  get isReady(): boolean {
    return this._isReady
  }

  /**
   * Initialize the worker process and load the embedding model.
   * Safe to call multiple times — returns the same promise on re-entry.
   */
  async initialize(cacheDir?: string): Promise<void> {
    if (this._isReady) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInit(cacheDir)
    return this.initPromise
  }

  private async _doInit(cacheDir?: string): Promise<void> {
    const resolvedCacheDir = cacheDir ?? path.join(app.getPath('userData'), 'models')

    return new Promise<void>((resolve, reject) => {
      try {
        // Resolve the worker entry point path.
        // electron-vite bundles the main process to out/main/index.js;
        // the worker is bundled alongside as out/main/embedding-worker.js.
        const workerPath = path.join(__dirname, 'embedding-worker.js')

        log.info(`[EmbeddingWorkerManager] Forking utility process: ${workerPath}`)

        this.worker = utilityProcess.fork(workerPath, [], {
          serviceName: 'embedding-worker'
        })

        // Set up message handling
        this.worker.on('message', (msg: WorkerResponse) => {
          this.handleMessage(msg, resolve, reject)
        })

        this.worker.on('exit', (code) => {
          log.info(`[EmbeddingWorkerManager] Worker exited with code ${code}`)
          this._isReady = false
          this.initPromise = null
          this.emit('workerExit', code)

          // Reject all pending embeds
          for (const [, pending] of this.pendingEmbeds) {
            pending.reject(new Error(`Worker exited with code ${code}`))
          }
          this.pendingEmbeds.clear()
          this.worker = null
        })

        // Send init message
        this.worker.postMessage({
          type: 'init',
          cacheDir: resolvedCacheDir
        })
      } catch (error) {
        this.initPromise = null
        reject(error)
      }
    })
  }

  private handleMessage(
    msg: WorkerResponse,
    initResolve?: (value: void) => void,
    initReject?: (reason: Error) => void
  ): void {
    switch (msg.type) {
      case 'init-complete':
        this._isReady = true
        log.info('[EmbeddingWorkerManager] Worker initialized — model ready')
        this.emit('modelReady')
        initResolve?.()
        break

      case 'init-progress':
        this.emit('modelDownloadProgress', msg.progress)
        break

      case 'init-error':
        log.error(`[EmbeddingWorkerManager] Worker init failed: ${msg.error}`)
        this._isReady = false
        this.initPromise = null
        this.emit('modelError', msg.error)
        initReject?.(new Error(msg.error))
        break

      case 'embed-result': {
        const pending = this.pendingEmbeds.get(msg.batchId)
        if (pending) {
          this.pendingEmbeds.delete(msg.batchId)
          pending.resolve(msg.embeddings)
        }
        break
      }

      case 'embed-error': {
        const pendingErr = this.pendingEmbeds.get(msg.batchId)
        if (pendingErr) {
          this.pendingEmbeds.delete(msg.batchId)
          pendingErr.reject(new Error(msg.error))
        }
        break
      }

      case 'disposed':
        log.info('[EmbeddingWorkerManager] Worker disposed')
        break
    }
  }

  /**
   * Embed a batch of texts using the worker process.
   * Returns embeddings as number[][] (same interface as EmbeddingProviderService).
   *
   * @throws if the worker is not initialized or the embed fails
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.worker || !this._isReady) {
      throw new Error('Embedding worker not initialized — call initialize() first')
    }

    const batchId = this.nextBatchId++

    return new Promise<number[][]>((resolve, reject) => {
      this.pendingEmbeds.set(batchId, { resolve, reject })

      this.worker!.postMessage({
        type: 'embed',
        batchId,
        texts
      })
    })
  }

  /**
   * Dispose the worker process. Sends a dispose message and kills the process.
   */
  dispose(): void {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'dispose' })
        // Give the worker 2 seconds to clean up, then force kill
        setTimeout(() => {
          if (this.worker) {
            this.worker.kill()
            this.worker = null
          }
        }, 2000)
      } catch {
        // Worker may already be dead
        this.worker = null
      }
    }
    this._isReady = false
    this.initPromise = null
    this.pendingEmbeds.clear()
    log.info('[EmbeddingWorkerManager] Disposed')
  }
}

/** Singleton instance used by VectorSearchService */
export const embeddingWorkerManager = new EmbeddingWorkerManager()

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { memoryCheckpoint } from './indexing-diagnostics'

// ── Lazy-loaded Transformers.js (ESM-only) ────────────────────────────────
// @huggingface/transformers is ESM — use dynamic import() so our CJS main
// process can consume it without top-level-import issues.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any

/** Model config */
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2' as const
const MODEL_REVISION = 'main' as const

/**
 * Singleton service wrapping Transformers.js for local embedding generation.
 *
 * Replaces Ollama for the semantic-search embedding pipeline.
 * Runs ONNX models via **onnxruntime-web (WASM)** in the Electron main
 * process. Uses Xenova/all-MiniLM-L6-v2 (22MB q8, 384-dim, 6 layers)
 * — proven WASM-compatible. The larger nomic-embed-text-v1.5 (131MB)
 * overflows the asyncify stack in WASM mode.
 * No external server, no native addon issues, fully cross-platform.
 *
 * The native `onnxruntime-node` backend crashes in Electron on every execution
 * provider (CPU, CoreML, DirectML) because BFCArena::Extend → operator new
 * fails on the first inference call. We bypass it via `patch-package`, which
 * swaps `ONNX_NODE → ort_webgpu_bundle_min_exports` and sets
 * `defaultDevices = ['wasm']` in the dist bundles at install time.
 *
 * Events:
 * - `modelDownloadProgress` — `{ progress: number, loaded: number, total: number }`
 * - `modelReady`            — model loaded, ready for inference
 * - `modelError`            — `string` error message
 */
class EmbeddingProviderService extends EventEmitter {
  private embedder: FeatureExtractionPipeline | null = null
  private initPromise: Promise<void> | null = null
  private _isReady = false
  private _cacheDir: string | null = null

  constructor() {
    super()
  }

  /** Lazily resolve cache directory — deferred so the module can be imported outside Electron */
  private get cacheDir(): string {
    if (!this._cacheDir) {
      this._cacheDir = path.join(app.getPath('userData'), 'models')
    }
    return this._cacheDir
  }

  get isReady(): boolean {
    return this._isReady
  }

  /** Check if the model files are already cached locally */
  async isModelCached(): Promise<boolean> {
    const modelDir = path.join(this.cacheDir, 'Xenova', 'all-MiniLM-L6-v2')
    return existsSync(modelDir)
  }

  /** Initialize the embedding pipeline (downloads model on first run) */
  async initialize(model?: string): Promise<void> {
    if (this._isReady) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInit(model ?? DEFAULT_MODEL)
    return this.initPromise
  }

  private async _doInit(model: string): Promise<void> {
    try {
      log.info(`[EmbeddingProvider] Initializing model: ${model}`)
      memoryCheckpoint('WASM_IMPORT_START')

      const { pipeline, env } = await import('@huggingface/transformers')

      memoryCheckpoint('WASM_IMPORT_DONE')

      // ── WASM environment for Electron's Node.js runtime ──────────────
      // onnxruntime-web is the active backend (dist patch swaps ONNX_NODE
      // → ort_webgpu_bundle_min_exports). Three Node.js incompatibilities
      // must be worked around:
      //  1. Cannot import() from blob: URLs (multi-threaded worker loading)
      //  2. Cannot import() from https: URLs (CDN wasmPaths auto-set by transformers.js)
      //  3. Cannot fetch() file: URLs (WASM binary resolution)
      // Fix: single-thread + pre-load WASM binary from disk + clear CDN paths.
      env.cacheDir = this.cacheDir
      env.backends.onnx.wasm!.numThreads = 1

      // Pre-load the WASM binary from disk so Emscripten receives it directly
      // (bypasses CDN fetch and file-resolution issues).
      // require.resolve('onnxruntime-web') → dist/ort.node.min.js via exports map;
      // the WASM binary is in the same dist/ directory.
      const ortDist = path.dirname(require.resolve('onnxruntime-web'))
      const wasmBinPath = path.join(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm')
      if (existsSync(wasmBinPath)) {
        const wasmBuffer = readFileSync(wasmBinPath)
        ;(env.backends.onnx.wasm as Record<string, unknown>).wasmBinary = wasmBuffer
        log.info(
          `[EmbeddingProvider] Pre-loaded WASM binary (${(wasmBuffer.byteLength / 1024 / 1024).toFixed(1)}MB)`
        )
      } else {
        log.warn(
          `[EmbeddingProvider] WASM binary not found at ${wasmBinPath} — falling back to runtime resolution`
        )
      }

      // Clear CDN-based wasmPaths that transformers.js auto-sets during module load
      // (jsdelivr URLs that fail in Node.js — no https: import support).
      delete (env.backends.onnx.wasm as Record<string, unknown>).wasmPaths

      memoryCheckpoint('WASM_PIPELINE_START', { model, dtype: 'q8', threads: 1, backend: 'wasm' })

      this.embedder = (await pipeline('feature-extraction', model, {
        revision: MODEL_REVISION,
        dtype: 'q8' as never, // quantized ONNX for smaller download
        progress_callback: (progress: {
          status: string
          progress?: number
          loaded?: number
          total?: number
        }) => {
          if (progress.status === 'progress' && progress.progress !== undefined) {
            this.emit('modelDownloadProgress', {
              progress: progress.progress,
              loaded: progress.loaded ?? 0,
              total: progress.total ?? 0
            })
          }
        }
      })) as FeatureExtractionPipeline

      memoryCheckpoint('WASM_PIPELINE_READY')
      this._isReady = true
      this.emit('modelReady')
      log.info(`[EmbeddingProvider] Model ready: ${model}`)
    } catch (error) {
      const message = (error as Error).message
      memoryCheckpoint('WASM_INIT_FAILED', { error: message })
      log.error(`[EmbeddingProvider] Init failed: ${message}`)
      this.emit('modelError', message)
      this.initPromise = null
      throw error
    }
  }

  /**
   * Generate embeddings for a batch of texts.
   *
   * Uses adaptive batch splitting: if a batch causes an OOM / allocation
   * failure in the native ONNX Runtime, the batch is halved and retried
   * recursively down to single-text inference before giving up.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedder) {
      throw new Error('Embedding model not initialized — call initialize() first')
    }

    try {
      const results = await this.embedder(texts, {
        pooling: 'mean',
        normalize: true
      })
      return results.tolist() as number[][]
    } catch (error) {
      const msg = (error as Error).message ?? ''
      const isOom =
        msg.includes('allocat') ||
        msg.includes('bad_alloc') ||
        msg.includes('memory') ||
        msg.includes('OOM') ||
        msg.includes('BFCArena')

      // If batch size > 1 and the error looks like an allocation failure,
      // split the batch in half and retry each sub-batch independently.
      if (texts.length > 1 && isOom) {
        log.warn(
          `[EmbeddingProvider] Inference failed for batch of ${texts.length} — splitting in half and retrying`
        )
        memoryCheckpoint('EMBED_OOM_RETRY', {
          batchSize: texts.length,
          error: msg.slice(0, 120)
        })

        const mid = Math.ceil(texts.length / 2)
        const [firstHalf, secondHalf] = await Promise.all([
          this.embed(texts.slice(0, mid)),
          this.embed(texts.slice(mid))
        ])
        return [...firstHalf, ...secondHalf]
      }

      // Single text or non-OOM error — re-throw
      throw error
    }
  }

  /** Dispose the model (free WASM memory) */
  async dispose(): Promise<void> {
    this.embedder = null
    this._isReady = false
    this.initPromise = null
    log.info('[EmbeddingProvider] Disposed')
  }
}

export const embeddingProvider = new EmbeddingProviderService()

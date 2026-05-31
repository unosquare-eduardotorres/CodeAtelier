/**
 * Embedding Worker — Electron utilityProcess entry point.
 *
 * Runs the WASM embedding model (@huggingface/transformers + onnxruntime-web)
 * in an isolated V8 process so the heavy WASM inference (99% CPU) does NOT
 * block the main process event loop. UI stays responsive during indexing.
 *
 * Communication protocol:
 *   Main → Worker:
 *     { type: 'init' }                          — initialize the embedding model
 *     { type: 'embed', batchId, texts }          — embed a batch of texts
 *     { type: 'dispose' }                        — cleanup and prepare for exit
 *
 *   Worker → Main:
 *     { type: 'init-complete' }                  — model ready
 *     { type: 'init-progress', progress }        — model download progress
 *     { type: 'init-error', error }              — model init failed
 *     { type: 'embed-result', batchId, embeddings } — embedding results
 *     { type: 'embed-error', batchId, error }    — embedding batch failed
 *     { type: 'disposed' }                       — cleanup complete
 *
 * The embeddings are transferred as Float32Array views for efficient
 * serialization across the process boundary (~1.5KB per 384-dim vector).
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// ── Types ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any

interface InitMessage {
  type: 'init'
  cacheDir: string
  model?: string
}

interface EmbedMessage {
  type: 'embed'
  batchId: number
  texts: string[]
}

interface DisposeMessage {
  type: 'dispose'
}

type WorkerMessage = InitMessage | EmbedMessage | DisposeMessage

// ── State ──────────────────────────────────────────────────────────────────

let embedder: FeatureExtractionPipeline | null = null
let isInitializing = false

// ── Message handler ────────────────────────────────────────────────────────

process.parentPort.on('message', async (e: Electron.MessageEvent) => {
  const msg = e.data as WorkerMessage

  switch (msg.type) {
    case 'init':
      await handleInit(msg)
      break
    case 'embed':
      await handleEmbed(msg)
      break
    case 'dispose':
      handleDispose()
      break
  }
})

// ── Init handler ───────────────────────────────────────────────────────────

async function handleInit(msg: InitMessage): Promise<void> {
  if (embedder || isInitializing) {
    process.parentPort.postMessage({ type: 'init-complete' })
    return
  }

  isInitializing = true
  const model = msg.model ?? 'Xenova/all-MiniLM-L6-v2'

  try {
    const { pipeline, env } = await import('@huggingface/transformers')

    // ── WASM environment for Node.js runtime ──
    // Same setup as EmbeddingProviderService but in the utility process
    env.cacheDir = msg.cacheDir
    env.backends.onnx.wasm!.numThreads = 1

    // Pre-load the WASM binary from disk
    const ortDist = path.dirname(require.resolve('onnxruntime-web'))
    const wasmBinPath = path.join(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm')
    if (existsSync(wasmBinPath)) {
      const wasmBuffer = readFileSync(wasmBinPath)
      ;(env.backends.onnx.wasm as Record<string, unknown>).wasmBinary = wasmBuffer
    }

    // Clear CDN-based wasmPaths
    delete (env.backends.onnx.wasm as Record<string, unknown>).wasmPaths

    embedder = (await pipeline('feature-extraction', model, {
      revision: 'main',
      dtype: 'q8' as never,
      progress_callback: (progress: {
        status: string
        progress?: number
        loaded?: number
        total?: number
      }) => {
        if (progress.status === 'progress' && progress.progress !== undefined) {
          process.parentPort.postMessage({
            type: 'init-progress',
            progress: {
              progress: progress.progress,
              loaded: progress.loaded ?? 0,
              total: progress.total ?? 0
            }
          })
        }
      }
    })) as FeatureExtractionPipeline

    isInitializing = false
    process.parentPort.postMessage({ type: 'init-complete' })
  } catch (error) {
    isInitializing = false
    process.parentPort.postMessage({
      type: 'init-error',
      error: (error as Error).message
    })
  }
}

// ── Embed handler ──────────────────────────────────────────────────────────

async function handleEmbed(msg: EmbedMessage): Promise<void> {
  if (!embedder) {
    process.parentPort.postMessage({
      type: 'embed-error',
      batchId: msg.batchId,
      error: 'Embedding model not initialized'
    })
    return
  }

  try {
    const embeddings = await embedWithRetry(msg.texts)

    // Convert number[][] to a flat structure for efficient transfer
    // Each embedding is 384 floats → 1,536 bytes
    const result: number[][] = embeddings

    process.parentPort.postMessage({
      type: 'embed-result',
      batchId: msg.batchId,
      embeddings: result
    })
  } catch (error) {
    process.parentPort.postMessage({
      type: 'embed-error',
      batchId: msg.batchId,
      error: (error as Error).message
    })
  }
}

/**
 * Embed with adaptive batch splitting on OOM — mirrors EmbeddingProviderService.embed().
 */
async function embedWithRetry(texts: string[]): Promise<number[][]> {
  try {
    const results = await embedder(texts, {
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

    if (texts.length > 1 && isOom) {
      const mid = Math.ceil(texts.length / 2)
      const [firstHalf, secondHalf] = await Promise.all([
        embedWithRetry(texts.slice(0, mid)),
        embedWithRetry(texts.slice(mid))
      ])
      return [...firstHalf, ...secondHalf]
    }

    throw error
  }
}

// ── Dispose handler ────────────────────────────────────────────────────────

function handleDispose(): void {
  embedder = null
  process.parentPort.postMessage({ type: 'disposed' })
}

import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import { memoryCheckpoint } from './indexing-diagnostics'
import { omlxEmbeddingProvider } from './omlx-embedding.service'
import { descriptionCache } from './description-cache.service'
import { generateHeuristicDescription } from './heuristic-description.service'
import {
  runPreprocessingPipeline,
  DEFAULT_PREPROCESSING_OPTIONS,
  type RawChunk,
  type ProcessedChunk,
  type PreprocessingOptions
} from './preprocessing.service'
import { codeChunkRepository } from '../db/repositories/code-chunk.repository'
import {
  chunkEmbeddingRepository,
  type EmbeddingEntry
} from '../db/repositories/chunk-embedding.repository'
import { getDatabase } from '../db/index'
import { OMLX_EMBEDDING } from '../../shared/constants'
import type { IndexingState, SemanticSearchResult } from '../../shared/types'

/**
 * Embedding model name — stored in indexing_state for provenance. Changing this
 * value invalidates persisted embeddings (see loadPersistedIndex) and triggers
 * a full re-index, which transparently handles the vector-dimension change.
 *
 * Returns null when the provider isn't initialized yet — callers
 * that need provenance MUST ensure the provider is ready first.
 */
function getEmbeddingModelName(): string | null {
  return omlxEmbeddingProvider.activeModelName || null
}

/**
 * Max batch size for embedding calls.
 *
 * Texts are POSTed to the oMLX server's /v1/embeddings endpoint in batches
 * of 32. The adaptive retry in embed() halves the batch on error as a safety
 * net for oversized requests.
 */
const EMBEDDING_BATCH_SIZE = 32

/**
 * Checkpoint interval: persist embeddings + chunks to SQLite every N batches.
 * At batch size 32, 50 batches = 1,600 chunks ≈ every ~5 minutes of embedding.
 * Crash recovery restarts from the last checkpoint instead of from zero.
 */
const CHECKPOINT_INTERVAL_BATCHES = 50

/**
 * In-memory vector store entry.
 * Runtime cosine similarity search stays in RAM for speed.
 */
interface VectorEntry {
  id: string
  embedding: number[]
  chunk: ProcessedChunk
}

/**
 * Simple in-memory vector collection.
 * Loaded from SQLite on startup, kept in RAM for fast queries.
 */
export class InMemoryCollection {
  private entries: VectorEntry[] = []

  upsert(ids: string[], embeddings: number[][], chunks: ProcessedChunk[]): void {
    for (let i = 0; i < ids.length; i++) {
      const existing = this.entries.findIndex((e) => e.id === ids[i])
      const entry: VectorEntry = {
        id: ids[i],
        embedding: embeddings[i],
        chunk: chunks[i]
      }
      if (existing >= 0) {
        this.entries[existing] = entry
      } else {
        this.entries.push(entry)
      }
    }
  }

  query(
    queryEmbedding: number[],
    nResults: number,
    where?: Record<string, unknown>
  ): SemanticSearchResult[] {
    // Compute cosine similarity for all entries
    let candidates = this.entries

    // Apply metadata filters
    if (where) {
      candidates = candidates.filter((entry) => {
        const meta = entry.chunk.metadata
        for (const [key, value] of Object.entries(where)) {
          const metaValue = meta[key as keyof typeof meta]
          if (metaValue !== value) return false
        }
        return true
      })
    }

    const scored = candidates.map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding)
    }))

    // Sort by similarity descending
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, nResults).map((s) => ({
      filePath: s.entry.chunk.metadata.filePath,
      symbolName: s.entry.chunk.metadata.symbolName,
      body: s.entry.chunk.body,
      score: s.score,
      metadata: s.entry.chunk.metadata as unknown as Record<string, unknown>
    }))
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }

  /**
   * Get all entries (for persistence).
   */
  getEntries(): VectorEntry[] {
    return this.entries
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

/**
 * Format milliseconds into a human-readable ETA string.
 * Examples: "~2 min", "~45 min", "~1.5 hrs"
 */
function formatEta(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return '< 1 min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes} min`
  const hours = (minutes / 60).toFixed(1)
  return `~${hours} hrs`
}

/**
 * Service for semantic vector search over indexed codebases.
 * Manages per-workspace vector collections, indexing pipeline, and search.
 *
 * Persistence: After indexing, chunks + embeddings are saved to SQLite.
 * On workspace open, the persisted index is loaded from SQLite into RAM.
 *
 * Events:
 * - 'progress': IndexingState — progress updates during indexing
 */
class VectorSearchService extends EventEmitter {
  private collections = new Map<string, InMemoryCollection>()
  private indexingStates = new Map<string, IndexingState>()
  private preprocessingOptions = new Map<string, PreprocessingOptions>()
  /** Tracks when the embedding phase started (per-workspace) for ETA calculation */
  private embeddingStartTimes = new Map<string, number>()
  /** Tracks when the AI-description preprocessing phase started (per-workspace) for ETA calculation */
  private descriptionStartTimes = new Map<string, number>()
  /** Throttle bookkeeping for progress emission (per-workspace) */
  private lastEmitAt = new Map<string, number>()
  private lastEmitStatus = new Map<string, IndexingState['status']>()
  private pendingEmit = new Map<string, ReturnType<typeof setTimeout>>()
  private static readonly EMIT_THROTTLE_MS = 150

  private makeDefaultState(): IndexingState {
    return {
      status: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      processedChunks: 0,
      preprocessTotal: 0,
      preprocessComplete: 0,
      preprocessSkipped: 0,
      descriptionsGenerated: 0,
      descriptionsCached: 0,
      descriptionsTotal: 0,
      descriptionsProcessed: 0,
      descriptionSource: 'none'
    }
  }

  // ── Persistence Methods ──────────────────────────────────────────────────

  /**
   * Check if a workspace has persisted embeddings in SQLite.
   */
  hasPersistedIndex(workspaceId: string): boolean {
    return chunkEmbeddingRepository.hasEmbeddings(workspaceId)
  }

  /**
   * Load persisted chunks + embeddings from SQLite into the in-memory collection.
   * Called on workspace open for instant search readiness (<1s for 10k vectors).
   */
  async loadPersistedIndex(workspaceId: string): Promise<{ symbolCount: number }> {
    const start = Date.now()

    // Load chunks from DB
    const chunks = codeChunkRepository.findByWorkspace(workspaceId)
    if (chunks.length === 0) {
      log.info(`[VectorSearch] No persisted chunks for workspace ${workspaceId}`)
      return { symbolCount: 0 }
    }

    // Check if persisted embeddings were generated with a different model
    const dbForModelCheck = getDatabase()
    const modelRow = dbForModelCheck
      .prepare('SELECT embedding_model FROM indexing_state WHERE workspace_id = ?')
      .get(workspaceId) as { embedding_model?: string } | undefined

    const currentModelName = getEmbeddingModelName()
    // Skip model-change check if embedding provider hasn't initialized yet —
    // we can't know the actual model name until the user's oMLX server is queried.
    // The check will happen later in initializeEmbeddingModel() → reindexFiles().
    if (currentModelName && modelRow?.embedding_model && modelRow.embedding_model !== currentModelName) {
      log.info(
        `[VectorSearch] Model changed (${modelRow.embedding_model} → ${currentModelName}), ` +
          `invalidating persisted index for ${workspaceId}`
      )
      chunkEmbeddingRepository.deleteByWorkspace(workspaceId)
      return { symbolCount: 0 }
    }

    // Load embeddings from DB
    const embeddings = chunkEmbeddingRepository.loadAllForWorkspace(workspaceId)
    if (embeddings.length === 0) {
      log.info(`[VectorSearch] No persisted embeddings for workspace ${workspaceId}`)
      return { symbolCount: 0 }
    }

    // Build a map from chunkId -> embedding for fast lookup
    const embeddingMap = new Map<string, number[]>()
    for (const entry of embeddings) {
      embeddingMap.set(entry.chunkId, entry.embedding)
    }

    // Create/get in-memory collection and populate it
    let collection = this.collections.get(workspaceId)
    if (!collection) {
      collection = new InMemoryCollection()
      this.collections.set(workspaceId, collection)
    }

    // Only load chunks that have matching embeddings
    const matchedChunks: ProcessedChunk[] = []
    const matchedEmbeddings: number[][] = []
    const matchedIds: string[] = []

    for (const chunk of chunks) {
      const embedding = embeddingMap.get(chunk.id)
      if (embedding) {
        matchedChunks.push(chunk)
        matchedEmbeddings.push(embedding)
        matchedIds.push(chunk.id)
      }
    }

    collection.upsert(matchedIds, matchedEmbeddings, matchedChunks)

    const elapsed = Date.now() - start
    log.info(
      `[VectorSearch] Loaded persisted index for ${workspaceId}: ${matchedIds.length} vectors in ${elapsed}ms`
    )

    // Update indexing state to reflect loaded index
    const state = this.makeDefaultState()
    state.workspaceId = workspaceId
    state.status = 'complete'
    state.totalChunks = matchedIds.length
    state.processedChunks = matchedIds.length
    this.indexingStates.set(workspaceId, state)

    return { symbolCount: matchedIds.length }
  }

  /**
   * Persist all in-memory chunks + embeddings to SQLite.
   * Called after indexing completes successfully.
   */
  private saveToDb(
    workspaceId: string,
    processedChunks: ProcessedChunk[],
    fileMtimes: Map<string, number>,
    embeddingModel: string
  ): void {
    const start = Date.now()
    const collection = this.collections.get(workspaceId)
    if (!collection) return

    const entries = collection.getEntries()
    if (entries.length === 0) return

    const db = getDatabase()
    const transaction = db.transaction(() => {
      // Persist chunks
      codeChunkRepository.upsertChunks(workspaceId, processedChunks, fileMtimes)

      // Persist embeddings
      const embeddingEntries: EmbeddingEntry[] = entries.map((entry) => ({
        chunkId: entry.id,
        embedding: entry.embedding,
        model: embeddingModel
      }))
      chunkEmbeddingRepository.upsertEmbeddings(workspaceId, embeddingEntries)

      // Update indexing_state
      db.prepare(
        `
        INSERT OR REPLACE INTO indexing_state
          (workspace_id, status, total_files, processed_files, total_chunks, processed_chunks,
           embedding_model, checkpoint_offset, last_completed_at, updated_at)
        VALUES (?, 'complete', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `
      ).run(
        workspaceId,
        0, // total_files — not tracked at this level
        0,
        processedChunks.length,
        processedChunks.length,
        embeddingModel,
        processedChunks.length // checkpoint_offset = total on complete
      )
    })

    transaction()

    const elapsed = Date.now() - start
    log.info(
      `[VectorSearch] Persisted ${entries.length} vectors for ${workspaceId} in ${elapsed}ms`
    )
  }

  /**
   * Checkpoint: persist partial progress to SQLite during embedding.
   * Saves all chunks + embeddings that have been processed so far, and
   * records the checkpoint offset in indexing_state for resume-after-crash.
   */
  private checkpointToDb(
    workspaceId: string,
    processedChunks: ProcessedChunk[],
    embeddedUpTo: number,
    fileMtimes: Map<string, number>,
    embeddingModel: string
  ): void {
    const start = Date.now()
    const collection = this.collections.get(workspaceId)
    if (!collection) return

    const entries = collection.getEntries()
    if (entries.length === 0) return

    const db = getDatabase()
    const transaction = db.transaction(() => {
      // Persist all chunks (needed for resume to map IDs to embeddings)
      codeChunkRepository.upsertChunks(workspaceId, processedChunks, fileMtimes)

      // Persist embeddings accumulated so far
      const embeddingEntries: EmbeddingEntry[] = entries.map((entry) => ({
        chunkId: entry.id,
        embedding: entry.embedding,
        model: embeddingModel
      }))
      chunkEmbeddingRepository.upsertEmbeddings(workspaceId, embeddingEntries)

      // Update checkpoint offset in indexing_state
      db.prepare(
        `
        INSERT OR REPLACE INTO indexing_state
          (workspace_id, status, total_chunks, processed_chunks,
           embedding_model, checkpoint_offset, updated_at)
        VALUES (?, 'indexing', ?, ?, ?, ?, datetime('now'))
      `
      ).run(workspaceId, processedChunks.length, embeddedUpTo, embeddingModel, embeddedUpTo)
    })

    transaction()

    const elapsed = Date.now() - start
    log.info(
      `[VectorSearch] Checkpoint at ${embeddedUpTo}/${processedChunks.length} chunks in ${elapsed}ms`
    )
  }

  /**
   * Get the checkpoint offset from indexing_state for resume support.
   * Returns 0 if no checkpoint exists or status is not 'indexing'.
   */
  getCheckpointOffset(workspaceId: string): number {
    try {
      const db = getDatabase()
      const row = db
        .prepare(`SELECT checkpoint_offset, status FROM indexing_state WHERE workspace_id = ?`)
        .get(workspaceId) as { checkpoint_offset: number; status: string } | undefined

      if (row && row.status === 'indexing' && row.checkpoint_offset > 0) {
        return row.checkpoint_offset
      }
    } catch (e) {
      log.warn('[VectorSearch] Failed to get checkpoint offset:', e)
    }
    return 0
  }

  // ── Indexing Pipeline ────────────────────────────────────────────────────

  /**
   * Index a project: scan files, preprocess chunks, embed, and store vectors.
   * After completion, persists everything to SQLite for fast reload on restart.
   *
   * Orchestrator that delegates to three phases:
   *   1. preprocessChunks() — description strategy, preprocessing pipeline
   *   2. embedChunksWithCheckpoints() — embedding init, checkpoint resume, batch loop
   *   3. persistIndex() — final SQLite persistence
   */
  async indexProject(
    workspaceId: string,
    workspacePath: string,
    tags: RawChunk[],
    fileContents: Map<string, string>,
    options?: Partial<PreprocessingOptions>
  ): Promise<void> {
    const state = this.makeDefaultState()
    state.workspaceId = workspaceId
    state.status = 'scanning'
    state.totalChunks = tags.length
    this.indexingStates.set(workspaceId, state)

    memoryCheckpoint('INDEX_START', {
      tags: tags.length,
      files: fileContents.size,
      descriptions: !!options?.generateDescriptions
    })

    descriptionCache.setWorkspaceId(workspaceId)

    const preprocessOpts: PreprocessingOptions = {
      ...DEFAULT_PREPROCESSING_OPTIONS,
      ...options
    }
    this.preprocessingOptions.set(workspaceId, preprocessOpts)

    this.emitProgress(workspaceId)
    this.updateIndexingStateDb(workspaceId, 'scanning')

    try {
      let collection = this.collections.get(workspaceId)
      if (!collection) {
        collection = new InMemoryCollection()
        this.collections.set(workspaceId, collection)
      }

      // Phase 1: Preprocess chunks
      const processedChunks = await this.preprocessChunks(
        workspaceId,
        workspacePath,
        tags,
        fileContents,
        preprocessOpts,
        state
      )

      if (preprocessOpts.cancelled) {
        state.status = 'idle'
        this.emitProgress(workspaceId)
        this.updateIndexingStateDb(workspaceId, 'idle')
        return
      }

      // Phase 2: Embed chunks with checkpoint support
      const result = await this.embedChunksWithCheckpoints(
        workspaceId,
        workspacePath,
        processedChunks,
        fileContents,
        preprocessOpts,
        state,
        collection
      )

      // Phase 3: Persist (only on success)
      if (result === 'completed') {
        this.persistIndex(
          workspaceId,
          processedChunks,
          fileContents,
          workspacePath,
          state,
          collection
        )
      } else if (result === 'cancelled') {
        state.status = 'idle'
        this.updateIndexingStateDb(workspaceId, 'idle')
      }

      this.emitProgress(workspaceId)
    } catch (error) {
      state.status = 'error'
      state.error = (error as Error).message
      memoryCheckpoint('INDEX_FATAL_ERROR', { error: (error as Error).message })
      log.error(`[VectorSearch] Indexing failed for ${workspaceId}:`, error)
      this.emitProgress(workspaceId)
      this.updateIndexingStateDb(workspaceId, 'error', (error as Error).message)
    }
  }

  /**
   * Phase 1: Preprocess raw chunks — select description strategy, run preprocessing pipeline.
   */
  private async preprocessChunks(
    workspaceId: string,
    workspacePath: string,
    tags: RawChunk[],
    fileContents: Map<string, string>,
    preprocessOpts: PreprocessingOptions,
    state: IndexingState
  ): Promise<ProcessedChunk[]> {
    state.status = 'preprocessing'
    state.preprocessTotal = tags.length
    this.emitProgress(workspaceId)
    this.updateIndexingStateDb(workspaceId, 'preprocessing')

    memoryCheckpoint('PREPROCESS_START', { totalTags: tags.length })

    const projectName = workspacePath.split('/').pop() ?? 'unknown'
    state.descriptionSource = preprocessOpts.generateDescriptions ? 'ai' : 'heuristic'

    // Shared description strategy (also used by reindexFiles)
    const { getDescription, getBatchDescriptions } = this.setupDescriptionStrategy(
      preprocessOpts,
      workspacePath,
      state
    )

    memoryCheckpoint('PREPROCESS_PIPELINE_ENTER', {
      generateDescriptions: !!preprocessOpts.generateDescriptions
    })

    const processedChunks = await runPreprocessingPipeline(
      tags,
      fileContents,
      projectName,
      preprocessOpts,
      (update) => {
        state.processedFiles = update.processedFiles
        state.totalFiles = update.totalFiles
        state.processedChunks = update.processedChunks
        state.preprocessComplete = update.processedChunks
        state.preprocessSkipped = update.skippedFiles
        state.currentFile = update.currentFile
        this.emitProgress(workspaceId)
      },
      getDescription,
      getBatchDescriptions,
      (descUpdate) => {
        state.descriptionsTotal = descUpdate.descriptionsTotal
        state.descriptionsProcessed = descUpdate.descriptionsProcessed
        state.descriptionsCached = descUpdate.descriptionsCached
        state.descriptionsGenerated = descUpdate.descriptionsGenerated
        this.emitProgress(workspaceId)
      }
    )

    memoryCheckpoint('PREPROCESS_PIPELINE_EXIT', {
      processedChunks: processedChunks.length,
      cancelled: !!preprocessOpts.cancelled
    })
    return processedChunks
  }

  /**
   * Phase 2: Embed preprocessed chunks with checkpoint resume, pause/cancel, periodic checkpointing.
   * Returns 'completed' | 'cancelled' | 'error'.
   */
  private async embedChunksWithCheckpoints(
    workspaceId: string,
    workspacePath: string,
    processedChunks: ProcessedChunk[],
    fileContents: Map<string, string>,
    preprocessOpts: PreprocessingOptions,
    state: IndexingState,
    collection: InMemoryCollection
  ): Promise<'completed' | 'cancelled' | 'error'> {
    state.status = 'indexing-chunks'
    state.totalChunks = processedChunks.length
    state.processedChunks = 0
    this.emitProgress(workspaceId)
    this.updateIndexingStateDb(workspaceId, 'indexing')

    // Nudge GC between preprocessing and embedding phases
    memoryCheckpoint('GC_BEFORE')
    if (global.gc) {
      log.info('[VectorSearch] Running GC hint between preprocessing and embedding phases')
      global.gc()
    }
    memoryCheckpoint('GC_AFTER')

    // Embedding model init — delegated to sub-method (worker or WASM fallback)
    const embedFn = await this.initializeEmbeddingModel()

    // Sub-method 2: Resume from checkpoint if available
    const startOffset = this.resumeFromCheckpoint(workspaceId, processedChunks, collection)
    if (startOffset > 0) {
      state.processedChunks = startOffset
      this.emitProgress(workspaceId)
    }

    const fileMtimes = this.buildFileMtimeMap(workspacePath, fileContents)
    this.embeddingStartTimes.set(workspaceId, Date.now())

    const totalBatches = Math.ceil((processedChunks.length - startOffset) / EMBEDDING_BATCH_SIZE)
    memoryCheckpoint('EMBED_LOOP_START', {
      chunks: processedChunks.length,
      batchSize: EMBEDDING_BATCH_SIZE,
      totalBatches,
      startOffset
    })

    // Sub-method 3: Core batch embedding loop with checkpointing
    return this.embedBatchLoop(
      workspaceId,
      processedChunks,
      startOffset,
      collection,
      state,
      preprocessOpts,
      fileMtimes,
      embedFn
    )
  }

  /**
   * Phase 3: Persist completed index to SQLite and finalize state.
   */
  private persistIndex(
    workspaceId: string,
    processedChunks: ProcessedChunk[],
    fileContents: Map<string, string>,
    workspacePath: string,
    state: IndexingState,
    collection: InMemoryCollection
  ): void {
    state.status = 'complete'
    state.processedChunks = processedChunks.length
    memoryCheckpoint('INDEX_COMPLETE', { vectors: collection.size })
    log.info(`[VectorSearch] Indexing complete for ${workspaceId}: ${collection.size} vectors`)

    const fileMtimes = this.buildFileMtimeMap(workspacePath, fileContents)
    try {
      this.saveToDb(workspaceId, processedChunks, fileMtimes, getEmbeddingModelName() ?? 'unknown')
    } catch (persistError) {
      log.warn('[VectorSearch] Failed to persist index to SQLite:', persistError)
    }
  }

  /**
   * Build a map of relative file path → mtime for persistence.
   */
  private buildFileMtimeMap(
    workspacePath: string,
    fileContents: Map<string, string>
  ): Map<string, number> {
    const fileMtimes = new Map<string, number>()
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module import for persistence
    const { statSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module import for persistence
    const { join } = require('node:path') as typeof import('node:path')
    for (const relPath of fileContents.keys()) {
      try {
        const absPath = join(workspacePath, relPath)
        const stat = statSync(absPath)
        fileMtimes.set(relPath, stat.mtimeMs)
      } catch {
        fileMtimes.set(relPath, 0)
      }
    }
    return fileMtimes
  }

  // ── Incremental Re-indexing ──────────────────────────────────────────────

  /**
   * Incrementally re-index specific files — preprocess + embed only the
   * provided chunks, then upsert into the existing in-memory collection.
   * Does NOT reset progress counters or clear the collection.
   *
   * This fixes the "resume doesn't skip already-indexed files" bug:
   * instead of re-running indexProject() with ALL chunks, callers pass only
   * the chunks for changed files. The collection uses upsert semantics so
   * existing chunk IDs are updated, new ones are added.
   */
  async reindexFiles(
    workspaceId: string,
    workspacePath: string,
    chunks: RawChunk[],
    fileContents: Map<string, string>,
    options?: Partial<PreprocessingOptions>
  ): Promise<void> {
    const collection = this.collections.get(workspaceId)
    if (!collection) {
      log.warn(`[VectorSearch] No collection for workspace ${workspaceId}, skipping incremental`)
      return
    }

    const preprocessOpts: PreprocessingOptions = {
      ...DEFAULT_PREPROCESSING_OPTIONS,
      ...options
    }

    descriptionCache.setWorkspaceId(workspaceId)
    const projectName = workspacePath.split('/').pop() ?? 'unknown'

    // Shared description strategy (also used by preprocessChunks)
    const { getDescription, getBatchDescriptions } = this.setupDescriptionStrategy(
      preprocessOpts,
      workspacePath
    )

    // Preprocess only the changed chunks
    const processedChunks = await runPreprocessingPipeline(
      chunks,
      fileContents,
      projectName,
      preprocessOpts,
      () => {},
      getDescription,
      getBatchDescriptions
    )

    if (processedChunks.length === 0) return

    // Ensure embedding model is loaded before first use
    if (!omlxEmbeddingProvider.isReady) {
      await omlxEmbeddingProvider.initialize()
    }

    // Embed and upsert in batches
    for (let i = 0; i < processedChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = processedChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
      const texts = batch.map((c) => c.embedText)

      try {
        const embeddings = await omlxEmbeddingProvider.embed(texts)
        const ids = batch.map((c) => c.id)
        collection.upsert(ids, embeddings, batch)
      } catch (error) {
        log.error(`[VectorSearch] Incremental embedding failed:`, error)
        return
      }
    }

    // Persist updated collection to DB
    const { statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const fileMtimes = new Map<string, number>()
    for (const relPath of fileContents.keys()) {
      try {
        const stat = statSync(join(workspacePath, relPath))
        fileMtimes.set(relPath, stat.mtimeMs)
      } catch {
        fileMtimes.set(relPath, 0)
      }
    }
    this.saveToDb(workspaceId, processedChunks, fileMtimes, getEmbeddingModelName() ?? 'unknown')

    log.info(`[VectorSearch] Incremental: upserted ${processedChunks.length} chunks`)
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Search the indexed codebase with a natural language query.
   */
  async search(
    workspaceId: string,
    query: string,
    options?: { nResults?: number; where?: Record<string, unknown> }
  ): Promise<SemanticSearchResult[]> {
    const collection = this.collections.get(workspaceId)
    if (!collection || collection.size === 0) {
      log.warn(`[VectorSearch] No index for workspace ${workspaceId}`)
      return []
    }

    try {
      // Ensure embedding model is loaded before first use
      if (!omlxEmbeddingProvider.isReady) {
        await omlxEmbeddingProvider.initialize()
      }
      const [queryEmbedding] = await omlxEmbeddingProvider.embed([query])
      return collection.query(queryEmbedding, options?.nResults ?? 5, options?.where)
    } catch (error) {
      log.error(`[VectorSearch] Search failed for workspace ${workspaceId}:`, error)
      return []
    }
  }

  /**
   * Search by raw code snippet — embed the snippet and find nearest neighbors.
   * Used by the `similar_code` MCP tool.
   */
  async searchByCode(
    workspaceId: string,
    code: string,
    opts?: { nResults?: number; language?: string }
  ): Promise<SemanticSearchResult[]> {
    const collection = this.collections.get(workspaceId)
    if (!collection || collection.size === 0) {
      log.warn(`[VectorSearch] No index for workspace ${workspaceId}`)
      return []
    }

    try {
      // Ensure embedding model is loaded before first use
      if (!omlxEmbeddingProvider.isReady) {
        await omlxEmbeddingProvider.initialize()
      }
      const [codeEmbedding] = await omlxEmbeddingProvider.embed([code])
      const where = opts?.language ? { language: opts.language } : undefined
      return collection.query(codeEmbedding, opts?.nResults ?? 10, where)
    } catch (error) {
      log.error(`[VectorSearch] searchByCode failed for workspace ${workspaceId}:`, error)
      return []
    }
  }

  /**
   * Cluster code chunks by embedding similarity to identify conceptual groupings.
   * Uses a greedy approach: pick highest-reference chunks as cluster centers,
   * then group remaining chunks by nearest center.
   */
  getConceptClusters(
    workspaceId: string,
    opts?: { maxClusters?: number }
  ): {
    clusterId: number
    representative: { filePath: string; symbolName: string }
    members: { filePath: string; symbolName: string; similarity: number }[]
  }[] {
    const collection = this.collections.get(workspaceId)
    if (!collection || collection.size === 0) return []

    const maxClusters = opts?.maxClusters ?? 10
    const entries = collection.getEntries()
    if (entries.length === 0) return []

    // Phase 1: Select diverse cluster centers via maximin initialization
    const centers = this.selectClusterCenters(entries, maxClusters)

    // Phase 2: Assign entries to nearest center
    const clusters = this.assignClustersToMembers(entries, centers)

    // Sort clusters by size descending, limit member list
    return clusters
      .sort((a, b) => b.members.length - a.members.length)
      .map(({ clusterId, representative, members }) => ({
        clusterId,
        representative,
        members: members.slice(0, 15) // cap per-cluster members
      }))
  }

  // ── Control Methods ──────────────────────────────────────────────────────

  /**
   * Pause indexing for a workspace.
   */
  pauseIndexing(workspaceId: string): void {
    const opts = this.preprocessingOptions.get(workspaceId)
    if (opts) {
      opts.paused = true
      const state = this.indexingStates.get(workspaceId)
      if (state) {
        state.status = 'paused'
        this.emitProgress(workspaceId)
      }
    }
  }

  /**
   * Resume indexing for a workspace.
   */
  resumeIndexing(workspaceId: string): void {
    const opts = this.preprocessingOptions.get(workspaceId)
    if (opts) {
      opts.paused = false
    }
  }

  /**
   * Cancel indexing for a workspace.
   */
  cancelIndexing(workspaceId: string): void {
    const opts = this.preprocessingOptions.get(workspaceId)
    if (opts) {
      opts.cancelled = true
      opts.paused = false
    }
  }

  /**
   * Get the current indexing state for a workspace.
   */
  getIndexingState(workspaceId: string): IndexingState {
    return this.indexingStates.get(workspaceId) ?? this.makeDefaultState()
  }

  /**
   * Clean up a workspace's vector collection.
   */
  async dispose(workspaceId: string): Promise<void> {
    this.cancelIndexing(workspaceId)
    const collection = this.collections.get(workspaceId)
    if (collection) {
      collection.clear()
      this.collections.delete(workspaceId)
    }
    this.indexingStates.delete(workspaceId)
    this.preprocessingOptions.delete(workspaceId)
    this.embeddingStartTimes.delete(workspaceId)
    this.descriptionStartTimes.delete(workspaceId)
    const pending = this.pendingEmit.get(workspaceId)
    if (pending) clearTimeout(pending)
    this.pendingEmit.delete(workspaceId)
    this.lastEmitAt.delete(workspaceId)
    this.lastEmitStatus.delete(workspaceId)
    log.info(`[VectorSearch] Disposed workspace ${workspaceId}`)
  }

  /**
   * Check if a workspace has an active in-memory index.
   */
  hasIndex(workspaceId: string): boolean {
    const collection = this.collections.get(workspaceId)
    return !!collection && collection.size > 0
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Build the description strategy callbacks (getDescription + getBatchDescriptions)
   * shared by preprocessChunks() and reindexFiles(). Returns the callback pair
   * based on whether AI or heuristic descriptions are configured.
   */
  private setupDescriptionStrategy(
    preprocessOpts: PreprocessingOptions,
    workspacePath: string,
    state?: IndexingState
  ): {
    getDescription: (chunk: RawChunk, embedText: string) => Promise<string | undefined>
    getBatchDescriptions?: (
      chunks: Array<{ chunk: RawChunk; embedText: string }>
    ) => Promise<{ descriptions: Map<number, string>; cached: number; generated: number }>
  } {
    const useAiDescriptions = preprocessOpts.generateDescriptions

    const getBatchDescriptions = useAiDescriptions
      ? async (
          chunks: Array<{ chunk: RawChunk; embedText: string }>
        ): Promise<{ descriptions: Map<number, string>; cached: number; generated: number }> => {
          return descriptionCache.getOrGenerateBatch(
            chunks,
            preprocessOpts.descriptionModel,
            workspacePath
          )
        }
      : undefined

    const getDescription = useAiDescriptions
      ? async (chunk: RawChunk, embedText: string): Promise<string | undefined> => {
          const desc = await descriptionCache.getOrGenerate(
            chunk,
            embedText,
            preprocessOpts.descriptionModel,
            workspacePath
          )
          // Track cache stats for indexing state when available
          if (desc && state) {
            const key = descriptionCache.makeKey(chunk.filePath, chunk.symbolName, chunk.body)
            const cached = descriptionCache.get(key)
            if (cached === desc) {
              state.descriptionsCached++
            } else {
              state.descriptionsGenerated++
            }
          }
          return desc
        }
      : async (chunk: RawChunk, _embedText: string): Promise<string | undefined> => {
          return generateHeuristicDescription(chunk)
        }

    return { getDescription, getBatchDescriptions }
  }

  /**
   * Select k diverse cluster centers using maximin initialization.
   * Picks entries that maximize minimum distance from all existing centers.
   */
  private selectClusterCenters(entries: { embedding: number[] }[], k: number): number[] {
    const centers: number[] = [0] // start with first entry
    while (centers.length < Math.min(k, entries.length)) {
      let bestIdx = -1
      let bestMinDist = -1
      for (let i = 0; i < entries.length; i++) {
        if (centers.includes(i)) continue
        let minDist = Infinity
        for (const ci of centers) {
          const sim = cosineSimilarity(entries[i].embedding, entries[ci].embedding)
          const dist = 1 - sim
          if (dist < minDist) minDist = dist
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist
          bestIdx = i
        }
      }
      if (bestIdx === -1) break
      centers.push(bestIdx)
    }
    return centers
  }

  /**
   * Assign each entry to the nearest cluster center by cosine similarity.
   * Returns cluster objects with representative and member lists.
   */
  private assignClustersToMembers(
    entries: {
      embedding: number[]
      chunk: { metadata: { filePath: string; symbolName: string } }
    }[],
    centers: number[]
  ): {
    clusterId: number
    representative: { filePath: string; symbolName: string }
    members: { filePath: string; symbolName: string; similarity: number }[]
  }[] {
    const clusters = centers.map((ci, idx) => ({
      clusterId: idx,
      representative: {
        filePath: entries[ci].chunk.metadata.filePath,
        symbolName: entries[ci].chunk.metadata.symbolName
      },
      members: [] as { filePath: string; symbolName: string; similarity: number }[]
    }))

    for (let i = 0; i < entries.length; i++) {
      if (centers.includes(i)) continue
      let bestCluster = 0
      let bestSim = -1
      for (let c = 0; c < centers.length; c++) {
        const sim = cosineSimilarity(entries[i].embedding, entries[centers[c]].embedding)
        if (sim > bestSim) {
          bestSim = sim
          bestCluster = c
        }
      }
      clusters[bestCluster].members.push({
        filePath: entries[i].chunk.metadata.filePath,
        symbolName: entries[i].chunk.metadata.symbolName,
        similarity: Math.round(bestSim * 1000) / 1000
      })
    }

    return clusters
  }

  /**
   * Initialize the embedding model via the oMLX server (the only backend).
   * Returns the embed function to use for batch embedding. Rejects if oMLX
   * is not running or no embedding model is loaded.
   */
  private async initializeEmbeddingModel(): Promise<(texts: string[]) => Promise<number[][]>> {
    if (!omlxEmbeddingProvider.isReady) {
      memoryCheckpoint('EMBEDDING_OMLX_INIT_START')
      log.info('[VectorSearch] Initializing oMLX embedding provider...')
      await omlxEmbeddingProvider.initialize()
      memoryCheckpoint('EMBEDDING_OMLX_INIT_DONE')
    } else {
      memoryCheckpoint('EMBEDDING_OMLX_ALREADY_READY')
    }

    return (texts: string[]) => omlxEmbeddingProvider.embed(texts)
  }

  /**
   * Resume from a checkpoint: load previously-embedded chunks from DB
   * into the in-memory collection, returning the offset to continue from.
   */
  private resumeFromCheckpoint(
    workspaceId: string,
    processedChunks: ProcessedChunk[],
    collection: InMemoryCollection
  ): number {
    const checkpointOffset = this.getCheckpointOffset(workspaceId)
    if (checkpointOffset <= 0 || checkpointOffset >= processedChunks.length) {
      return 0
    }

    log.info(
      `[VectorSearch] Resuming from checkpoint offset ${checkpointOffset}/${processedChunks.length}`
    )
    memoryCheckpoint('RESUME_FROM_CHECKPOINT', {
      offset: checkpointOffset,
      total: processedChunks.length
    })

    const existingEmbeddings = chunkEmbeddingRepository.loadAllForWorkspace(workspaceId)
    const embeddingMap = new Map<string, number[]>()
    for (const entry of existingEmbeddings) {
      embeddingMap.set(entry.chunkId, entry.embedding)
    }

    for (let i = 0; i < checkpointOffset && i < processedChunks.length; i++) {
      const chunk = processedChunks[i]
      const embedding = embeddingMap.get(chunk.id)
      if (embedding) {
        collection.upsert([chunk.id], [embedding], [chunk])
      }
    }

    return checkpointOffset
  }

  /**
   * Core batch embedding loop with pause/cancel polling and periodic
   * checkpointing. Returns 'completed', 'cancelled', or 'error'.
   */
  private async embedBatchLoop(
    workspaceId: string,
    processedChunks: ProcessedChunk[],
    startOffset: number,
    collection: InMemoryCollection,
    state: IndexingState,
    preprocessOpts: PreprocessingOptions,
    fileMtimes: Map<string, number>,
    embedFn: (texts: string[]) => Promise<number[][]>
  ): Promise<'completed' | 'cancelled' | 'error'> {
    const totalBatches = Math.ceil((processedChunks.length - startOffset) / EMBEDDING_BATCH_SIZE)
    let batchesSinceCheckpoint = 0

    for (let i = startOffset; i < processedChunks.length; i += EMBEDDING_BATCH_SIZE) {
      if (preprocessOpts.cancelled) break

      while (preprocessOpts.paused && !preprocessOpts.cancelled) {
        state.status = 'paused'
        this.emitProgress(workspaceId)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (preprocessOpts.cancelled) break

      state.status = 'indexing-chunks'
      const batchNum = Math.floor((i - startOffset) / EMBEDDING_BATCH_SIZE) + 1
      const batch = processedChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
      const texts = batch.map((c) => c.embedText)

      const isLogBatch = batchNum === 1 || batchNum % 10 === 0 || batchNum === totalBatches
      if (isLogBatch) {
        memoryCheckpoint(`EMBED_BATCH_${batchNum}/${totalBatches}`, {
          offset: i,
          batchTextsChars: texts.reduce((s, t) => s + t.length, 0)
        })
      }

      try {
        const embeddings = await embedFn(texts)
        const ids = batch.map((c) => c.id)
        collection.upsert(ids, embeddings, batch)

        state.processedChunks = Math.min(i + EMBEDDING_BATCH_SIZE, processedChunks.length)
        state.currentFile = batch[batch.length - 1].metadata.filePath
        this.emitProgress(workspaceId)

        batchesSinceCheckpoint++
        if (batchesSinceCheckpoint >= CHECKPOINT_INTERVAL_BATCHES) {
          const embeddedUpTo = Math.min(i + EMBEDDING_BATCH_SIZE, processedChunks.length)
          try {
            this.checkpointToDb(
              workspaceId,
              processedChunks,
              embeddedUpTo,
              fileMtimes,
              getEmbeddingModelName() ?? 'unknown'
            )
            memoryCheckpoint('CHECKPOINT_SAVED', {
              embeddedUpTo,
              total: processedChunks.length
            })
          } catch (checkpointError) {
            log.warn('[VectorSearch] Checkpoint save failed:', checkpointError)
          }
          batchesSinceCheckpoint = 0
        }
      } catch (error) {
        log.error(`[VectorSearch] Embedding batch failed at offset ${i}:`, error)
        memoryCheckpoint('EMBED_BATCH_ERROR', {
          offset: i,
          error: (error as Error).message
        })

        try {
          const embeddedUpTo = Math.max(i, startOffset)
          if (embeddedUpTo > startOffset) {
            this.checkpointToDb(
              workspaceId,
              processedChunks,
              embeddedUpTo,
              fileMtimes,
              getEmbeddingModelName() ?? 'unknown'
            )
            log.info(`[VectorSearch] Error checkpoint saved at offset ${embeddedUpTo}`)
          }
        } catch {
          /* Ignore checkpoint errors during error handling */
        }

        state.status = 'error'
        state.error = (error as Error).message
        this.emitProgress(workspaceId)
        this.updateIndexingStateDb(workspaceId, 'error', (error as Error).message)
        return 'error'
      }
    }

    return preprocessOpts.cancelled ? 'cancelled' : 'completed'
  }

  private emitProgress(workspaceId: string): void {
    const state = this.indexingStates.get(workspaceId)
    if (!state) return

    // Compute ETA during embedding phase
    if (
      (state.status === 'indexing-chunks' || state.status === 'embedding') &&
      state.totalChunks > 0 &&
      state.processedChunks > 0
    ) {
      const startTime = this.embeddingStartTimes.get(workspaceId)
      if (startTime) {
        const elapsed = Date.now() - startTime
        const rate = state.processedChunks / elapsed // chunks per ms
        const remaining = state.totalChunks - state.processedChunks
        const etaMs = remaining / rate
        state.estimatedRemaining = formatEta(etaMs)
      }
    } else if (state.status === 'preprocessing') {
      // Compute ETA for the AI-description sub-phase here (rather than in the
      // renderer) so the panel stays a pure read of state.estimatedRemaining —
      // the renderer's lint rules forbid Date.now()/ref-writes during render.
      let startTime = this.descriptionStartTimes.get(workspaceId)
      if (!startTime) {
        startTime = Date.now()
        this.descriptionStartTimes.set(workspaceId, startTime)
      }
      if (state.descriptionsTotal > 0 && state.descriptionsProcessed > 0) {
        const elapsed = Date.now() - startTime
        const rate = state.descriptionsProcessed / elapsed // descriptions per ms
        const remaining = state.descriptionsTotal - state.descriptionsProcessed
        state.estimatedRemaining = rate > 0 ? formatEta(remaining / rate) : undefined
      } else {
        state.estimatedRemaining = undefined
      }
    } else {
      // Reset the description-phase start once we leave preprocessing.
      this.descriptionStartTimes.delete(workspaceId)
    }

    // Throttle high-frequency progress (preprocessing/embedding fires once per
    // file/batch) to at most ~1 emit / EMIT_THROTTLE_MS. This caps renderer
    // update frequency regardless of repo size — without this, an emit storm
    // drives setState faster than React can commit and trips the
    // "Maximum update depth exceeded" guard. Status transitions and terminal
    // states always emit immediately so no important update is dropped.
    const now = Date.now()
    const statusChanged = state.status !== this.lastEmitStatus.get(workspaceId)
    const isTerminal =
      state.status === 'complete' ||
      state.status === 'error' ||
      state.status === 'paused' ||
      state.status === 'idle'
    const lastAt = this.lastEmitAt.get(workspaceId) ?? 0

    if (statusChanged || isTerminal || now - lastAt >= VectorSearchService.EMIT_THROTTLE_MS) {
      this.flushEmit(workspaceId, state, now)
      // Reset throttle bookkeeping once indexing settles so the next run is clean.
      if (isTerminal) {
        this.lastEmitAt.delete(workspaceId)
        this.lastEmitStatus.delete(workspaceId)
      }
      return
    }

    // Otherwise schedule a single trailing-edge emit so the latest mutated
    // state in this throttle window is not lost.
    if (!this.pendingEmit.has(workspaceId)) {
      const delay = VectorSearchService.EMIT_THROTTLE_MS - (now - lastAt)
      const timer = setTimeout(() => {
        this.pendingEmit.delete(workspaceId)
        const latest = this.indexingStates.get(workspaceId)
        if (latest) this.flushEmit(workspaceId, latest, Date.now())
      }, delay)
      this.pendingEmit.set(workspaceId, timer)
    }
  }

  /** Perform the actual progress emit and record throttle bookkeeping. */
  private flushEmit(workspaceId: string, state: IndexingState, now: number): void {
    const pending = this.pendingEmit.get(workspaceId)
    if (pending) {
      clearTimeout(pending)
      this.pendingEmit.delete(workspaceId)
    }
    this.lastEmitAt.set(workspaceId, now)
    this.lastEmitStatus.set(workspaceId, state.status)
    this.emit('progress', state)
  }

  /**
   * Update the persistent indexing_state table in SQLite.
   */
  private updateIndexingStateDb(workspaceId: string, status: string, error?: string): void {
    try {
      const db = getDatabase()
      db.prepare(
        `
        INSERT OR REPLACE INTO indexing_state (workspace_id, status, last_error, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `
      ).run(workspaceId, status, error ?? null)
    } catch (e) {
      log.warn('[VectorSearch] Failed to update indexing_state:', e)
    }
  }
}

export const vectorSearchService = new VectorSearchService()

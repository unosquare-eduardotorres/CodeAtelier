import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import { ollamaManager } from './ollama-manager.service'
import { descriptionCache } from './description-cache.service'
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
import type { IndexingState, SemanticSearchResult } from '../../shared/types'

/** Default embedding model — 768-dim, multilingual, good for code */
const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding:4b'

/** Max batch size for embedding calls */
const EMBEDDING_BATCH_SIZE = 32

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
      descriptionsProcessed: 0
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
           embedding_model, last_completed_at, updated_at)
        VALUES (?, 'complete', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `
      ).run(
        workspaceId,
        0, // total_files — not tracked at this level
        0,
        processedChunks.length,
        processedChunks.length,
        embeddingModel
      )
    })

    transaction()

    const elapsed = Date.now() - start
    log.info(
      `[VectorSearch] Persisted ${entries.length} vectors for ${workspaceId} in ${elapsed}ms`
    )
  }

  // ── Indexing Pipeline ────────────────────────────────────────────────────

  /**
   * Index a project: scan files, preprocess chunks, embed, and store vectors.
   * After completion, persists everything to SQLite for fast reload on restart.
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

    // Set workspace ID on description cache for proper scoping
    descriptionCache.setWorkspaceId(workspaceId)

    const preprocessOpts: PreprocessingOptions = {
      ...DEFAULT_PREPROCESSING_OPTIONS,
      ...options
    }
    this.preprocessingOptions.set(workspaceId, preprocessOpts)

    this.emitProgress(workspaceId)

    // Update indexing_state in DB
    this.updateIndexingStateDb(workspaceId, 'scanning')

    try {
      // Get or create collection for this workspace
      let collection = this.collections.get(workspaceId)
      if (!collection) {
        collection = new InMemoryCollection()
        this.collections.set(workspaceId, collection)
      }

      // ── Preprocessing phase ──
      state.status = 'preprocessing'
      state.preprocessTotal = tags.length
      this.emitProgress(workspaceId)
      this.updateIndexingStateDb(workspaceId, 'preprocessing')

      const projectName = workspacePath.split('/').pop() ?? 'unknown'

      // Batch description generator callback (new: 10-20x faster)
      const getBatchDescriptions = preprocessOpts.generateDescriptions
        ? async (
            chunks: Array<{ chunk: RawChunk; embedText: string }>
          ): Promise<{
            descriptions: Map<number, string>
            cached: number
            generated: number
          }> => {
            return descriptionCache.getOrGenerateBatch(
              chunks,
              preprocessOpts.descriptionModel,
              workspacePath
            )
          }
        : undefined

      // Single-call fallback (kept for backward compatibility)
      const getDescription = preprocessOpts.generateDescriptions
        ? async (chunk: RawChunk, embedText: string): Promise<string | undefined> => {
            const desc = await descriptionCache.getOrGenerate(
              chunk,
              embedText,
              preprocessOpts.descriptionModel,
              workspacePath
            )
            if (desc) {
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
        : undefined

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

      if (preprocessOpts.cancelled) {
        state.status = 'idle'
        this.emitProgress(workspaceId)
        this.updateIndexingStateDb(workspaceId, 'idle')
        return
      }

      // ── Embedding phase ──
      state.status = 'indexing-chunks'
      state.totalChunks = processedChunks.length
      state.processedChunks = 0
      this.emitProgress(workspaceId)
      this.updateIndexingStateDb(workspaceId, 'indexing')

      const embeddingModel =
        ((options as Record<string, unknown>)?.ollamaModel as string) || DEFAULT_EMBEDDING_MODEL

      // Batch embed chunks
      for (let i = 0; i < processedChunks.length; i += EMBEDDING_BATCH_SIZE) {
        if (preprocessOpts.cancelled) break

        // Wait while paused
        while (preprocessOpts.paused && !preprocessOpts.cancelled) {
          state.status = 'paused'
          this.emitProgress(workspaceId)
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (preprocessOpts.cancelled) break

        state.status = 'indexing-chunks'

        const batch = processedChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
        const texts = batch.map((c) => c.embedText)

        try {
          const embeddings = await ollamaManager.embed(embeddingModel, texts)
          const ids = batch.map((c) => c.id)
          collection.upsert(ids, embeddings, batch)

          state.processedChunks = Math.min(i + EMBEDDING_BATCH_SIZE, processedChunks.length)
          state.currentFile = batch[batch.length - 1].metadata.filePath
          this.emitProgress(workspaceId)
        } catch (error) {
          log.error(`[VectorSearch] Embedding batch failed at offset ${i}:`, error)
          state.status = 'error'
          state.error = (error as Error).message
          this.emitProgress(workspaceId)
          this.updateIndexingStateDb(workspaceId, 'error', (error as Error).message)
          return
        }
      }

      if (!preprocessOpts.cancelled) {
        state.status = 'complete'
        state.processedChunks = processedChunks.length
        log.info(`[VectorSearch] Indexing complete for ${workspaceId}: ${collection.size} vectors`)

        // ── Persist to SQLite for fast reload on restart ──
        try {
          // Build file mtime map from fileContents keys
          const fileMtimes = new Map<string, number>()
          const { statSync } = require('node:fs') as typeof import('node:fs')
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

          this.saveToDb(workspaceId, processedChunks, fileMtimes, embeddingModel)
        } catch (persistError) {
          // Non-fatal: index still works in-memory, just won't persist
          log.warn('[VectorSearch] Failed to persist index to SQLite:', persistError)
        }
      } else {
        state.status = 'idle'
        this.updateIndexingStateDb(workspaceId, 'idle')
      }
      this.emitProgress(workspaceId)
    } catch (error) {
      state.status = 'error'
      state.error = (error as Error).message
      log.error(`[VectorSearch] Indexing failed for ${workspaceId}:`, error)
      this.emitProgress(workspaceId)
      this.updateIndexingStateDb(workspaceId, 'error', (error as Error).message)
    }
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
    options?: Partial<PreprocessingOptions> & { ollamaModel?: string }
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

    // Batch description generator callback (faster for incremental too)
    const getBatchDescriptions = preprocessOpts.generateDescriptions
      ? async (
          batchChunks: Array<{ chunk: RawChunk; embedText: string }>
        ): Promise<{
          descriptions: Map<number, string>
          cached: number
          generated: number
        }> => {
          return descriptionCache.getOrGenerateBatch(
            batchChunks,
            preprocessOpts.descriptionModel,
            workspacePath
          )
        }
      : undefined

    // Single-call fallback
    const getDescription = preprocessOpts.generateDescriptions
      ? async (chunk: RawChunk, embedText: string): Promise<string | undefined> => {
          return descriptionCache.getOrGenerate(
            chunk,
            embedText,
            preprocessOpts.descriptionModel,
            workspacePath
          )
        }
      : undefined

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

    const embeddingModel = options?.ollamaModel || DEFAULT_EMBEDDING_MODEL

    // Embed and upsert in batches
    for (let i = 0; i < processedChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = processedChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
      const texts = batch.map((c) => c.embedText)

      try {
        const embeddings = await ollamaManager.embed(embeddingModel, texts)
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
    this.saveToDb(workspaceId, processedChunks, fileMtimes, embeddingModel)

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

    const embeddingModel = DEFAULT_EMBEDDING_MODEL

    try {
      const [queryEmbedding] = await ollamaManager.embed(embeddingModel, [query])
      return collection.query(queryEmbedding, options?.nResults ?? 5, options?.where)
    } catch (error) {
      log.error(`[VectorSearch] Search failed for workspace ${workspaceId}:`, error)
      return []
    }
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

  private emitProgress(workspaceId: string): void {
    const state = this.indexingStates.get(workspaceId)
    if (state) {
      this.emit('progress', state)
    }
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

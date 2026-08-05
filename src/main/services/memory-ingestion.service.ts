/**
 * memory-ingestion.service.ts — Orchestrates manual document ingestion into memory.
 *
 * Flow:
 *   Select files/folder → discovery + filter → format-specific text extraction
 *   → structure-aware chunking → per-chunk Haiku fact extraction (serialized queue)
 *   → writeFact (embed → dedup → classify) → per-doc progress → summary
 *
 * Incremental re-ingestion: uses memory_doc_state (workspace_id, file_path, content_hash)
 * to skip unchanged files on re-ingest.
 *
 * Singleton: memoryIngestionService
 */

import { readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname, relative } from 'node:path'
import log from 'electron-log'
import type { IngestionProgress } from '../../shared/types'
import { readDocument, isSupportedExtension } from './document-reader'
import { chunkDocument, detectStrategy } from './document-chunker'
import { memoryExtractionService } from './memory-extraction.service'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'

const ingestionLog = log.scope('memory-ingestion')

// Re-export for convenience
export type { IngestionProgress }
export type IngestionProgressCallback = (progress: IngestionProgress) => void

// ── Configuration ────────────────────────────────────────────────────────────

/** Directories to skip during folder walk */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.tox', '.venv',
  'vendor', 'target', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '.vs'
])

/** Max files per folder ingestion (guard against accidental huge repo scans) */
const MAX_FILES_PER_FOLDER = 200

// ── Discovery result ─────────────────────────────────────────────────────────

export interface DiscoveryResult {
  files: string[]
  counts: Record<string, number>
  truncated: boolean
}

// ── Service ──────────────────────────────────────────────────────────────────

class MemoryIngestionService {
  private activeJobs = new Map<string, AbortController>()
  private jobCounter = 0

  /**
   * Discover files in a directory, applying filters and the file cap.
   * Returns the list + counts by extension for pre-start confirmation.
   */
  discoverFiles(dirPath: string): DiscoveryResult {
    const files: string[] = []
    const counts: Record<string, number> = {}

    this.walkDir(dirPath, files, 0)

    // Count by extension
    for (const f of files) {
      const ext = extname(f).toLowerCase() || '(no ext)'
      counts[ext] = (counts[ext] ?? 0) + 1
    }

    const truncated = files.length > MAX_FILES_PER_FOLDER
    return {
      files: files.slice(0, MAX_FILES_PER_FOLDER),
      counts,
      truncated
    }
  }

  /**
   * Start ingesting a list of files. Returns a jobId for tracking/cancellation.
   *
   * @param files - Absolute paths to files to ingest
   * @param workspaceId - Workspace to associate facts with
   * @param workspacePath - Workspace root for relative path computation
   * @param onProgress - Progress callback (called on each state change)
   */
  async ingestFiles(
    files: string[],
    workspaceId: string,
    workspacePath: string,
    onProgress?: IngestionProgressCallback
  ): Promise<{ jobId: string; factsCreated: number }> {
    const jobId = `ingest-${++this.jobCounter}-${Date.now()}`
    const controller = new AbortController()
    this.activeJobs.set(jobId, controller)

    let totalFacts = 0

    const emit = (partial: Partial<IngestionProgress> & { docIndex: number; docName: string }): void => {
      onProgress?.({
        jobId,
        docCount: files.length,
        chunkIndex: 0,
        chunkCount: 0,
        factsCreated: totalFacts,
        docStatus: 'queued',
        message: '',
        jobStatus: 'running',
        ...partial
      })
    }

    try {
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) {
          emit({
            docIndex: i + 1,
            docName: files[i].split('/').pop() ?? '',
            jobStatus: 'cancelled',
            message: 'Ingestion cancelled'
          })
          break
        }

        const filePath = files[i]
        const docName = relative(workspacePath, filePath) || (filePath.split('/').pop() ?? filePath)

        try {
          const facts = await this.ingestSingleFile(
            filePath,
            workspaceId,
            workspacePath,
            docName,
            i,
            files.length,
            jobId,
            controller.signal,
            emit
          )
          totalFacts += facts
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          ingestionLog.warn(`[ingestFiles] Error on ${docName}: ${msg}`)
          emit({
            docIndex: i + 1,
            docName,
            docStatus: 'error',
            message: `Error: ${msg}`
          })
        }
      }

      const jobStatus = controller.signal.aborted ? 'cancelled' : 'done'
      emit({
        docIndex: files.length,
        docName: '',
        jobStatus,
        docStatus: 'done',
        message: `Ingestion ${jobStatus}: ${totalFacts} memories created from ${files.length} files`
      })

      return { jobId, factsCreated: totalFacts }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ingestionLog.error(`[ingestFiles] Job ${jobId} failed:`, err)
      emit({
        docIndex: 0,
        docName: '',
        jobStatus: 'error',
        docStatus: 'error',
        message: `Job failed: ${msg}`
      })
      return { jobId, factsCreated: totalFacts }
    } finally {
      this.activeJobs.delete(jobId)
    }
  }

  /**
   * Cancel an active ingestion job.
   */
  cancel(jobId: string): boolean {
    const controller = this.activeJobs.get(jobId)
    if (controller) {
      controller.abort()
      ingestionLog.info(`[cancel] Job ${jobId} cancelled`)
      return true
    }
    return false
  }

  /**
   * Cancel all active ingestion jobs.
   */
  cancelAll(): void {
    for (const [jobId, controller] of this.activeJobs) {
      controller.abort()
      ingestionLog.info(`[cancelAll] Job ${jobId} cancelled`)
    }
    this.activeJobs.clear()
  }

  /**
   * Check if any ingestion job is currently running.
   */
  get isRunning(): boolean {
    return this.activeJobs.size > 0
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async ingestSingleFile(
    filePath: string,
    workspaceId: string,
    workspacePath: string,
    docName: string,
    fileIndex: number,
    _fileCount: number,
    _jobId: string,
    signal: AbortSignal,
    emit: (partial: Partial<IngestionProgress> & { docIndex: number; docName: string }) => void
  ): Promise<number> {
    const docIndex = fileIndex + 1

    // 1. Check hash gate — skip unchanged files
    emit({ docIndex, docName, docStatus: 'reading', message: `Reading ${docName}...` })

    const readResult = await readDocument(filePath)
    if (!readResult.ok) {
      emit({
        docIndex,
        docName,
        docStatus: readResult.reason === 'binary_skip' ? 'skipped' : 'error',
        message: readResult.message
      })
      return 0
    }

    // Image files skip chunking — extraction is handled differently
    if (readResult.isImage) {
      emit({ docIndex, docName, docStatus: 'skipped', message: 'Image files — use vision extraction (not yet supported in batch)' })
      return 0
    }

    // Compute content hash
    const contentHash = createHash('sha256').update(readResult.content).digest('hex')

    // Check if already extracted with same hash
    const existingState = memoryFactRepository.getDocState(workspaceId, filePath)
    if (existingState && existingState.contentHash === contentHash) {
      emit({ docIndex, docName, docStatus: 'skipped', message: 'Unchanged since last ingestion' })
      return 0
    }

    // 2. Chunk the content
    if (signal.aborted) return 0

    emit({ docIndex, docName, docStatus: 'chunking', message: `Chunking ${docName}...` })

    const strategy = detectStrategy(filePath)
    const chunks = chunkDocument(readResult.content, strategy, docName)

    if (chunks.length === 0) {
      emit({ docIndex, docName, docStatus: 'skipped', message: 'No content to extract' })
      return 0
    }

    // 3. Extract facts from each chunk
    let factsFromDoc = 0

    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal.aborted) break

      const chunk = chunks[ci]
      emit({
        docIndex,
        docName,
        docStatus: 'extracting',
        chunkIndex: ci + 1,
        chunkCount: chunks.length,
        message: `Extracting chunk ${ci + 1}/${chunks.length}${chunk.breadcrumb ? ` (${chunk.breadcrumb})` : ''}`
      })

      try {
        // Prepend breadcrumb context to chunk content for better fact quality
        const contentWithContext = chunk.breadcrumb
          ? `[Context: ${chunk.breadcrumb}]\n\n${chunk.content}`
          : chunk.content

        const created = await memoryExtractionService.extractFromContent(
          workspaceId,
          workspacePath,
          docName,
          contentWithContext,
          // A rate-limit backoff holds a chunk for ~14s; without the extractor's
          // own status the panel freezes on "chunk 3/12" with no explanation.
          (p) =>
            emit({
              docIndex,
              docName,
              docStatus: 'extracting',
              chunkIndex: ci + 1,
              chunkCount: chunks.length,
              message: p.message
            }),
          // Without the signal a cancelled job keeps retrying — and keeps
          // spending the user's tokens — long after they hit Stop.
          { sourceType: 'document', tags: ['ingested'], signal }
        )
        factsFromDoc += created
      } catch (err) {
        ingestionLog.warn(`[ingestSingleFile] Chunk ${ci + 1} extraction failed for ${docName}:`, err)
      }
    }

    // 4. Update doc state hash
    memoryFactRepository.upsertDocState(workspaceId, filePath, contentHash)

    emit({
      docIndex,
      docName,
      docStatus: 'done',
      chunkIndex: chunks.length,
      chunkCount: chunks.length,
      message: `Done — ${factsFromDoc} memories from ${chunks.length} chunks`
    })

    ingestionLog.info(`[ingestSingleFile] ${docName}: ${factsFromDoc} facts from ${chunks.length} chunks`)
    return factsFromDoc
  }

  /**
   * Recursive directory walk with ignore list.
   */
  private walkDir(dirPath: string, files: string[], depth: number): void {
    if (depth > 10) return // prevent infinite recursion
    if (files.length >= MAX_FILES_PER_FOLDER * 2) return // stop early, will be truncated

    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return // permission denied, etc.
    }

    for (const entry of entries) {
      const entryLower = entry.toLowerCase()
      if (entry.startsWith('.') && IGNORE_DIRS.has(entryLower)) continue
      if (IGNORE_DIRS.has(entryLower)) continue

      const fullPath = join(dirPath, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        this.walkDir(fullPath, files, depth + 1)
      } else if (stat.isFile() && isSupportedExtension(fullPath)) {
        files.push(fullPath)
      }
    }
  }
}

export const memoryIngestionService = new MemoryIngestionService()

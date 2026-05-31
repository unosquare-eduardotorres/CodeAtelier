import { createHash } from 'node:crypto'
import log from 'electron-log/main'
import { getDatabase } from '../db/index'
import type { RawChunk } from './preprocessing.service'
import { buildEnvWithPath } from './env-utils'
import { modelConfigService } from './model-config.service'

const DESCRIPTION_PROMPT = `You are analyzing source code for a search index.
Write ONE sentence describing what this code does in plain English.
Focus on: what it does, what it returns, when it's used.
Do NOT include the function name or file path.
Keep it under 20 words.

Code:
{code}

One-sentence description:`

const BATCH_DESCRIPTION_PROMPT = `You are analyzing source code for a search index.
For EACH symbol below, write ONE sentence (under 20 words) describing what it does.
Focus on: what it does, what it returns, when it's used.
Do NOT include the function name or file path.
Format: one line per symbol, prefixed with the symbol number.

{symbols}

Descriptions (one per line, format "N: description"):`

/**
 * Service for caching AI-generated code descriptions.
 * Descriptions are keyed by sha256(filePath + symbolName + body) so they
 * are only regenerated when the code actually changes.
 *
 * Uses the main code-atelier.db `chunk_descriptions` table (unified storage).
 */
class DescriptionCacheService {
  /** Active workspace ID for scoping description writes */
  private activeWorkspaceId: string = 'default'

  /**
   * Set the active workspace ID for new description writes.
   */
  setWorkspaceId(workspaceId: string): void {
    this.activeWorkspaceId = workspaceId
  }

  /**
   * Generate a deterministic cache key from the chunk's identity + content.
   */
  makeKey(filePath: string, symbolName: string, body: string): string {
    return createHash('sha256')
      .update(filePath + symbolName + body)
      .digest('hex')
  }

  /**
   * Get a cached description by key. Returns null if not found.
   */
  get(key: string): string | null {
    const db = getDatabase()
    const row = db.prepare('SELECT description FROM chunk_descriptions WHERE key = ?').get(key) as
      | { description: string }
      | undefined
    return row?.description ?? null
  }

  /**
   * Store a description in the cache.
   * @param source — 'ai' for Claude-generated, 'heuristic' for pattern-based
   */
  set(
    key: string,
    description: string,
    model: string,
    filePath: string,
    symbolName: string,
    source: 'ai' | 'heuristic' = 'ai'
  ): void {
    const db = getDatabase()
    db.prepare(
      `INSERT OR REPLACE INTO chunk_descriptions (key, workspace_id, description, model, file_path, symbol_name, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(key, this.activeWorkspaceId, description, model, filePath, symbolName, source)
  }

  /**
   * Invalidate all cached descriptions for a given file path.
   * Called when a file is modified to force re-generation on next index.
   */
  invalidateFile(filePath: string): number {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM chunk_descriptions WHERE file_path = ?').run(filePath)
    return result.changes
  }

  /**
   * Get a cached description or generate a new one.
   * Returns the description string or undefined if generation fails.
   */
  async getOrGenerate(
    chunk: RawChunk,
    embedText: string,
    model: string,
    workspacePath?: string
  ): Promise<string | undefined> {
    const key = this.makeKey(chunk.filePath, chunk.symbolName, chunk.body)
    const cached = this.get(key)
    if (cached) return cached

    try {
      const description = await this.generateDescription(embedText, model, workspacePath)
      if (description) {
        this.set(key, description, model, chunk.filePath, chunk.symbolName)
        return description
      }
    } catch (error) {
      log.warn(`[DescriptionCache] Failed to generate description for ${chunk.symbolName}:`, error)
    }

    return undefined
  }

  /**
   * Generate a code description using Claude CLI one-shot.
   * Uses the same pattern as specialist execution: `claude -p` for one-shot.
   */
  private async generateDescription(
    code: string,
    model: string,
    workspacePath?: string
  ): Promise<string> {
    const { spawn } = await import('node:child_process')

    const prompt = DESCRIPTION_PROMPT.replace('{code}', code.slice(0, 800))
    const resolvedModel = model || modelConfigService.getModel(workspacePath ?? '.', 'haiku')

    return new Promise<string>((resolve, reject) => {
      const env = buildEnvWithPath()
      const args = ['-p', prompt, '--model', resolvedModel]

      const proc = spawn('claude', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Description generation failed (code ${code}): ${stderr}`))
        }
      })

      proc.on('error', reject)
    })
  }

  /**
   * Generate descriptions for multiple chunks in a single CLI call.
   * Returns a Map<batchIndex, description>.
   * ~10-20x faster than one call per chunk.
   */
  async generateBatch(
    chunks: Array<{ chunk: RawChunk; embedText: string }>,
    model: string,
    workspacePath?: string
  ): Promise<Map<number, string>> {
    const symbolBlocks = chunks
      .map((c, i) => `### Symbol ${i + 1}: ${c.chunk.symbolName}\n${c.embedText.slice(0, 400)}`)
      .join('\n\n')

    const prompt = BATCH_DESCRIPTION_PROMPT.replace('{symbols}', symbolBlocks)
    const output = await this.generateDescription(prompt, model, workspacePath)

    const results = new Map<number, string>()
    for (const line of output.split('\n')) {
      const match = line.match(/^(\d+):\s*(.+)/)
      if (match) {
        const idx = parseInt(match[1]) - 1
        if (idx >= 0 && idx < chunks.length) {
          results.set(idx, match[2].trim())
        }
      }
    }
    return results
  }

  /**
   * Get or generate descriptions for a batch of chunks.
   * Checks cache first, only generates for uncached chunks.
   * Returns descriptions keyed by original chunk index.
   * Also returns counts of cached vs generated for progress tracking.
   */
  async getOrGenerateBatch(
    chunks: Array<{ chunk: RawChunk; embedText: string }>,
    model: string,
    workspacePath?: string
  ): Promise<{ descriptions: Map<number, string>; cached: number; generated: number }> {
    const descriptions = new Map<number, string>()
    const uncached: Array<{ originalIndex: number; chunk: RawChunk; embedText: string }> = []
    let cached = 0

    // Check cache for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const { chunk } = chunks[i]
      const key = this.makeKey(chunk.filePath, chunk.symbolName, chunk.body)
      const cachedDesc = this.get(key)
      if (cachedDesc) {
        descriptions.set(i, cachedDesc)
        cached++
      } else {
        uncached.push({ originalIndex: i, ...chunks[i] })
      }
    }

    if (uncached.length === 0) return { descriptions, cached, generated: 0 }

    // Batch generate uncached descriptions
    let generated = 0
    try {
      const batchResults = await this.generateBatch(
        uncached.map((u) => ({ chunk: u.chunk, embedText: u.embedText })),
        model,
        workspacePath
      )

      // Cache and map back to original indices
      for (const [batchIdx, desc] of batchResults) {
        const item = uncached[batchIdx]
        const key = this.makeKey(item.chunk.filePath, item.chunk.symbolName, item.chunk.body)
        this.set(key, desc, model, item.chunk.filePath, item.chunk.symbolName, 'ai')
        descriptions.set(item.originalIndex, desc)
        generated++
      }
    } catch (error) {
      log.warn('[DescriptionCache] Batch generation failed:', error)
    }

    return { descriptions, cached, generated }
  }

  /**
   * Get the total count of cached descriptions.
   */
  getCount(): number {
    const db = getDatabase()
    const row = db.prepare('SELECT COUNT(*) as count FROM chunk_descriptions').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Count descriptions by source type for a workspace.
   */
  getCountBySource(workspaceId: string): { ai: number; heuristic: number; total: number } {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT source, COUNT(*) as count FROM chunk_descriptions
         WHERE workspace_id = ? GROUP BY source`
      )
      .all(workspaceId) as Array<{ source: string; count: number }>

    let ai = 0
    let heuristic = 0
    for (const row of rows) {
      if (row.source === 'ai') ai = row.count
      else if (row.source === 'heuristic') heuristic = row.count
    }
    return { ai, heuristic, total: ai + heuristic }
  }

  /**
   * Get all heuristic-only description keys for a workspace.
   * Used by the background AI enrichment phase to selectively upgrade.
   */
  getHeuristicKeys(
    workspaceId: string,
    limit: number = 100
  ): Array<{ key: string; filePath: string; symbolName: string }> {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT key, file_path as filePath, symbol_name as symbolName
         FROM chunk_descriptions
         WHERE workspace_id = ? AND source = 'heuristic'
         LIMIT ?`
      )
      .all(workspaceId, limit) as Array<{
      key: string
      filePath: string
      symbolName: string
    }>
  }

  /**
   * Clean up — no-op since we use the shared main database.
   */
  dispose(): void {
    // No separate connection to close — uses the shared getDatabase()
  }
}

export const descriptionCache = new DescriptionCacheService()

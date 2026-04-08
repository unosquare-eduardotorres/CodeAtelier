import { getDatabase } from '../index'
import type { ProcessedChunk, ChunkMetadata } from '../../services/preprocessing.service'

interface CodeChunkRow {
  id: string
  workspace_id: string
  file_path: string
  file_name: string
  directory: string
  symbol_name: string
  symbol_kind: string
  class_name: string | null
  signature: string
  start_line: number
  end_line: number
  language: string
  body: string
  embed_text: string
  is_public: number
  is_async: number
  has_docstring: number
  line_count: number
  file_mtime: number
  indexed_at: string
}

/**
 * Repository for the `code_chunks` table.
 * Stores preprocessed code units for semantic search indexing.
 */
export class CodeChunkRepository {
  /**
   * Bulk upsert preprocessed chunks for a workspace.
   * Uses INSERT OR REPLACE to update existing chunks when code changes.
   */
  upsertChunks(
    workspaceId: string,
    chunks: ProcessedChunk[],
    fileMtimes: Map<string, number>
  ): void {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO code_chunks
        (id, workspace_id, file_path, file_name, directory, symbol_name, symbol_kind,
         class_name, signature, start_line, end_line, language, body, embed_text,
         is_public, is_async, has_docstring, line_count, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = db.transaction(() => {
      for (const chunk of chunks) {
        const m = chunk.metadata
        const mtime = fileMtimes.get(m.filePath) ?? 0
        stmt.run(
          chunk.id,
          workspaceId,
          m.filePath,
          m.fileName,
          m.directory,
          m.symbolName,
          m.symbolKind,
          m.className,
          m.signature,
          m.startLine,
          m.endLine,
          m.language,
          chunk.body,
          chunk.embedText,
          m.isPublic ? 1 : 0,
          m.isAsync ? 1 : 0,
          m.hasDocstring ? 1 : 0,
          m.lineCount,
          mtime
        )
      }
    })

    transaction()
  }

  /**
   * Load all chunks for a workspace, reconstructing ProcessedChunk objects.
   */
  findByWorkspace(workspaceId: string): ProcessedChunk[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM code_chunks WHERE workspace_id = ?')
      .all(workspaceId) as CodeChunkRow[]
    return rows.map(mapRowToChunk)
  }

  /**
   * Load chunks for a single file in a workspace.
   */
  findByFile(workspaceId: string, filePath: string): ProcessedChunk[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM code_chunks WHERE workspace_id = ? AND file_path = ?')
      .all(workspaceId, filePath) as CodeChunkRow[]
    return rows.map(mapRowToChunk)
  }

  /**
   * Remove all chunks for a specific file (used when file changes or is deleted).
   */
  deleteByFile(workspaceId: string, filePath: string): number {
    const db = getDatabase()
    const result = db
      .prepare('DELETE FROM code_chunks WHERE workspace_id = ? AND file_path = ?')
      .run(workspaceId, filePath)
    return result.changes
  }

  /**
   * Clear the entire workspace index.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM code_chunks WHERE workspace_id = ?').run(workspaceId)
    return result.changes
  }

  /**
   * Get file modification times for all indexed files.
   * Used for incremental indexing: compare DB mtimes with filesystem mtimes.
   */
  getFileMtimes(workspaceId: string): Map<string, number> {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT DISTINCT file_path, file_mtime FROM code_chunks WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ file_path: string; file_mtime: number }>

    const result = new Map<string, number>()
    for (const row of rows) {
      result.set(row.file_path, row.file_mtime)
    }
    return result
  }

  /**
   * Count total chunks for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM code_chunks WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }
}

function mapRowToChunk(row: CodeChunkRow): ProcessedChunk {
  const metadata: ChunkMetadata = {
    filePath: row.file_path,
    fileName: row.file_name,
    directory: row.directory,
    projectName: '',
    symbolName: row.symbol_name,
    symbolKind: row.symbol_kind,
    className: row.class_name,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
    language: row.language,
    isPublic: row.is_public === 1,
    isAsync: row.is_async === 1,
    isStatic: false,
    isAbstract: false,
    hasTests: false,
    importedBy: [],
    pageRank: 0,
    hasDocstring: row.has_docstring === 1,
    lineCount: row.line_count,
    hasDescription: false,
    lastModified: 0,
    indexedAt: Date.now()
  }

  return {
    id: row.id,
    embedText: row.embed_text,
    body: row.body,
    metadata
  }
}

export const codeChunkRepository = new CodeChunkRepository()

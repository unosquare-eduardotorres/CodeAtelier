import { getDatabase } from '../index'

interface EmbeddingRow {
  chunk_id: string
  workspace_id: string
  embedding: Buffer
  model: string
  created_at: string
}

/**
 * Serialize a number[] embedding to a Buffer for SQLite BLOB storage.
 * 768 floats x 4 bytes = 3,072 bytes per vector.
 */
export function serializeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

/**
 * Deserialize a SQLite BLOB Buffer back to a number[] embedding.
 */
export function deserializeEmbedding(blob: Buffer): number[] {
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
}

export interface EmbeddingEntry {
  chunkId: string
  embedding: number[]
  model: string
}

/**
 * Repository for the `chunk_embeddings` table.
 * Persists vector embeddings as BLOBs for fast reload on app restart.
 */
export class ChunkEmbeddingRepository {
  /**
   * Bulk upsert embeddings for a workspace.
   */
  upsertEmbeddings(workspaceId: string, entries: EmbeddingEntry[]): void {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, workspace_id, embedding, model)
      VALUES (?, ?, ?, ?)
    `)

    const transaction = db.transaction(() => {
      for (const entry of entries) {
        stmt.run(entry.chunkId, workspaceId, serializeEmbedding(entry.embedding), entry.model)
      }
    })

    transaction()
  }

  /**
   * Load all embeddings for a workspace.
   * Returns chunk IDs paired with their deserialized embedding vectors.
   */
  loadAllForWorkspace(workspaceId: string): Array<{ chunkId: string; embedding: number[]; model: string }> {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT chunk_id, embedding, model FROM chunk_embeddings WHERE workspace_id = ?')
      .all(workspaceId) as EmbeddingRow[]

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      embedding: deserializeEmbedding(row.embedding),
      model: row.model
    }))
  }

  /**
   * Delete all embeddings for a workspace.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const result = db
      .prepare('DELETE FROM chunk_embeddings WHERE workspace_id = ?')
      .run(workspaceId)
    return result.changes
  }

  /**
   * Quick check whether persisted embeddings exist for a workspace.
   */
  hasEmbeddings(workspaceId: string): boolean {
    const db = getDatabase()
    const row = db
      .prepare(
        'SELECT 1 FROM chunk_embeddings WHERE workspace_id = ? LIMIT 1'
      )
      .get(workspaceId)
    return !!row
  }

  /**
   * Count total embeddings for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM chunk_embeddings WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }
}

export const chunkEmbeddingRepository = new ChunkEmbeddingRepository()

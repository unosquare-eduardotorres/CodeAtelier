import { getDatabase } from '../index'

/**
 * Repository for the `code_graph_ranks` table.
 * Stores pre-computed PageRank scores per file for instant lookups
 * during repo_map generation and decompose() file ranking.
 */
export class CodeGraphRankRepository {
  /**
   * Bulk upsert PageRank scores for a workspace.
   * Replaces all existing ranks atomically.
   */
  upsertRanks(workspaceId: string, ranks: Map<string, number>): void {
    const db = getDatabase()

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM code_graph_ranks WHERE workspace_id = ?').run(workspaceId)

      const stmt = db.prepare(`
        INSERT INTO code_graph_ranks (workspace_id, rel_fname, page_rank)
        VALUES (?, ?, ?)
      `)

      for (const [relFname, rank] of ranks) {
        stmt.run(workspaceId, relFname, rank)
      }
    })

    transaction()
  }

  /**
   * Get all PageRank scores for a workspace.
   */
  findByWorkspace(workspaceId: string): Map<string, number> {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT rel_fname, page_rank FROM code_graph_ranks WHERE workspace_id = ?')
      .all(workspaceId) as { rel_fname: string; page_rank: number }[]

    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.rel_fname, row.page_rank)
    }
    return map
  }

  /**
   * Get the PageRank score for a specific file.
   */
  getRank(workspaceId: string, relFname: string): number {
    const db = getDatabase()
    const row = db
      .prepare(
        'SELECT page_rank FROM code_graph_ranks WHERE workspace_id = ? AND rel_fname = ?'
      )
      .get(workspaceId, relFname) as { page_rank: number } | undefined
    return row?.page_rank ?? 0
  }

  /**
   * Delete all ranks for a workspace.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const result = db
      .prepare('DELETE FROM code_graph_ranks WHERE workspace_id = ?')
      .run(workspaceId)
    return result.changes
  }

  /**
   * Count total ranked files for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM code_graph_ranks WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }

  /**
   * Get top-ranked files for a workspace, ordered by PageRank descending.
   */
  getTopRanked(workspaceId: string, limit: number): string[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT rel_fname FROM code_graph_ranks WHERE workspace_id = ? ORDER BY page_rank DESC LIMIT ?'
      )
      .all(workspaceId, limit) as { rel_fname: string }[]
    return rows.map((r) => r.rel_fname)
  }
}

export const codeGraphRankRepository = new CodeGraphRankRepository()

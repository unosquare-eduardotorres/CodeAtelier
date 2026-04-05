import { getDatabase } from '../index'

export type EdgeType = 'calls' | 'imports' | 'extends' | 'implements' | 'references'

export interface CodeGraphEdge {
  id?: string
  workspaceId: string
  sourceFile: string
  sourceSymbol: string
  targetFile: string
  targetSymbol: string
  edgeType: EdgeType
  pageRank?: number
}

interface EdgeRow {
  id: string
  workspace_id: string
  source_file: string
  source_symbol: string
  target_file: string
  target_symbol: string
  edge_type: string
  page_rank: number | null
  created_at: string
}

function mapRow(row: EdgeRow): CodeGraphEdge {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceFile: row.source_file,
    sourceSymbol: row.source_symbol,
    targetFile: row.target_file,
    targetSymbol: row.target_symbol,
    edgeType: row.edge_type as EdgeType,
    pageRank: row.page_rank ?? 0
  }
}

/**
 * Repository for the `code_graph_edges` table.
 * Caches symbol relationships computed by repomap / tree-sitter analysis.
 */
export class CodeGraphEdgeRepository {
  /**
   * Bulk upsert graph edges for a workspace.
   * Clears existing edges first, then inserts new ones.
   */
  upsertEdges(workspaceId: string, edges: CodeGraphEdge[]): void {
    const db = getDatabase()

    const transaction = db.transaction(() => {
      // Clear existing edges for workspace
      db.prepare('DELETE FROM code_graph_edges WHERE workspace_id = ?').run(workspaceId)

      const stmt = db.prepare(`
        INSERT INTO code_graph_edges
          (workspace_id, source_file, source_symbol, target_file, target_symbol, edge_type, page_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const edge of edges) {
        stmt.run(
          workspaceId,
          edge.sourceFile,
          edge.sourceSymbol,
          edge.targetFile,
          edge.targetSymbol,
          edge.edgeType,
          edge.pageRank ?? 0
        )
      }
    })

    transaction()
  }

  /**
   * Get all edges for a workspace.
   */
  findByWorkspace(workspaceId: string): CodeGraphEdge[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM code_graph_edges WHERE workspace_id = ?')
      .all(workspaceId) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Find all edges where the given symbol is the target (i.e., who calls/references it).
   */
  findCallersOf(workspaceId: string, targetSymbol: string): CodeGraphEdge[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM code_graph_edges WHERE workspace_id = ? AND target_symbol = ?'
      )
      .all(workspaceId, targetSymbol) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Find all edges where the given symbol is the source (i.e., what does it call/reference).
   */
  findCalleesOf(workspaceId: string, sourceSymbol: string): CodeGraphEdge[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM code_graph_edges WHERE workspace_id = ? AND source_symbol = ?'
      )
      .all(workspaceId, sourceSymbol) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Delete all edges for a workspace.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const result = db
      .prepare('DELETE FROM code_graph_edges WHERE workspace_id = ?')
      .run(workspaceId)
    return result.changes
  }

  /**
   * Count total edges for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM code_graph_edges WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }
}

export const codeGraphEdgeRepository = new CodeGraphEdgeRepository()

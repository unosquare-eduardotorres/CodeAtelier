import { BaseRepository } from '../base-repository'

/**
 * MCP-06: Escape SQL LIKE wildcard characters in user-supplied path values.
 * Without this, a path containing '%' or '_' would match more broadly than intended.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

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
export class CodeGraphEdgeRepository extends BaseRepository<EdgeRow, CodeGraphEdge> {
  protected readonly tableName = 'code_graph_edges'
  protected mapRow(row: EdgeRow): CodeGraphEdge {
    return mapRow(row)
  }

  /**
   * Bulk upsert graph edges for a workspace.
   * Clears existing edges first, then inserts new ones.
   */
  upsertEdges(workspaceId: string, edges: CodeGraphEdge[]): void {
    const db = this.db()

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
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM code_graph_edges WHERE workspace_id = ?')
      .all(workspaceId) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Find all edges where the given symbol is the target (i.e., who calls/references it).
   */
  findCallersOf(workspaceId: string, targetSymbol: string): CodeGraphEdge[] {
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM code_graph_edges WHERE workspace_id = ? AND target_symbol = ?')
      .all(workspaceId, targetSymbol) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Find all edges where the given symbol is the source (i.e., what does it call/reference).
   */
  findCalleesOf(workspaceId: string, sourceSymbol: string): CodeGraphEdge[] {
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM code_graph_edges WHERE workspace_id = ? AND source_symbol = ?')
      .all(workspaceId, sourceSymbol) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Delete all edges for a workspace.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = this.db()
    const result = db
      .prepare('DELETE FROM code_graph_edges WHERE workspace_id = ?')
      .run(workspaceId)
    return result.changes
  }

  /**
   * Find files that a given file depends on, grouped by edge type.
   * (SELECT DISTINCT target_file, edge_type WHERE source_file = ?)
   */
  findDependenciesOf(
    workspaceId: string,
    sourceFile: string
  ): { targetFile: string; edgeType: EdgeType }[] {
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT DISTINCT target_file, edge_type
         FROM code_graph_edges
         WHERE workspace_id = ? AND source_file = ?
         ORDER BY edge_type, target_file`
      )
      .all(workspaceId, sourceFile) as { target_file: string; edge_type: string }[]
    return rows.map((r) => ({
      targetFile: r.target_file,
      edgeType: r.edge_type as EdgeType
    }))
  }

  /**
   * Find files that depend on a given file (blast radius), grouped by edge type.
   * (SELECT DISTINCT source_file, edge_type WHERE target_file = ?)
   */
  findDependentsOf(
    workspaceId: string,
    targetFile: string
  ): { sourceFile: string; edgeType: EdgeType }[] {
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT DISTINCT source_file, edge_type
         FROM code_graph_edges
         WHERE workspace_id = ? AND target_file = ?
         ORDER BY edge_type, source_file`
      )
      .all(workspaceId, targetFile) as { source_file: string; edge_type: string }[]
    return rows.map((r) => ({
      sourceFile: r.source_file,
      edgeType: r.edge_type as EdgeType
    }))
  }

  /**
   * Count total edges for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = this.db()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM code_graph_edges WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }

  /**
   * Find file pairs ranked by coupling strength (number of cross-references).
   */
  findCoupledFiles(
    workspaceId: string,
    opts?: { minCoupling?: number; path?: string; maxResults?: number }
  ): { sourceFile: string; targetFile: string; edgeCount: number }[] {
    const db = this.db()
    const minCoupling = opts?.minCoupling ?? 2
    const maxResults = opts?.maxResults ?? 50
    // MCP-06: Escape LIKE wildcards in user-supplied path
    const pathFilter = opts?.path
      ? `AND (source_file LIKE ? || '%' ESCAPE '\\' OR target_file LIKE ? || '%' ESCAPE '\\')`
      : ''
    const params: (string | number)[] = [workspaceId]
    if (opts?.path) {
      const escapedPath = escapeLikePattern(opts.path)
      params.push(escapedPath, escapedPath)
    }
    params.push(minCoupling, maxResults)

    const rows = db
      .prepare(
        `SELECT source_file, target_file, COUNT(*) as edge_count
         FROM code_graph_edges
         WHERE workspace_id = ? AND source_file != target_file
         ${pathFilter}
         GROUP BY source_file, target_file
         HAVING edge_count >= ?
         ORDER BY edge_count DESC
         LIMIT ?`
      )
      .all(...params) as { source_file: string; target_file: string; edge_count: number }[]
    return rows.map((r) => ({
      sourceFile: r.source_file,
      targetFile: r.target_file,
      edgeCount: r.edge_count
    }))
  }

  /**
   * Get module boundary health metrics — counts intra-module vs cross-module edges.
   * Module boundaries determined by directory depth.
   */
  getModuleBoundaryMetrics(
    workspaceId: string,
    depth: number = 2
  ): { module: string; internal: number; external: number; ratio: number }[] {
    // Compute module prefixes in JS from the raw edges — simpler than complex SQL substr
    const edges = this.findByWorkspace(workspaceId)

    const getModule = (filePath: string): string => {
      const parts = filePath.split('/')
      return parts.slice(0, Math.min(depth, parts.length)).join('/')
    }

    // Count per-module internal and external edges
    const moduleCounts = new Map<string, { internal: number; external: number }>()

    for (const edge of edges) {
      const srcMod = getModule(edge.sourceFile)
      const tgtMod = getModule(edge.targetFile)
      const entry = moduleCounts.get(srcMod) ?? { internal: 0, external: 0 }
      if (srcMod === tgtMod) {
        entry.internal++
      } else {
        entry.external++
      }
      moduleCounts.set(srcMod, entry)
    }

    return Array.from(moduleCounts.entries())
      .map(([module, counts]) => ({
        module,
        internal: counts.internal,
        external: counts.external,
        ratio:
          counts.internal + counts.external > 0
            ? Math.round((counts.internal / (counts.internal + counts.external)) * 100) / 100
            : 0
      }))
      .sort((a, b) => a.ratio - b.ratio) // worst cohesion first
  }

  /**
   * BFS-based transitive blast radius — finds ALL files transitively affected
   * by changing the given file, with depth tracking.
   * Unlike findDependentsOf (direct only), this follows the reverse import graph
   * to the full transitive closure.
   */
  findTransitiveDependents(
    workspaceId: string,
    filePath: string,
    maxDepth: number = 5
  ): { file: string; depth: number }[] {
    const db = this.db()
    const stmt = db.prepare(
      `SELECT DISTINCT source_file
       FROM code_graph_edges
       WHERE workspace_id = ? AND target_file = ? AND source_file != target_file`
    )

    const visited = new Set<string>([filePath])
    const result: { file: string; depth: number }[] = []
    let frontier = [filePath]

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = []
      for (const file of frontier) {
        const rows = stmt.all(workspaceId, file) as { source_file: string }[]
        for (const row of rows) {
          if (!visited.has(row.source_file)) {
            visited.add(row.source_file)
            result.push({ file: row.source_file, depth })
            nextFrontier.push(row.source_file)
          }
        }
      }
      frontier = nextFrontier
    }

    return result
  }
}

export const codeGraphEdgeRepository = new CodeGraphEdgeRepository()

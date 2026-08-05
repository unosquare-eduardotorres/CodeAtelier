import { BaseRepository } from '../base-repository'

/**
 * MCP-06: Escape SQL LIKE wildcard characters in user-supplied path values.
 * Without this, a path containing '%' or '_' would match more broadly than intended.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

export type EdgeType = 'calls' | 'imports' | 'extends' | 'implements' | 'references'

/**
 * How confidently a reference was matched to its definition.
 *  - 'extracted'  — exactly one definition carries this name: unambiguous
 *  - 'inferred'   — several candidate definitions; the edge is one of N guesses
 *  - 'ambiguous'  — fan-out above AMBIGUITY_THRESHOLD (utility-name explosion)
 * Enforced in TypeScript, not by a SQL CHECK (see migration v130).
 */
export type EdgeResolution = 'extracted' | 'inferred' | 'ambiguous'

export interface CodeGraphEdge {
  id?: string
  workspaceId: string
  sourceFile: string
  sourceSymbol: string
  targetFile: string
  targetSymbol: string
  edgeType: EdgeType
  pageRank?: number
  resolution?: EdgeResolution
  /** Number of definition sites that carried this symbol name. */
  defFanout?: number
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
  resolution: string | null
  def_fanout: number | null
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
    pageRank: row.page_rank ?? 0,
    resolution: (row.resolution as EdgeResolution) ?? 'inferred',
    defFanout: row.def_fanout ?? 1
  }
}

/**
 * Sort key so unambiguous edges are presented to the model first.
 * 'extracted' (1 definition) ≻ 'inferred' (N candidates) ≻ 'ambiguous'.
 */
export function resolutionRank(resolution: EdgeResolution | undefined): number {
  return resolution === 'extracted' ? 0 : resolution === 'inferred' ? 1 : 2
}

/** Order edges most-trustworthy first: resolution, then smaller fan-out. */
export function sortByResolution<T extends CodeGraphEdge>(edges: T[]): T[] {
  return [...edges].sort(
    (a, b) =>
      resolutionRank(a.resolution) - resolutionRank(b.resolution) ||
      (a.defFanout ?? 1) - (b.defFanout ?? 1)
  )
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
   * Clears existing edges first, then inserts new ones in a single transaction.
   *
   * For large edge sets, prefer `upsertEdgesBatched()` which breaks the work
   * into chunks with event-loop yielding to keep the UI responsive.
   */
  upsertEdges(workspaceId: string, edges: CodeGraphEdge[]): void {
    const db = this.db()

    const transaction = db.transaction(() => {
      // Clear existing edges for workspace
      db.prepare('DELETE FROM code_graph_edges WHERE workspace_id = ?').run(workspaceId)

      const stmt = db.prepare(`
        INSERT INTO code_graph_edges
          (workspace_id, source_file, source_symbol, target_file, target_symbol, edge_type,
           page_rank, resolution, def_fanout)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const edge of edges) {
        stmt.run(
          workspaceId,
          edge.sourceFile,
          edge.sourceSymbol,
          edge.targetFile,
          edge.targetSymbol,
          edge.edgeType,
          edge.pageRank ?? 0,
          edge.resolution ?? 'inferred',
          edge.defFanout ?? 1
        )
      }
    })

    transaction()
  }

  /**
   * Batched upsert with event-loop yielding between chunks.
   * Prevents multi-second main-thread freezes for large workspaces
   * (e.g. 5.5M edges). DELETE runs in one fast statement, then INSERTs
   * are chunked into transactions of BATCH_SIZE rows with setImmediate()
   * yields between each batch to let the event loop pump the Windows
   * message queue and keep the UI responsive.
   */
  async upsertEdgesBatched(workspaceId: string, edges: CodeGraphEdge[]): Promise<void> {
    const BATCH_SIZE = 5000
    const db = this.db()

    const deleteStmt = db.prepare('DELETE FROM code_graph_edges WHERE workspace_id = ?')
    const insertStmt = db.prepare(`
      INSERT INTO code_graph_edges
        (workspace_id, source_file, source_symbol, target_file, target_symbol, edge_type,
         page_rank, resolution, def_fanout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
      const batch = edges.slice(i, Math.min(i + BATCH_SIZE, edges.length))
      const txn = db.transaction(() => {
        // DELETE runs inside the first batch's transaction so that if the
        // process crashes mid-batch, we either keep the old edges (rolled
        // back) or have at least the first batch committed. Without this,
        // a crash after a standalone DELETE leaves zero edges.
        if (i === 0) {
          deleteStmt.run(workspaceId)
        }
        for (const edge of batch) {
          insertStmt.run(
            workspaceId,
            edge.sourceFile,
            edge.sourceSymbol,
            edge.targetFile,
            edge.targetSymbol,
            edge.edgeType,
            edge.pageRank ?? 0,
            edge.resolution ?? 'inferred',
            edge.defFanout ?? 1
          )
        }
      })
      txn()

      // Yield to the event loop between batches so the UI stays responsive.
      // setImmediate fires after I/O events, giving the message pump a chance.
      if (i + BATCH_SIZE < edges.length) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    // Handle edge case: no edges to insert (empty graph).
    // Still need to clear old edges.
    if (edges.length === 0) {
      deleteStmt.run(workspaceId)
    }
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
  findCallersOf(
    workspaceId: string,
    targetSymbol: string,
    opts?: { edgeTypes?: EdgeType[] }
  ): CodeGraphEdge[] {
    const db = this.db()
    const params: string[] = [workspaceId, targetSymbol]
    let typeFilter = ''
    if (opts?.edgeTypes && opts.edgeTypes.length > 0) {
      typeFilter = `AND edge_type IN (${opts.edgeTypes.map(() => '?').join(', ')})`
      params.push(...opts.edgeTypes)
    }
    const rows = db
      .prepare(
        `SELECT * FROM code_graph_edges
         WHERE workspace_id = ? AND target_symbol = ? ${typeFilter}`
      )
      .all(...params) as EdgeRow[]
    return rows.map(mapRow)
  }

  /**
   * Find all edges where the given symbol is the source (i.e., what does it call/reference).
   */
  findCalleesOf(
    workspaceId: string,
    sourceSymbol: string,
    opts?: { edgeTypes?: EdgeType[] }
  ): CodeGraphEdge[] {
    const db = this.db()
    const params: string[] = [workspaceId, sourceSymbol]
    let typeFilter = ''
    if (opts?.edgeTypes && opts.edgeTypes.length > 0) {
      typeFilter = `AND edge_type IN (${opts.edgeTypes.map(() => '?').join(', ')})`
      params.push(...opts.edgeTypes)
    }
    const rows = db
      .prepare(
        `SELECT * FROM code_graph_edges
         WHERE workspace_id = ? AND source_symbol = ? ${typeFilter}`
      )
      .all(...params) as EdgeRow[]
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
   * Collapse the edge table into distinct file→file pairs with weights.
   *
   * Subsystem detection needs the shape of the graph, not every edge: on a large
   * workspace this turns millions of rows into tens of thousands of pairs inside
   * SQLite instead of loading them all into JS.
   */
  findFilePairs(
    workspaceId: string,
    opts?: { maxPairs?: number }
  ): { sourceFile: string; targetFile: string; edgeCount: number }[] {
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT source_file, target_file, COUNT(*) AS edge_count
         FROM code_graph_edges
         WHERE workspace_id = ? AND source_file != target_file
         GROUP BY source_file, target_file
         ORDER BY edge_count DESC
         LIMIT ?`
      )
      .all(workspaceId, opts?.maxPairs ?? 100_000) as {
      source_file: string
      target_file: string
      edge_count: number
    }[]
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

  /**
   * Shortest dependency path between two files, via bidirectional BFS.
   *
   * Answers "how does A reach B?" — the traversal primitive the graph lacked.
   * Searches forward from `fromFile` and backward from `toFile` one level at a
   * time and stops at the meeting point, which explores dramatically fewer
   * nodes than one-directional BFS on a graph this dense.
   *
   * Returns `null` when no path exists within `maxDepth` hops. Each hop carries
   * the symbol, edge type and resolution so callers can judge how much to trust it.
   */
  findShortestPath(
    workspaceId: string,
    fromFile: string,
    toFile: string,
    maxDepth: number = 6
  ): {
    path: string[]
    hops: {
      from: string
      to: string
      symbol: string
      edgeType: EdgeType
      resolution: EdgeResolution
    }[]
  } | null {
    if (fromFile === toFile) return { path: [fromFile], hops: [] }

    const db = this.db()
    const forwardStmt = db.prepare(
      `SELECT DISTINCT target_file AS next FROM code_graph_edges
       WHERE workspace_id = ? AND source_file = ? AND source_file != target_file`
    )
    const backwardStmt = db.prepare(
      `SELECT DISTINCT source_file AS next FROM code_graph_edges
       WHERE workspace_id = ? AND target_file = ? AND source_file != target_file`
    )

    // parent maps: node → the node it was reached from on that side
    const fromParents = new Map<string, string | null>([[fromFile, null]])
    const toParents = new Map<string, string | null>([[toFile, null]])
    let fromFrontier = [fromFile]
    let toFrontier = [toFile]
    let meeting: string | null = null

    const expand = (
      frontier: string[],
      parents: Map<string, string | null>,
      otherParents: Map<string, string | null>,
      stmt: typeof forwardStmt
    ): string[] => {
      const next: string[] = []
      for (const node of frontier) {
        const rows = stmt.all(workspaceId, node) as { next: string }[]
        for (const row of rows) {
          if (parents.has(row.next)) continue
          parents.set(row.next, node)
          if (otherParents.has(row.next)) {
            meeting = row.next
            return next
          }
          next.push(row.next)
        }
      }
      return next
    }

    for (let depth = 0; depth < maxDepth && meeting === null; depth++) {
      // Always expand the smaller frontier — keeps the search balanced.
      if (fromFrontier.length <= toFrontier.length) {
        fromFrontier = expand(fromFrontier, fromParents, toParents, forwardStmt)
      } else {
        toFrontier = expand(toFrontier, toParents, fromParents, backwardStmt)
      }
      if (fromFrontier.length === 0 && toFrontier.length === 0) break
    }

    if (meeting === null) return null

    // Walk both parent chains outward from the meeting point
    const head: string[] = []
    for (let n: string | null | undefined = meeting; n != null; n = fromParents.get(n)) {
      head.unshift(n)
    }
    const tail: string[] = []
    let node: string | null | undefined = toParents.get(meeting)
    while (node != null) {
      tail.push(node)
      node = toParents.get(node)
    }
    const path = [...head, ...tail]

    // Annotate each hop with its most trustworthy edge
    const hopStmt = db.prepare(
      `SELECT source_symbol, edge_type, resolution, def_fanout FROM code_graph_edges
       WHERE workspace_id = ? AND source_file = ? AND target_file = ?`
    )
    const hops: {
      from: string
      to: string
      symbol: string
      edgeType: EdgeType
      resolution: EdgeResolution
    }[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const rows = hopStmt.all(workspaceId, path[i], path[i + 1]) as {
        source_symbol: string
        edge_type: string
        resolution: string | null
        def_fanout: number | null
      }[]
      const best = rows.sort(
        (a, b) =>
          resolutionRank((a.resolution as EdgeResolution) ?? 'inferred') -
            resolutionRank((b.resolution as EdgeResolution) ?? 'inferred') ||
          (a.def_fanout ?? 1) - (b.def_fanout ?? 1)
      )[0]
      hops.push({
        from: path[i],
        to: path[i + 1],
        symbol: best?.source_symbol ?? '',
        edgeType: (best?.edge_type as EdgeType) ?? 'references',
        resolution: (best?.resolution as EdgeResolution) ?? 'inferred'
      })
    }

    return { path, hops }
  }
}

export const codeGraphEdgeRepository = new CodeGraphEdgeRepository()

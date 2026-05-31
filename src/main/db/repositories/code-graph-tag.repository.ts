import { BaseRepository } from '../base-repository'

interface CodeGraphTagRow {
  id: number
  workspace_id: string
  rel_fname: string
  fname: string
  line: number
  name: string
  kind: 'def' | 'ref'
  file_mtime: number
  indexed_at: string
}

export interface RepomapTag {
  relFname: string
  fname: string
  line: number
  name: string
  kind: 'def' | 'ref'
}

/**
 * Repository for the `code_graph_tags` table.
 * Stores raw Tree-sitter tags (definitions + references) for incremental re-indexing
 * and for `search_identifiers` queries against the persisted code graph.
 */
export class CodeGraphTagRepository extends BaseRepository<CodeGraphTagRow, RepomapTag> {
  protected readonly tableName = 'code_graph_tags'
  protected mapRow(row: CodeGraphTagRow): RepomapTag { return mapRowToTag(row) }

  /**
   * Bulk upsert tags for a workspace. Deletes stale files first,
   * then inserts/replaces tags grouped by file.
   */
  upsertTags(workspaceId: string, tags: RepomapTag[], fileMtimes: Map<string, number>): void {
    const db = this.db()

    const transaction = db.transaction(() => {
      // Group tags by file for batch delete + insert
      const fileSet = new Set(tags.map((t) => t.relFname))

      // Delete existing tags for files that have new tags
      const deleteStmt = db.prepare(
        'DELETE FROM code_graph_tags WHERE workspace_id = ? AND rel_fname = ?'
      )
      for (const relFname of fileSet) {
        deleteStmt.run(workspaceId, relFname)
      }

      // Insert all new tags
      const insertStmt = db.prepare(`
        INSERT INTO code_graph_tags (workspace_id, rel_fname, fname, line, name, kind, file_mtime)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const tag of tags) {
        const mtime = fileMtimes.get(tag.relFname) ?? 0
        insertStmt.run(workspaceId, tag.relFname, tag.fname, tag.line, tag.name, tag.kind, mtime)
      }
    })

    transaction()
  }

  /**
   * Get all definition tags for a workspace (used for edge graph building).
   */
  findDefsByWorkspace(workspaceId: string): RepomapTag[] {
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT rel_fname, fname, line, name, kind FROM code_graph_tags
         WHERE workspace_id = ? AND kind = 'def'`
      )
      .all(workspaceId) as CodeGraphTagRow[]
    return rows.map(mapRowToTag)
  }

  /**
   * Get all tags for a specific file (used when loading cached tags for unchanged files).
   */
  findByFile(workspaceId: string, relFname: string): RepomapTag[] {
    const db = this.db()
    const rows = db
      .prepare(
        'SELECT rel_fname, fname, line, name, kind FROM code_graph_tags WHERE workspace_id = ? AND rel_fname = ?'
      )
      .all(workspaceId, relFname) as CodeGraphTagRow[]
    return rows.map(mapRowToTag)
  }

  /**
   * Search tags by identifier name (case-insensitive substring match).
   */
  searchByName(
    workspaceId: string,
    query: string,
    opts?: {
      maxResults?: number
      includeDefinitions?: boolean
      includeReferences?: boolean
    }
  ): RepomapTag[] {
    const db = this.db()
    const maxResults = opts?.maxResults ?? 50
    const includeDefs = opts?.includeDefinitions ?? true
    const includeRefs = opts?.includeReferences ?? true

    const kindFilter =
      includeDefs && includeRefs
        ? ''
        : includeDefs
          ? "AND kind = 'def'"
          : includeRefs
            ? "AND kind = 'ref'"
            : 'AND 1 = 0'

    const rows = db
      .prepare(
        `SELECT rel_fname, fname, line, name, kind FROM code_graph_tags
         WHERE workspace_id = ? AND name LIKE ? ${kindFilter}
         ORDER BY kind ASC, rel_fname ASC
         LIMIT ?`
      )
      .all(workspaceId, `%${query}%`, maxResults) as CodeGraphTagRow[]
    return rows.map(mapRowToTag)
  }

  /**
   * Get file mtimes for incremental indexing comparison.
   */
  getFileMtimes(workspaceId: string): Map<string, number> {
    const db = this.db()
    const rows = db
      .prepare('SELECT DISTINCT rel_fname, file_mtime FROM code_graph_tags WHERE workspace_id = ?')
      .all(workspaceId) as { rel_fname: string; file_mtime: number }[]

    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.rel_fname, row.file_mtime)
    }
    return map
  }

  /**
   * Delete all tags for a specific file.
   */
  deleteByFile(workspaceId: string, relFname: string): number {
    const db = this.db()
    const result = db
      .prepare('DELETE FROM code_graph_tags WHERE workspace_id = ? AND rel_fname = ?')
      .run(workspaceId, relFname)
    return result.changes
  }

  /**
   * Delete all tags for a workspace.
   */
  deleteByWorkspace(workspaceId: string): number {
    const db = this.db()
    const result = db.prepare('DELETE FROM code_graph_tags WHERE workspace_id = ?').run(workspaceId)
    return result.changes
  }

  /**
   * Get ALL tags (def + ref) for a workspace — used for full edge graph rebuild
   * after incremental file re-parsing.
   */
  findAllByWorkspace(workspaceId: string): RepomapTag[] {
    const db = this.db()
    const rows = db
      .prepare(
        'SELECT rel_fname, fname, line, name, kind FROM code_graph_tags WHERE workspace_id = ?'
      )
      .all(workspaceId) as CodeGraphTagRow[]
    return rows.map(mapRowToTag)
  }

  /**
   * Find definitions with zero cross-file references in the workspace.
   * A "dead" symbol has a 'def' tag but no matching 'ref' tag by name
   * in any other file. Optional path filters results to a subdirectory.
   */
  findDeadCode(
    workspaceId: string,
    options?: { path?: string; maxResults?: number }
  ): RepomapTag[] {
    const db = this.db()
    const limit = options?.maxResults ?? 100
    const pathFilter = options?.path ? `AND d.rel_fname LIKE ? || '%'` : ''
    const params: (string | number)[] = [workspaceId, workspaceId]
    if (options?.path) {
      params.push(options.path)
    }
    params.push(limit)

    const rows = db
      .prepare(
        `SELECT d.rel_fname, d.fname, d.line, d.name, d.kind
         FROM code_graph_tags d
         WHERE d.workspace_id = ? AND d.kind = 'def'
         ${pathFilter}
         AND NOT EXISTS (
           SELECT 1 FROM code_graph_tags r
           WHERE r.workspace_id = ?
             AND r.kind = 'ref'
             AND r.name = d.name
             AND r.rel_fname != d.rel_fname
         )
         ORDER BY d.rel_fname, d.line
         LIMIT ?`
      )
      .all(...params) as CodeGraphTagRow[]
    return rows.map(mapRowToTag)
  }

  /**
   * Find the most-referenced symbols (hotspots) — symbols with the most cross-file references.
   */
  findSymbolHotspots(
    workspaceId: string,
    opts?: { maxResults?: number; path?: string }
  ): { name: string; refCount: number }[] {
    const db = this.db()
    const maxResults = opts?.maxResults ?? 30
    const pathFilter = opts?.path ? `AND rel_fname LIKE ? || '%'` : ''
    const params: (string | number)[] = [workspaceId]
    if (opts?.path) params.push(opts.path)
    params.push(maxResults)

    const rows = db
      .prepare(
        `SELECT name, COUNT(*) as ref_count
         FROM code_graph_tags
         WHERE workspace_id = ? AND kind = 'ref'
         ${pathFilter}
         GROUP BY name
         ORDER BY ref_count DESC
         LIMIT ?`
      )
      .all(...params) as { name: string; ref_count: number }[]
    return rows.map((r) => ({ name: r.name, refCount: r.ref_count }))
  }

  /**
   * Count total tags for a workspace.
   */
  countByWorkspace(workspaceId: string): number {
    const db = this.db()
    const row = db
      .prepare('SELECT COUNT(*) as count FROM code_graph_tags WHERE workspace_id = ?')
      .get(workspaceId) as { count: number }
    return row.count
  }
}

function mapRowToTag(row: CodeGraphTagRow): RepomapTag {
  return {
    relFname: row.rel_fname,
    fname: row.fname,
    line: row.line,
    name: row.name,
    kind: row.kind
  }
}

export const codeGraphTagRepository = new CodeGraphTagRepository()

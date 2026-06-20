/**
 * Library Documentation Repository — manages cached library docs
 * with FTS5 full-text search and three-tier source tracking.
 */
import { BaseRepository } from '../base-repository'

// ── Types ──

interface LibraryDocRow {
  id: number
  workspace_id: string
  package_name: string
  version: string
  section_index: number
  section_title: string
  section_content: string
  source: string
  indexed_at: string
}

export interface LibraryDoc {
  id: number
  workspaceId: string
  packageName: string
  version: string
  sectionIndex: number
  sectionTitle: string
  sectionContent: string
  source: string
  indexedAt: string
}

export interface PackageSummary {
  packageName: string
  version: string
  sectionCount: number
  source: string
}

// ── Repository ──

export class LibraryDocRepository extends BaseRepository<LibraryDocRow, LibraryDoc> {
  protected readonly tableName = 'library_docs'

  protected mapRow(row: LibraryDocRow): LibraryDoc {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      packageName: row.package_name,
      version: row.version,
      sectionIndex: row.section_index,
      sectionTitle: row.section_title,
      sectionContent: row.section_content,
      source: row.source,
      indexedAt: row.indexed_at
    }
  }

  /**
   * Upsert sections for a package — delete old sections, insert new ones in a transaction.
   * Also syncs FTS5 content triggers.
   */
  upsertSections(
    workspaceId: string,
    packageName: string,
    version: string,
    source: string,
    sections: { title: string; content: string }[]
  ): void {
    const db = this.db()
    this.runTransaction(() => {
      // Delete old sections (and their FTS entries)
      const oldRows = db
        .prepare('SELECT id FROM library_docs WHERE workspace_id = ? AND package_name = ?')
        .all(workspaceId, packageName) as { id: number }[]

      for (const row of oldRows) {
        db.prepare(
          "INSERT INTO library_docs_fts(library_docs_fts, rowid, package_name, section_title, section_content) VALUES('delete', ?, ?, ?, ?)"
        ).run(
          row.id,
          packageName,
          '', // will be replaced by actual values
          ''
        )
      }

      // Delete old rows using direct SQL for FTS sync
      db.prepare(
        'DELETE FROM library_docs WHERE workspace_id = ? AND package_name = ?'
      ).run(workspaceId, packageName)

      // Insert new sections
      const insertStmt = db.prepare(`
        INSERT INTO library_docs (workspace_id, package_name, version, section_index, section_title, section_content, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        insertStmt.run(workspaceId, packageName, version, i, section.title, section.content, source)
      }

      // Sync FTS5 index with newly inserted rows
      const newRows = db
        .prepare('SELECT id, package_name, section_title, section_content FROM library_docs WHERE workspace_id = ? AND package_name = ?')
        .all(workspaceId, packageName) as { id: number; package_name: string; section_title: string; section_content: string }[]

      for (const row of newRows) {
        db.prepare(
          'INSERT INTO library_docs_fts(rowid, package_name, section_title, section_content) VALUES(?, ?, ?, ?)'
        ).run(row.id, row.package_name, row.section_title, row.section_content)
      }
    })
  }

  /**
   * FTS5 search across cached docs, optionally scoped to a package.
   * Returns matching sections ranked by relevance.
   */
  searchDocs(
    workspaceId: string,
    query: string,
    opts?: { packageName?: string; maxResults?: number }
  ): LibraryDoc[] {
    const db = this.db()
    const maxResults = opts?.maxResults ?? 10

    // Sanitize query for FTS5 — escape special chars and use OR for multi-word
    const sanitized = query
      .replace(/[^\w\s-]/g, '') // remove FTS5 special chars
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(' OR ')

    if (!sanitized) return []

    let sql = `
      SELECT ld.* FROM library_docs ld
      JOIN library_docs_fts fts ON ld.id = fts.rowid
      WHERE library_docs_fts MATCH ?
        AND ld.workspace_id = ?
    `
    const params: unknown[] = [sanitized, workspaceId]

    if (opts?.packageName) {
      sql += ' AND ld.package_name = ?'
      params.push(opts.packageName)
    }

    sql += ' ORDER BY rank LIMIT ?'
    params.push(maxResults)

    const rows = db.prepare(sql).all(...params) as LibraryDocRow[]
    return rows.map((r) => this.mapRow(r))
  }

  /** List all cached packages for a workspace. */
  listPackages(workspaceId: string): PackageSummary[] {
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT package_name, version, source, COUNT(*) as section_count
         FROM library_docs
         WHERE workspace_id = ?
         GROUP BY package_name
         ORDER BY package_name`
      )
      .all(workspaceId) as { package_name: string; version: string; source: string; section_count: number }[]

    return rows.map((r) => ({
      packageName: r.package_name,
      version: r.version,
      sectionCount: r.section_count,
      source: r.source
    }))
  }

  /** Check if a package is cached and within TTL. */
  isCached(workspaceId: string, packageName: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
    const db = this.db()
    const row = db
      .prepare(
        'SELECT indexed_at FROM library_docs WHERE workspace_id = ? AND package_name = ? LIMIT 1'
      )
      .get(workspaceId, packageName) as { indexed_at: string } | undefined

    if (!row) return false

    const indexedAt = new Date(row.indexed_at + 'Z').getTime()
    return Date.now() - indexedAt < maxAgeMs
  }

  /** Delete all docs for a workspace. */
  deleteByWorkspace(workspaceId: string): void {
    const db = this.db()
    this.runTransaction(() => {
      // Get all IDs to delete from FTS
      const rows = db
        .prepare('SELECT id, package_name, section_title, section_content FROM library_docs WHERE workspace_id = ?')
        .all(workspaceId) as LibraryDocRow[]

      for (const row of rows) {
        db.prepare(
          "INSERT INTO library_docs_fts(library_docs_fts, rowid, package_name, section_title, section_content) VALUES('delete', ?, ?, ?, ?)"
        ).run(row.id, row.package_name, row.section_title, row.section_content)
      }

      db.prepare('DELETE FROM library_docs WHERE workspace_id = ?').run(workspaceId)
    })
  }
}

export const libraryDocRepository = new LibraryDocRepository()

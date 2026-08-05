/**
 * MemoryFactRepository — data access for the knowledge-aware memory engine.
 *
 * Replaces the old `memory.repository.ts`. All JSON TEXT columns use
 * `safeParseJSON` per workspace convention. Embedding BLOBs stored as
 * Float32Array buffers.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import { dbLogger } from '../../logger'
import type {
  MemoryFact,
  MemoryFactCategory,
  MemoryFactStatus,
  MemoryFactTier,
  MemorySourceType,
  MemoryContradiction,
  MemoryConfirmation,
  ConfirmationSourceType,
  ContradictionStatus,
  MemoryDocState,
  MemoryEdge,
  MemoryEdgeType
} from '../../../shared/types'

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression.
 *
 * FTS5 treats `-`, `"`, `*`, `:`, `(`, `^` and `NEAR`/`AND`/`OR`/`NOT` as
 * syntax, so passing a raw prompt through would throw on perfectly ordinary
 * input like `why does foo-bar break?`. Every token is stripped to word
 * characters and quoted, then joined with OR: a fact matching more terms
 * simply ranks higher under BM25.
 */
function toFtsQuery(query: string): string {
  return query
    .slice(0, 500)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .slice(0, 32)
    .map((token) => `"${token}"`)
    .join(' OR ')
}

// ── Row shapes ──────────────────────────────────────────────────────────────

interface MemoryFactRow {
  id: string
  workspace_id: string | null
  category: MemoryFactCategory
  title: string
  content: string
  tags: string
  scope_paths: string
  tier: MemoryFactTier
  confidence: number
  confirmation_count: number
  last_confirmed_at: string | null
  status: MemoryFactStatus
  superseded_by: string | null
  merged_into: string | null
  volatile: number // SQLite stores booleans as 0/1
  source_type: MemorySourceType
  source_ref: string | null
  embedding: Buffer | null
  embedding_pending: number // SQLite stores booleans as 0/1
  last_accessed_at: string | null
  created_at: string
  updated_at: string
  // Bi-temporal validity (migration 136). Nullable: rows predating the
  // backfill, and any row written by an older binary, will not have them.
  valid_from: string | null
  valid_to: string | null
  observed_at: string | null
  recorded_at: string | null
  evidence_count?: number // populated by UI-facing queries only
}

interface ConfirmationRow {
  id: string
  fact_id: string
  source_type: ConfirmationSourceType
  weight: number
  created_at: string
}

interface ContradictionRow {
  id: string
  old_fact_id: string
  new_fact_id: string
  status: ContradictionStatus
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

interface DocStateRow {
  workspace_id: string
  file_path: string
  content_hash: string
  last_extracted_at: string
}

interface MemoryEdgeRow {
  id: string
  from_id: string
  to_id: string
  edge_type: MemoryEdgeType
  confidence: number
  created_at: string
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapFactRow(row: MemoryFactRow): MemoryFact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: safeParseJSON<string[]>(row.tags, []),
    scopePaths: safeParseJSON<string[]>(row.scope_paths, []),
    tier: row.tier,
    confidence: row.confidence,
    confirmationCount: row.confirmation_count,
    lastConfirmedAt: row.last_confirmed_at,
    status: row.status,
    supersededBy: row.superseded_by,
    mergedInto: row.merged_into ?? null,
    volatile: (row.volatile ?? 0) === 1,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    embeddingPending: row.embedding_pending === 1,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Fall back to created_at so callers never have to special-case a row that
    // predates the migration — which is exactly what the backfill assumed.
    validFrom: row.valid_from ?? row.created_at ?? null,
    validTo: row.valid_to ?? null,
    observedAt: row.observed_at ?? row.created_at ?? null,
    recordedAt: row.recorded_at ?? row.created_at ?? null,
    evidenceCount: row.evidence_count
  }
}

function mapEdgeRow(row: MemoryEdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    edgeType: row.edge_type,
    confidence: row.confidence,
    createdAt: row.created_at
  }
}

function mapConfirmationRow(row: ConfirmationRow): MemoryConfirmation {
  return {
    id: row.id,
    factId: row.fact_id,
    sourceType: row.source_type,
    weight: row.weight,
    createdAt: row.created_at
  }
}

function mapContradictionRow(row: ContradictionRow): MemoryContradiction {
  return {
    id: row.id,
    oldFactId: row.old_fact_id,
    newFactId: row.new_fact_id,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

function mapDocStateRow(row: DocStateRow): MemoryDocState {
  return {
    workspaceId: row.workspace_id,
    filePath: row.file_path,
    contentHash: row.content_hash,
    lastExtractedAt: row.last_extracted_at
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class MemoryFactRepository extends BaseRepository<MemoryFactRow, MemoryFact> {
  protected readonly tableName = 'memory_facts'
  protected mapRow(row: MemoryFactRow): MemoryFact {
    return mapFactRow(row)
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** All active facts for a workspace (+ global facts where workspace_id IS NULL). */
  findByWorkspace(workspaceId: string, status: MemoryFactStatus = 'active'): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT mf.*, (
           SELECT COUNT(*) FROM memory_confirmations c
           WHERE c.fact_id = mf.id AND c.source_type != 'auto_dedup'
         ) AS evidence_count
         FROM memory_facts mf
         WHERE (mf.workspace_id = ? OR mf.workspace_id IS NULL)
           AND mf.status = ?
         ORDER BY mf.tier DESC, mf.confidence DESC, mf.updated_at DESC`
      )
      .all(workspaceId, status) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /** All facts for a workspace across all statuses (for the management UI). */
  findAllByWorkspace(workspaceId: string): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT mf.*, (
           SELECT COUNT(*) FROM memory_confirmations c
           WHERE c.fact_id = mf.id AND c.source_type != 'auto_dedup'
         ) AS evidence_count
         FROM memory_facts mf
         WHERE mf.workspace_id = ? OR mf.workspace_id IS NULL
         ORDER BY mf.updated_at DESC`
      )
      .all(workspaceId) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /** Find by category within a workspace. */
  findByCategory(workspaceId: string, category: MemoryFactCategory): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE (workspace_id = ? OR workspace_id IS NULL)
           AND category = ? AND status = 'active'
         ORDER BY tier DESC, confidence DESC`
      )
      .all(workspaceId, category) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /** Full-text keyword search (title, content, tags). */
  search(workspaceId: string, query: string, limit = 50): MemoryFact[] {
    const like = `%${query.slice(0, 500)}%`
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE (workspace_id = ? OR workspace_id IS NULL)
           AND status = 'active'
           AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
         ORDER BY tier DESC, confidence DESC, updated_at DESC
         LIMIT ?`
      )
      .all(workspaceId, like, like, like, limit) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /**
   * Rank-ordered keyword search over the FTS5 index.
   *
   * Replaces the `LIKE '%q%'` scan for retrieval. `LIKE` cannot rank and cannot
   * use an index, so the old path scanned every active fact on every turn and
   * then ordered by tier — which tells you nothing about how well a fact
   * matches the query. BM25 orders by term rarity and density, which is what a
   * keyword arm has to contribute to rank fusion.
   *
   * Facts are returned with their 0-based rank so a caller can fuse this list
   * with the vector list without re-deriving positions.
   */
  searchFts(
    workspaceId: string,
    query: string,
    limit = 50,
    asOf?: string
  ): Array<{ fact: MemoryFact; rank: number }> {
    const match = toFtsQuery(query)
    if (!match) return []

    // Default: facts whose validity window is still open. With `asOf`, the
    // facts that were true at that instant instead — which is the whole point
    // of keeping superseded rows rather than deleting them.
    const validity = asOf
      ? `AND f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to > ?)`
      : `AND f.valid_to IS NULL AND f.status = 'active'`
    const validityParams = asOf ? [asOf, asOf] : []

    let rows: MemoryFactRow[]
    try {
      rows = this.db()
        .prepare(
          `SELECT f.* FROM memory_facts_fts fts
             JOIN memory_facts f ON f.id = fts.fact_id
            WHERE memory_facts_fts MATCH ?
              AND (f.workspace_id = ? OR f.workspace_id IS NULL)
              ${validity}
            ORDER BY rank
            LIMIT ?`
        )
        .all(match, workspaceId, ...validityParams, limit) as MemoryFactRow[]
    } catch {
      // Either a MATCH expression this sanitiser did not anticipate, or a DB
      // that has not reached migration 135 yet. Both are recoverable: fall back
      // to the LIKE scan so retrieval degrades in quality rather than failing.
      //
      // The LIKE scan has no validity predicate, so a point-in-time query
      // silently becomes a current-facts query. Degraded ranking is an
      // acceptable fallback; a wrong answer to "what did we believe in March"
      // is not, so it is logged rather than hidden.
      if (asOf) {
        dbLogger.warn(
          `[MemoryFactRepository] searchFts fell back to LIKE scan; asOf=${asOf} cannot be ` +
            `honoured on that path. Results reflect current facts.`
        )
      }
      return this.search(workspaceId, query, limit).map((fact, rank) => ({ fact, rank }))
    }

    return rows.map((row, rank) => ({ fact: mapFactRow(row), rank }))
  }

  /**
   * Embeddings for a specific set of facts.
   *
   * `findWithEmbeddings` loads every active fact in the workspace with its
   * BLOB, which is far too much work when the caller already knows the handful
   * of ids it cares about (diversity re-ranking over a result page).
   */
  findEmbeddingsByIds(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>()
    if (ids.length === 0) return out

    // Chunked to stay under SQLite's variable limit on a large result page.
    for (let i = 0; i < ids.length; i += 400) {
      const batch = ids.slice(i, i + 400)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db()
        .prepare(
          `SELECT id, embedding FROM memory_facts
            WHERE id IN (${placeholders}) AND embedding IS NOT NULL`
        )
        .all(...batch) as Array<{ id: string; embedding: Buffer }>

      for (const row of rows) {
        if (!row.embedding || row.embedding.length === 0) continue
        out.set(
          row.id,
          new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
          )
        )
      }
    }

    return out
  }

  // ── Edges ─────────────────────────────────────────────────────────

  /**
   * Record a typed relationship. Idempotent: re-asserting an existing edge
   * updates its confidence rather than failing the UNIQUE constraint.
   */
  createEdge(params: {
    fromId: string
    toId: string
    edgeType: MemoryEdgeType
    confidence?: number
  }): MemoryEdge | null {
    // A self-edge is always a bug and would corrupt graph traversal.
    if (params.fromId === params.toId) return null

    const row = this.db()
      .prepare(
        `INSERT INTO memory_edges (from_id, to_id, edge_type, confidence)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, edge_type)
           DO UPDATE SET confidence = excluded.confidence
         RETURNING *`
      )
      .get(
        params.fromId,
        params.toId,
        params.edgeType,
        params.confidence ?? 1.0
      ) as MemoryEdgeRow | undefined

    return row ? mapEdgeRow(row) : null
  }

  /** Every edge touching a fact, in either direction. */
  findEdgesForFact(factId: string): MemoryEdge[] {
    const rows = this.db()
      .prepare('SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ? ORDER BY created_at')
      .all(factId, factId) as MemoryEdgeRow[]
    return rows.map(mapEdgeRow)
  }

  /** Edges between facts belonging to a workspace (for the graph view). */
  findEdgesByWorkspace(workspaceId: string): MemoryEdge[] {
    const rows = this.db()
      .prepare(
        `SELECT e.* FROM memory_edges e
           JOIN memory_facts f ON f.id = e.from_id
          WHERE f.workspace_id = ? OR f.workspace_id IS NULL
          ORDER BY e.created_at`
      )
      .all(workspaceId) as MemoryEdgeRow[]
    return rows.map(mapEdgeRow)
  }

  /** Facts one hop away from a seed, following a specific edge type. */
  findNeighbours(factId: string, edgeType: MemoryEdgeType): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT f.* FROM memory_facts f
           JOIN memory_edges e
             ON (e.to_id = f.id AND e.from_id = ?)
             OR (e.from_id = f.id AND e.to_id = ?)
          WHERE e.edge_type = ?
            AND f.status = 'active'`
      )
      .all(factId, factId, edgeType) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  deleteEdge(id: string): void {
    this.db().prepare('DELETE FROM memory_edges WHERE id = ?').run(id)
  }

  /**
   * Re-open a closed validity window.
   *
   * Used when an archived fact is brought back — approving a synthesis
   * proposal, or un-archiving by hand. Without this the fact would be `active`
   * with a `valid_to` in the past and would never be retrieved again.
   */
  reopenValidity(id: string): void {
    this.db()
      .prepare(
        `UPDATE memory_facts SET valid_to = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .run(id)
  }

  // ── Write ───────────────────────────────────────────────────────────────

  /** Insert a new fact. Returns the created fact. */
  createFact(params: {
    workspaceId: string | null
    category: MemoryFactCategory
    title: string
    content: string
    tags?: string[]
    scopePaths?: string[]
    tier?: MemoryFactTier
    confidence?: number
    sourceType: MemorySourceType
    sourceRef?: string | null
    embedding?: Buffer | null
    embeddingPending?: boolean
    /**
     * When the source stated this, if it is not "now" — a commit date, a file
     * mtime. Drives recency scoring, so a fact mined from a 2011 commit is not
     * ranked as though it were written today.
     */
    observedAt?: string | null
  }): MemoryFact {
    const row = this.db()
      .prepare(
        `INSERT INTO memory_facts
           (workspace_id, category, title, content, tags, scope_paths,
            tier, confidence, source_type, source_ref,
            embedding, embedding_pending,
            valid_from, valid_to, observed_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 COALESCE(?, datetime('now')), NULL,
                 COALESCE(?, datetime('now')), datetime('now'))
         RETURNING *`
      )
      .get(
        params.workspaceId,
        params.category,
        params.title,
        params.content,
        JSON.stringify(params.tags ?? []),
        JSON.stringify(params.scopePaths ?? []),
        params.tier ?? 0,
        params.confidence ?? 0.5,
        params.sourceType,
        params.sourceRef ?? null,
        params.embedding ?? null,
        params.embeddingPending === false ? 0 : 1,
        params.observedAt ?? null,
        params.observedAt ?? null
      ) as MemoryFactRow
    return mapFactRow(row)
  }

  /** Update mutable fields on a fact. */
  updateFact(
    id: string,
    params: {
      title?: string
      content?: string
      tags?: string[]
      scopePaths?: string[]
      category?: MemoryFactCategory
      tier?: MemoryFactTier
      confidence?: number
      status?: MemoryFactStatus
      supersededBy?: string | null
    }
  ): MemoryFact {
    const existing = this.db()
      .prepare('SELECT * FROM memory_facts WHERE id = ?')
      .get(id) as MemoryFactRow | undefined
    if (!existing) throw new Error(`MemoryFact not found: ${id}`)

    const row = this.db()
      .prepare(
        `UPDATE memory_facts SET
           title = ?,
           content = ?,
           tags = ?,
           scope_paths = ?,
           category = ?,
           tier = ?,
           confidence = ?,
           status = ?,
           superseded_by = ?,
           updated_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(
        params.title ?? existing.title,
        params.content ?? existing.content,
        params.tags ? JSON.stringify(params.tags) : existing.tags,
        params.scopePaths ? JSON.stringify(params.scopePaths) : existing.scope_paths,
        params.category ?? existing.category,
        params.tier ?? existing.tier,
        params.confidence ?? existing.confidence,
        params.status ?? existing.status,
        params.supersededBy !== undefined ? params.supersededBy : existing.superseded_by,
        id
      ) as MemoryFactRow
    return mapFactRow(row)
  }

  /** Change workspace scope: global (null) ↔ workspace-scoped. */
  setWorkspaceScope(id: string, workspaceId: string | null): MemoryFact {
    const row = this.db()
      .prepare(
        `UPDATE memory_facts SET workspace_id = ?, updated_at = datetime('now')
         WHERE id = ? RETURNING *`
      )
      .get(workspaceId, id) as MemoryFactRow | undefined
    if (!row) throw new Error(`MemoryFact not found: ${id}`)
    return mapFactRow(row)
  }

  // ── Confirmation / promotion ────────────────────────────────────────────

  /** Increment confirmation count, touch last_confirmed_at, optionally bump tier. */
  confirmFact(id: string, newTier?: MemoryFactTier, newConfidence?: number): MemoryFact {
    const existing = this.db()
      .prepare('SELECT * FROM memory_facts WHERE id = ?')
      .get(id) as MemoryFactRow | undefined
    if (!existing) throw new Error(`MemoryFact not found: ${id}`)

    const row = this.db()
      .prepare(
        `UPDATE memory_facts SET
           confirmation_count = confirmation_count + 1,
           last_confirmed_at = datetime('now'),
           tier = ?,
           confidence = ?,
           updated_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(
        newTier ?? existing.tier,
        newConfidence ?? Math.min(1.0, existing.confidence + 0.05),
        id
      ) as MemoryFactRow
    return mapFactRow(row)
  }

  /** Supersede a fact: mark old as superseded, record which fact replaced it. */
  supersedeFact(oldId: string, newId: string): void {
    // Closing the validity window is the point of superseding: the fact was
    // true until now, and a point-in-time query before this moment must still
    // return it. Flipping status alone would lose that.
    this.db()
      .prepare(
        `UPDATE memory_facts SET
           status = 'superseded',
           superseded_by = ?,
           valid_to = COALESCE(valid_to, datetime('now')),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(newId, oldId)

    // Mirror into the edge graph so traversal does not have to know about the
    // legacy `superseded_by` column.
    this.createEdge({ fromId: newId, toId: oldId, edgeType: 'supersedes' })
  }

  /** Archive a fact (soft delete). Closes its validity window. */
  archiveFact(id: string): void {
    this.db()
      .prepare(
        `UPDATE memory_facts SET
           status = 'archived',
           valid_to = COALESCE(valid_to, datetime('now')),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(id)
  }

  // ── Embeddings ──────────────────────────────────────────────────────────

  /** Store a computed embedding vector for a fact. */
  setEmbedding(id: string, embedding: Buffer): void {
    this.db()
      .prepare(
        `UPDATE memory_facts SET
           embedding = ?,
           embedding_pending = 0,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(embedding, id)
  }

  /** Get all facts with pending embeddings. */
  findPendingEmbeddings(limit = 100): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE embedding_pending = 1 AND status = 'active'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /**
   * Facts with embeddings for a workspace (for cosine search).
   *
   * Defaults to currently-valid facts. Pass `asOf` for a point-in-time view,
   * which reads the validity window rather than status — a superseded fact was
   * still true before it was superseded.
   */
  findWithEmbeddings(
    workspaceId: string,
    asOf?: string
  ): Array<{ fact: MemoryFact; embedding: Float32Array }> {
    const validity = asOf
      ? `AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`
      : `AND valid_to IS NULL AND status = 'active'`

    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE (workspace_id = ? OR workspace_id IS NULL)
           ${validity}
           AND embedding IS NOT NULL`
      )
      .all(workspaceId, ...(asOf ? [asOf, asOf] : [])) as MemoryFactRow[]

    return rows
      .filter((r) => r.embedding !== null)
      .map((r) => ({
        fact: mapFactRow(r),
        embedding: new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, r.embedding!.byteLength / 4)
      }))
  }

  /** Touch last_accessed_at for a batch of fact IDs. */
  touchFacts(ids: string[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db()
      .prepare(
        `UPDATE memory_facts SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`
      )
      .run(...ids)
  }

  /** Count facts per workspace (for stats). */
  countByWorkspace(workspaceId: string): { active: number; superseded: number; archived: number; pendingEmbedding: number } {
    const row = this.db()
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
           SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) as superseded,
           SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
           SUM(CASE WHEN embedding_pending = 1 AND status = 'active' THEN 1 ELSE 0 END) as pending_embedding
         FROM memory_facts
         WHERE workspace_id = ? OR workspace_id IS NULL`
      )
      .get(workspaceId) as { active: number; superseded: number; archived: number; pending_embedding: number }
    return {
      active: row.active ?? 0,
      superseded: row.superseded ?? 0,
      archived: row.archived ?? 0,
      pendingEmbedding: row.pending_embedding ?? 0
    }
  }

  // ── Decay sweep ─────────────────────────────────────────────────────────

  /** Find facts that haven't been accessed or confirmed in `daysThreshold` days. */
  findStale(daysThreshold: number): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE status = 'active'
           AND tier < 3
           AND (
             (last_accessed_at IS NULL AND last_confirmed_at IS NULL
              AND julianday('now') - julianday(created_at) > ?)
             OR
             (COALESCE(last_accessed_at, last_confirmed_at, created_at) IS NOT NULL
              AND julianday('now') - julianday(COALESCE(last_accessed_at, last_confirmed_at, created_at)) > ?)
           )
         ORDER BY tier ASC, confidence ASC`
      )
      .all(daysThreshold, daysThreshold) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  /** Decay a batch of facts: lower confidence, optionally demote tier. */
  decayFacts(ids: string[], confidenceDelta: number): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db()
      .prepare(
        `UPDATE memory_facts SET
           confidence = MAX(0.0, confidence - ?),
           tier = CASE WHEN confidence - ? < 0.3 AND tier > 0 THEN tier - 1 ELSE tier END,
           updated_at = datetime('now')
         WHERE id IN (${placeholders})`
      )
      .run(confidenceDelta, confidenceDelta, ...ids)
  }

  // ── Contradictions ──────────────────────────────────────────────────────

  createContradiction(params: {
    oldFactId: string
    newFactId: string
    status?: ContradictionStatus
    resolution?: string
  }): MemoryContradiction | null {
    const row = this.db()
      .prepare(
        `INSERT INTO memory_contradictions (old_fact_id, new_fact_id, status, resolution)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING *`
      )
      .get(
        params.oldFactId,
        params.newFactId,
        params.status ?? 'auto_resolved',
        params.resolution ?? null
      ) as ContradictionRow | undefined
    return row ? mapContradictionRow(row) : null
  }

  findContradictions(status?: ContradictionStatus): MemoryContradiction[] {
    if (status) {
      const rows = this.db()
        .prepare('SELECT * FROM memory_contradictions WHERE status = ? ORDER BY created_at DESC')
        .all(status) as ContradictionRow[]
      return rows.map(mapContradictionRow)
    }
    const rows = this.db()
      .prepare('SELECT * FROM memory_contradictions ORDER BY created_at DESC')
      .all() as ContradictionRow[]
    return rows.map(mapContradictionRow)
  }

  findContradictionsPaged(
    status: ContradictionStatus | undefined,
    limit: number,
    offset: number
  ): MemoryContradiction[] {
    const sql = status
      ? 'SELECT * FROM memory_contradictions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM memory_contradictions ORDER BY created_at DESC LIMIT ? OFFSET ?'
    const args = status ? [status, limit, offset] : [limit, offset]
    const rows = this.db().prepare(sql).all(...args) as ContradictionRow[]
    return rows.map(mapContradictionRow)
  }

  countContradictions(status?: ContradictionStatus): number {
    const sql = status
      ? 'SELECT COUNT(*) as cnt FROM memory_contradictions WHERE status = ?'
      : 'SELECT COUNT(*) as cnt FROM memory_contradictions'
    const args = status ? [status] : []
    const row = this.db().prepare(sql).get(...args) as { cnt: number }
    return row.cnt
  }

  /** Bulk-resolve pending duplicates with cosine ≥ threshold, archiving the older fact. */
  bulkAutoResolveDuplicates(minCosine: number): number {
    // Find pending contradictions whose resolution contains a cosine score ≥ threshold
    const pending = this.db()
      .prepare(
        `SELECT * FROM memory_contradictions WHERE status = 'pending' AND resolution LIKE 'duplicate%'`
      )
      .all() as ContradictionRow[]

    let resolved = 0
    const resolveStmt = this.db().prepare(
      `UPDATE memory_contradictions SET status = 'user_resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?`
    )
    const archiveStmt = this.db().prepare(
      `UPDATE memory_facts SET status = 'archived', updated_at = datetime('now') WHERE id = ?`
    )

    this.db().transaction(() => {
      for (const row of pending) {
        // Extract cosine score from resolution like "duplicate cluster (3 facts, cosine: 0.923)"
        const match = row.resolution?.match(/cosine:\s*(\d+\.\d+)/)
        if (!match) continue
        const cosine = parseFloat(match[1])
        if (cosine < minCosine) continue

        // Determine which fact is older by comparing created_at
        const oldFact = this.findById(row.old_fact_id)
        const newFact = this.findById(row.new_fact_id)
        if (!oldFact || !newFact) continue

        const oldIsOlder = new Date(oldFact.createdAt).getTime() <= new Date(newFact.createdAt).getTime()
        const archiveId = oldIsOlder ? oldFact.id : newFact.id

        resolveStmt.run(`auto-resolved duplicate (cosine: ${cosine.toFixed(3)}, archived older)`, row.id)
        archiveStmt.run(archiveId)
        resolved++
      }
    })()

    return resolved
  }

  resolveContradiction(id: string, resolution: string, status: ContradictionStatus = 'user_resolved'): MemoryContradiction {
    const row = this.db()
      .prepare(
        `UPDATE memory_contradictions SET
           status = ?,
           resolution = ?,
           resolved_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(status, resolution, id) as ContradictionRow
    return mapContradictionRow(row)
  }

  // ── Doc state ───────────────────────────────────────────────────────────

  getDocState(workspaceId: string, filePath: string): MemoryDocState | undefined {
    const row = this.db()
      .prepare(
        'SELECT * FROM memory_doc_state WHERE workspace_id = ? AND file_path = ?'
      )
      .get(workspaceId, filePath) as DocStateRow | undefined
    return row ? mapDocStateRow(row) : undefined
  }

  upsertDocState(workspaceId: string, filePath: string, contentHash: string): void {
    this.db()
      .prepare(
        `INSERT INTO memory_doc_state (workspace_id, file_path, content_hash, last_extracted_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (workspace_id, file_path)
         DO UPDATE SET content_hash = excluded.content_hash, last_extracted_at = datetime('now')`
      )
      .run(workspaceId, filePath, contentHash)
  }

  findAllDocStates(workspaceId: string): MemoryDocState[] {
    const rows = this.db()
      .prepare('SELECT * FROM memory_doc_state WHERE workspace_id = ?')
      .all(workspaceId) as DocStateRow[]
    return rows.map(mapDocStateRow)
  }

  /**
   * Epoch ms of the most recent fact mutation in a workspace, or 0 when the
   * workspace has no facts. Used as a liveness signal: a dedupe-merge bumps
   * `updated_at` without changing the active fact count.
   */
  getLastMutationAt(workspaceId: string): number {
    // `updated_at` is always written as datetime('now') (UTC), so strftime
    // gives a stable epoch regardless of the host timezone.
    const row = this.db()
      .prepare(
        `SELECT CAST(strftime('%s', MAX(updated_at)) AS INTEGER) AS last_mutation
           FROM memory_facts
          WHERE workspace_id = ? OR workspace_id IS NULL`
      )
      .get(workspaceId) as { last_mutation: number | null } | undefined
    return row?.last_mutation ? row.last_mutation * 1000 : 0
  }

  // ── Confirmation event log ──────────────────────────────────────────────

  /** Record a confirmation event with source type and weight. */
  addConfirmation(factId: string, sourceType: ConfirmationSourceType, weight = 1.0): MemoryConfirmation {
    const row = this.db()
      .prepare(
        `INSERT INTO memory_confirmations (fact_id, source_type, weight)
         VALUES (?, ?, ?)
         RETURNING *`
      )
      .get(factId, sourceType, weight) as ConfirmationRow
    return mapConfirmationRow(row)
  }

  /** Get all confirmation events for a fact (for evidence-based promotion). */
  getConfirmations(factId: string): MemoryConfirmation[] {
    const rows = this.db()
      .prepare('SELECT * FROM memory_confirmations WHERE fact_id = ? ORDER BY created_at ASC')
      .all(factId) as ConfirmationRow[]
    return rows.map(mapConfirmationRow)
  }

  /** Count distinct days with confirmations for a fact. */
  countConfirmationDays(factId: string): number {
    const row = this.db()
      .prepare(
        `SELECT COUNT(DISTINCT date(created_at)) as days
         FROM memory_confirmations WHERE fact_id = ?`
      )
      .get(factId) as { days: number }
    return row.days
  }

  /** Count distinct source types for a fact's confirmations. */
  countConfirmationSourceTypes(factId: string): number {
    const row = this.db()
      .prepare(
        `SELECT COUNT(DISTINCT source_type) as types
         FROM memory_confirmations WHERE fact_id = ?`
      )
      .get(factId) as { types: number }
    return row.types
  }

  /** Check if a fact has any human confirmation. */
  hasHumanConfirmation(factId: string): boolean {
    const row = this.db()
      .prepare(
        `SELECT COUNT(*) as cnt FROM memory_confirmations
         WHERE fact_id = ? AND source_type = 'human'`
      )
      .get(factId) as { cnt: number }
    return row.cnt > 0
  }

  /** Compute weighted confirmation sum for a fact. */
  getWeightedConfirmationSum(factId: string): number {
    const row = this.db()
      .prepare(
        `SELECT COALESCE(SUM(weight), 0) as total
         FROM memory_confirmations WHERE fact_id = ?`
      )
      .get(factId) as { total: number }
    return row.total
  }

  /** Map of factId → non-auto_dedup confirmation count, for a set of facts. */
  getEvidenceCounts(ids: string[]): Map<string, number> {
    const counts = new Map<string, number>()
    if (ids.length === 0) return counts
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db()
      .prepare(
        `SELECT fact_id, COUNT(*) AS n
         FROM memory_confirmations
         WHERE fact_id IN (${placeholders}) AND source_type != 'auto_dedup'
         GROUP BY fact_id`
      )
      .all(...ids) as Array<{ fact_id: string; n: number }>
    for (const r of rows) counts.set(r.fact_id, r.n)
    return counts
  }

  // ── Volatile / merge helpers ────────────────────────────────────────────

  /** Mark a fact as volatile (version/count patterns). */
  setVolatile(id: string, volatile: boolean): void {
    this.db()
      .prepare(
        `UPDATE memory_facts SET volatile = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(volatile ? 1 : 0, id)
  }

  /** Re-parent confirmation events from one fact to another (used during cluster merge). */
  reparentConfirmations(fromFactId: string, toFactId: string): number {
    const result = this.db()
      .prepare('UPDATE memory_confirmations SET fact_id = ? WHERE fact_id = ?')
      .run(toFactId, fromFactId)

    // Sync the canonical fact's confirmation_count to match actual evidence
    if (result.changes > 0) {
      this.db()
        .prepare(
          `UPDATE memory_facts SET confirmation_count = (
             SELECT COUNT(*) FROM memory_confirmations WHERE fact_id = ?
           ) WHERE id = ?`
        )
        .run(toFactId, toFactId)
    }

    return result.changes
  }

  /** Mark a fact as merged into a canonical fact and archive it. */
  mergeFact(sourceId: string, canonicalId: string): void {
    this.db()
      .prepare(
        `UPDATE memory_facts SET
           merged_into = ?,
           status = 'archived',
           valid_to = COALESCE(valid_to, datetime('now')),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(canonicalId, sourceId)

    this.createEdge({ fromId: canonicalId, toId: sourceId, edgeType: 'supersedes' })
  }

  /** Update a fact's content in-place (for UPDATE action on volatile/dedup).
   *  Preserves existing tags/scopePaths when the caller doesn't provide them. */
  updateFactInPlace(id: string, params: {
    title: string
    content: string
    tags?: string[]
    scopePaths?: string[]
  }): MemoryFact {
    // Only overwrite tags/scopePaths when explicitly provided — undefined means "keep existing"
    const row = this.db()
      .prepare(
        `UPDATE memory_facts SET
           title = ?,
           content = ?,
           tags = COALESCE(?, tags),
           scope_paths = COALESCE(?, scope_paths),
           updated_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(
        params.title,
        params.content,
        params.tags !== undefined ? JSON.stringify(params.tags) : null,
        params.scopePaths !== undefined ? JSON.stringify(params.scopePaths) : null,
        id
      ) as MemoryFactRow
    return mapFactRow(row)
  }

  /** Find volatile facts matching a workspace. */
  findVolatileFacts(workspaceId: string): MemoryFact[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_facts
         WHERE (workspace_id = ? OR workspace_id IS NULL)
           AND status = 'active' AND volatile = 1
         ORDER BY updated_at DESC`
      )
      .all(workspaceId) as MemoryFactRow[]
    return rows.map(mapFactRow)
  }

  // ── Cleanup helpers ─────────────────────────────────────────────────────

  /** Delete resolved/expired contradiction records older than N days. */
  pruneOldContradictions(daysThreshold: number): number {
    const result = this.db()
      .prepare(
        `DELETE FROM memory_contradictions
         WHERE status != 'pending'
           AND julianday('now') - julianday(created_at) > ?`
      )
      .run(daysThreshold)
    return result.changes
  }

  /** Count pending contradictions (review queue size). */
  countPendingContradictions(): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) as cnt FROM memory_contradictions WHERE status = 'pending'`)
      .get() as { cnt: number }
    return row.cnt
  }
}

export const memoryFactRepository = new MemoryFactRepository()

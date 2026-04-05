import { getDatabase } from '../index'
import type { Memory, MemoryType } from '../../../shared/types'

interface MemoryRow {
  id: string
  workspace_id: string | null
  type: MemoryType
  title: string
  content: string
  tags: string
  source_conversation_id: string | null
  source_agent_id: string | null
  importance: number
  last_accessed_at: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    sourceConversationId: row.source_conversation_id,
    sourceAgentId: row.source_agent_id,
    importance: row.importance,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class MemoryRepository {
  findByWorkspace(workspaceId: string): Memory[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE workspace_id = ? OR workspace_id IS NULL
         ORDER BY importance DESC, updated_at DESC`
      )
      .all(workspaceId) as MemoryRow[]
    return rows.map(mapRow)
  }

  findByType(workspaceId: string, type: MemoryType): Memory[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE (workspace_id = ? OR workspace_id IS NULL) AND type = ?
         ORDER BY importance DESC, updated_at DESC`
      )
      .all(workspaceId, type) as MemoryRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Memory | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
    return row ? mapRow(row) : null
  }

  search(workspaceId: string, query: string): Memory[] {
    const db = getDatabase()
    const likeQuery = `%${query}%`
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE (workspace_id = ? OR workspace_id IS NULL)
           AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
         ORDER BY importance DESC, updated_at DESC
         LIMIT 50`
      )
      .all(workspaceId, likeQuery, likeQuery, likeQuery) as MemoryRow[]
    return rows.map(mapRow)
  }

  create(params: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    sourceConversationId?: string
    sourceAgentId?: string
    importance?: number
  }): Memory {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO memories (workspace_id, type, title, content, tags, source_conversation_id, source_agent_id, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.workspaceId,
        params.type,
        params.title,
        params.content,
        JSON.stringify(params.tags ?? []),
        params.sourceConversationId ?? null,
        params.sourceAgentId ?? null,
        params.importance ?? 5
      ) as MemoryRow
    return mapRow(row)
  }

  update(
    id: string,
    params: {
      title?: string
      content?: string
      tags?: string[]
      importance?: number
    }
  ): Memory {
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined
    if (!existing) throw new Error(`Memory not found: ${id}`)

    const row = db
      .prepare(
        `UPDATE memories SET
           title = ?,
           content = ?,
           tags = ?,
           importance = ?,
           updated_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(
        params.title ?? existing.title,
        params.content ?? existing.content,
        params.tags ? JSON.stringify(params.tags) : existing.tags,
        params.importance ?? existing.importance,
        id
      ) as MemoryRow
    return mapRow(row)
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  /**
   * Touch memories to update last_accessed_at — called when memories are injected into prompts.
   */
  touchMemories(ids: string[]): void {
    if (ids.length === 0) return
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(
      `UPDATE memories SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(...ids)
  }

  /**
   * Get memories formatted for prompt injection, ordered by importance and recency.
   * Returns memories within a character budget.
   */
  getForPrompt(workspaceId: string, maxChars: number): Memory[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE (workspace_id = ? OR workspace_id IS NULL)
         ORDER BY importance DESC, updated_at DESC`
      )
      .all(workspaceId) as MemoryRow[]

    const memories: Memory[] = []
    let totalChars = 0
    for (const row of rows) {
      const mem = mapRow(row)
      const memSize = mem.title.length + mem.content.length + 20 // overhead for formatting
      if (totalChars + memSize > maxChars) break
      memories.push(mem)
      totalChars += memSize
    }
    return memories
  }

  /**
   * Count memories per workspace (for stats/dashboard).
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDatabase()
    const result = db
      .prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE workspace_id = ? OR workspace_id IS NULL'
      )
      .get(workspaceId) as { cnt: number }
    return result.cnt
  }

  /**
   * Create a memory only if no similar memory already exists with equal or higher importance.
   * Uses findSimilar() to check for duplicates before inserting.
   * Returns the created Memory, or null if a duplicate was detected and skipped.
   */
  createIfNotDuplicate(params: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    sourceConversationId?: string
    sourceAgentId?: string
    importance?: number
  }): Memory | null {
    const effectiveWorkspaceId = params.workspaceId ?? ''
    const existing = this.findSimilar(effectiveWorkspaceId, params.title)

    if (existing.length > 0) {
      // If a similar memory exists with equal or higher importance, skip
      const dominated = existing.some((m) => m.importance >= (params.importance ?? 5))
      if (dominated) return null
    }

    return this.create(params)
  }

  /**
   * Find duplicate memories by checking for similar titles within the same workspace.
   * Used during dream consolidation and dedup-on-create.
   */
  findSimilar(workspaceId: string, title: string, excludeId?: string): Memory[] {
    const db = getDatabase()
    const likeTitle = `%${title}%`
    const rows = excludeId
      ? (db
          .prepare(
            `SELECT * FROM memories
             WHERE (workspace_id = ? OR workspace_id IS NULL)
               AND title LIKE ?
               AND id != ?
             LIMIT 5`
          )
          .all(workspaceId, likeTitle, excludeId) as MemoryRow[])
      : (db
          .prepare(
            `SELECT * FROM memories
             WHERE (workspace_id = ? OR workspace_id IS NULL)
               AND title LIKE ?
             LIMIT 5`
          )
          .all(workspaceId, likeTitle) as MemoryRow[])
    return rows.map(mapRow)
  }
}

export const memoryRepository = new MemoryRepository()

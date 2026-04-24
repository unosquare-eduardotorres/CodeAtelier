import { getDatabase } from '../index'
import { randomUUID, createHash } from 'node:crypto'

export interface BugRecord {
  id: string
  fingerprint: string
  timestamp: string
  lastSeenAt: string
  process: 'main' | 'renderer' | 'preload'
  severity: 'error' | 'fatal'
  errorMessage: string
  stackTrace: string | null
  sourceFile: string | null
  sourceLine: number | null
  sourceColumn: number | null
  componentName: string | null
  activeView: string | null
  workspaceId: string | null
  agentId: string | null
  appVersion: string
  osInfo: string | null
  isResolved: boolean
  occurrenceCount: number
  note: string | null
  createdAt: string
}

export interface CreateBugInput {
  process: 'main' | 'renderer' | 'preload'
  severity: 'error' | 'fatal'
  errorMessage: string
  stackTrace?: string
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
  componentName?: string
  activeView?: string
  workspaceId?: string
  agentId?: string
  appVersion: string
  osInfo?: string
}

export interface BugFilters {
  process?: 'main' | 'renderer' | 'preload'
  isResolved?: boolean
  workspaceId?: string
  sortBy?: 'last_seen_at' | 'occurrence_count' | 'severity'
  sortDir?: 'asc' | 'desc'
}

interface BugRow {
  id: string
  fingerprint: string
  timestamp: string
  last_seen_at: string
  process: string
  severity: string
  error_message: string
  stack_trace: string | null
  source_file: string | null
  source_line: number | null
  source_column: number | null
  component_name: string | null
  active_view: string | null
  workspace_id: string | null
  agent_id: string | null
  app_version: string
  os_info: string | null
  is_resolved: number
  occurrence_count: number
  note: string | null
  created_at: string
}

function toModel(row: BugRow): BugRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    timestamp: row.timestamp,
    lastSeenAt: row.last_seen_at,
    process: row.process as BugRecord['process'],
    severity: row.severity as BugRecord['severity'],
    errorMessage: row.error_message,
    stackTrace: row.stack_trace,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    sourceColumn: row.source_column,
    componentName: row.component_name,
    activeView: row.active_view,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    appVersion: row.app_version,
    osInfo: row.os_info,
    isResolved: row.is_resolved === 1,
    occurrenceCount: row.occurrence_count,
    note: row.note,
    createdAt: row.created_at
  }
}

function computeFingerprint(
  errorMessage: string,
  sourceFile?: string,
  sourceLine?: number
): string {
  const raw = `${errorMessage}|${sourceFile ?? ''}|${sourceLine ?? ''}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

export class BugRepository {
  /**
   * Insert or update a bug based on fingerprint deduplication.
   * Returns { isNew: true } when a toast should fire (new bug or regression).
   */
  upsertBug(input: CreateBugInput): { isNew: boolean; bugId: string } {
    const db = getDatabase()
    const fingerprint = computeFingerprint(input.errorMessage, input.sourceFile, input.sourceLine)
    const now = new Date().toISOString()

    const existing = db
      .prepare('SELECT id, is_resolved FROM bugs WHERE fingerprint = ?')
      .get(fingerprint) as { id: string; is_resolved: number } | undefined

    if (existing) {
      if (existing.is_resolved === 0) {
        // Still open — just bump count + last_seen_at
        db.prepare(
          'UPDATE bugs SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?'
        ).run(now, existing.id)
        return { isNew: false, bugId: existing.id }
      } else {
        // Regression — reopen
        db.prepare(
          'UPDATE bugs SET is_resolved = 0, occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?'
        ).run(now, existing.id)
        return { isNew: true, bugId: existing.id }
      }
    }

    // Brand new bug
    const id = randomUUID()
    db.prepare(
      `INSERT INTO bugs (id, fingerprint, timestamp, last_seen_at, process, severity, error_message, stack_trace, source_file, source_line, source_column, component_name, active_view, workspace_id, agent_id, app_version, os_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      fingerprint,
      now,
      now,
      input.process,
      input.severity,
      input.errorMessage,
      input.stackTrace ?? null,
      input.sourceFile ?? null,
      input.sourceLine ?? null,
      input.sourceColumn ?? null,
      input.componentName ?? null,
      input.activeView ?? null,
      input.workspaceId ?? null,
      input.agentId ?? null,
      input.appVersion,
      input.osInfo ?? null
    )
    return { isNew: true, bugId: id }
  }

  /** Get all bugs with optional filters and sorting */
  getAll(filters?: BugFilters): BugRecord[] {
    const db = getDatabase()
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters?.process) {
      conditions.push('process = ?')
      params.push(filters.process)
    }
    if (filters?.isResolved !== undefined) {
      conditions.push('is_resolved = ?')
      params.push(filters.isResolved ? 1 : 0)
    }
    if (filters?.workspaceId) {
      conditions.push('workspace_id = ?')
      params.push(filters.workspaceId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sortCol = filters?.sortBy ?? 'last_seen_at'
    const sortDir = filters?.sortDir ?? 'desc'
    const validSorts = ['last_seen_at', 'occurrence_count', 'severity']
    const safeSortCol = validSorts.includes(sortCol) ? sortCol : 'last_seen_at'
    const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC'

    const rows = db
      .prepare(`SELECT * FROM bugs ${where} ORDER BY ${safeSortCol} ${safeSortDir}`)
      .all(...params) as BugRow[]
    return rows.map(toModel)
  }

  /** Get a single bug by ID */
  getById(id: string): BugRecord | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id) as BugRow | undefined
    return row ? toModel(row) : null
  }

  /** Mark a bug as resolved */
  markResolved(id: string): void {
    const db = getDatabase()
    db.prepare('UPDATE bugs SET is_resolved = 1 WHERE id = ?').run(id)
  }

  /** Mark a bug as unresolved */
  markUnresolved(id: string): void {
    const db = getDatabase()
    db.prepare('UPDATE bugs SET is_resolved = 0 WHERE id = ?').run(id)
  }

  /** Delete a bug permanently */
  deleteBug(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM bugs WHERE id = ?').run(id)
  }

  /** Add or update a user note on a bug */
  updateNote(id: string, note: string): void {
    const db = getDatabase()
    db.prepare('UPDATE bugs SET note = ? WHERE id = ?').run(note, id)
  }

  /** Get count of unresolved bugs (for badge) */
  getUnresolvedCount(): number {
    const db = getDatabase()
    const result = db
      .prepare('SELECT COUNT(*) as count FROM bugs WHERE is_resolved = 0')
      .get() as { count: number }
    return result.count
  }
}

export const bugRepository = new BugRepository()

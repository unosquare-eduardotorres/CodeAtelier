import { BaseRepository } from '../base-repository'
import type { Workspace, WorkspaceSettings } from '../../../shared/types'

interface WorkspaceRow {
  id: string
  name: string
  repo_path: string
  git_remote_url: string | null
  created_at: string
  last_opened_at: string
  settings_json: string
  is_git_repo: number | null
}

function mapRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    gitRemoteUrl: row.git_remote_url ?? undefined,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    settingsJson: row.settings_json,
    isGitRepo: row.is_git_repo !== 0
  }
}

export class WorkspaceRepository extends BaseRepository<WorkspaceRow, Workspace> {
  protected readonly tableName = 'workspaces'
  protected mapRow(row: WorkspaceRow): Workspace {
    return mapRow(row)
  }

  create(name: string, repoPath: string, gitRemoteUrl?: string, isGitRepo = true): Workspace {
    const db = this.db()
    const stmt = db.prepare(`
      INSERT INTO workspaces (name, repo_path, git_remote_url, is_git_repo)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(name, repoPath, gitRemoteUrl ?? null, isGitRepo ? 1 : 0) as WorkspaceRow
    return mapRow(row)
  }

  findAll(): Workspace[] {
    const db = this.db()
    const stmt = db.prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC')
    const rows = stmt.all() as WorkspaceRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Workspace | undefined {
    const db = this.db()
    const stmt = db.prepare('SELECT * FROM workspaces WHERE id = ?')
    const row = stmt.get(id) as WorkspaceRow | undefined
    return row ? mapRow(row) : undefined
  }

  findByPath(repoPath: string): Workspace | undefined {
    const db = this.db()
    const stmt = db.prepare('SELECT * FROM workspaces WHERE repo_path = ?')
    const row = stmt.get(repoPath) as WorkspaceRow | undefined
    return row ? mapRow(row) : undefined
  }

  updateLastOpened(id: string): Workspace | undefined {
    const db = this.db()
    const stmt = db.prepare(`
      UPDATE workspaces SET last_opened_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(id) as WorkspaceRow | undefined
    return row ? mapRow(row) : undefined
  }

  delete(id: string): void {
    const db = this.db()
    const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?')
    stmt.run(id)
  }

  updateSettings(id: string, settings: Record<string, unknown>): Workspace | undefined {
    const db = this.db()
    const stmt = db.prepare(`
      UPDATE workspaces SET settings_json = ?
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(JSON.stringify(settings), id) as WorkspaceRow | undefined
    return row ? mapRow(row) : undefined
  }

  getSettings(id: string): WorkspaceSettings {
    const workspace = this.findById(id)
    if (!workspace) return {}
    try {
      return JSON.parse(workspace.settingsJson || '{}') as WorkspaceSettings
    } catch {
      return {}
    }
  }

  /** Get settings for a workspace by its repo path (used when only path is available) */
  getSettingsByPath(repoPath: string): WorkspaceSettings {
    const db = this.db()
    const row = db.prepare('SELECT * FROM workspaces WHERE repo_path = ?').get(repoPath) as
      | WorkspaceRow
      | undefined
    if (!row) return {}
    try {
      return JSON.parse(row.settings_json || '{}') as WorkspaceSettings
    } catch {
      return {}
    }
  }
}

export const workspaceRepository = new WorkspaceRepository()

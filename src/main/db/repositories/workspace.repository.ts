import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
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
  constitution_md: string | null
  constitution_version: string | null
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
    isGitRepo: row.is_git_repo !== 0,
    constitutionMd: row.constitution_md ?? undefined,
    constitutionVersion: row.constitution_version ?? undefined
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
    // DB-07: Use safeParseJSON for logged fallback on corrupted JSON
    return safeParseJSON<WorkspaceSettings>(workspace.settingsJson, {})
  }

  /** Get settings for a workspace by its repo path (used when only path is available) */
  getSettingsByPath(repoPath: string): WorkspaceSettings {
    const db = this.db()
    const row = db.prepare('SELECT * FROM workspaces WHERE repo_path = ?').get(repoPath) as
      | WorkspaceRow
      | undefined
    if (!row) return {}
    // DB-07: Use safeParseJSON for logged fallback on corrupted JSON
    return safeParseJSON<WorkspaceSettings>(row.settings_json, {})
  }

  /** Update workspace constitution markdown and version. */
  updateConstitution(
    id: string,
    constitutionMd: string,
    version: string = '1.0.0'
  ): Workspace | undefined {
    const row = this.db()
      .prepare(
        `UPDATE workspaces SET constitution_md = ?, constitution_version = ? WHERE id = ? RETURNING *`
      )
      .get(constitutionMd, version, id) as WorkspaceRow | undefined
    return row ? mapRow(row) : undefined
  }
}

export const workspaceRepository = new WorkspaceRepository()

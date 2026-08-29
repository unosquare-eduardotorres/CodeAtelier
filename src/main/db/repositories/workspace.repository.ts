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
  shadow_of_workspace_id: string | null
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
    constitutionVersion: row.constitution_version ?? undefined,
    shadowOfWorkspaceId: row.shadow_of_workspace_id ?? undefined
  }
}

/**
 * Model-routing keys a shadow (worktree) workspace inherits from its parent
 * when the shadow row doesn't define them itself.
 *
 * Routing only: provider selection, role bindings and provider connection
 * details. Everything else (jira.*, watcher flags, view state, gate-command
 * overrides, tokens for unrelated integrations) stays per-workspace — a
 * worktree must not silently gain the parent's GitHub credentials or UI state.
 */
const SHADOW_ROUTED_SETTING_KEYS = new Set([
  'llmProvider',
  'modelRoles',
  'modelOverrides',
  'costPreference',
  'localLlmBackend'
])

/** Connection-detail key families inherited by prefix: glm*, openCode*, localLlm*. */
const SHADOW_ROUTED_SETTING_PREFIXES = [/^glm/, /^openCode/, /^localLlm/]

function isRoutingSettingKey(key: string): boolean {
  return (
    SHADOW_ROUTED_SETTING_KEYS.has(key) ||
    SHADOW_ROUTED_SETTING_PREFIXES.some((re) => re.test(key))
  )
}

/**
 * Merge a shadow workspace's settings over its parent's routing keys.
 *
 * Pure. The shadow's own values always win (undefined/null count as absent);
 * only routing keys are inherited; non-routing parent keys are dropped.
 * Used both to seed new shadow rows (ensureShadow) and to heal pre-existing
 * bare shadow rows at read time (getSettings / getSettingsByPath) — phase
 * services run with the worktree path, so without this a shadow row's
 * `settings_json = '{}'` routed every blueprint phase to the Claude default
 * even when the parent workspace was fully GLM-configured.
 */
export function mergeShadowRoutingSettings(
  shadow: WorkspaceSettings,
  parent: WorkspaceSettings
): WorkspaceSettings {
  const merged: WorkspaceSettings = { ...shadow }
  for (const [key, value] of Object.entries(parent)) {
    if (!isRoutingSettingKey(key)) continue
    if (merged[key] === undefined || merged[key] === null) merged[key] = value
  }
  return merged
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

  /**
   * Every *real* workspace, newest-opened first.
   *
   * Shadow rows (per-worktree index scopes) are excluded here rather than at the
   * call sites: this is the enumeration the tray, the workspace picker, the
   * landing service and session lookup all read, and a shadow surfacing in any
   * of them would look like a duplicate workspace to the user.
   */
  findAll(): Workspace[] {
    const db = this.db()
    const stmt = db.prepare(
      'SELECT * FROM workspaces WHERE shadow_of_workspace_id IS NULL ORDER BY last_opened_at DESC'
    )
    const rows = stmt.all() as WorkspaceRow[]
    return rows.map(mapRow)
  }

  /**
   * The workspace-shaped row that scopes a worktree's own code-graph index.
   *
   * Created on demand and reused thereafter, keyed on the worktree path (which
   * `repo_path` already makes unique). Callers pass the returned id wherever a
   * workspace id scopes graph data, so the graph tables, their repositories and
   * the MCP server stay entirely unaware that tracks exist.
   */
  ensureShadow(parentWorkspaceId: string, worktreePath: string, label: string): Workspace {
    const db = this.db()
    const existing = db
      .prepare('SELECT * FROM workspaces WHERE repo_path = ?')
      .get(worktreePath) as WorkspaceRow | undefined
    if (existing) return mapRow(existing)

    // Seed the row with the parent's model-routing keys so it is self-describing
    // for raw-SQL consumers. Read paths additionally merge at read time, which
    // heals shadow rows created before this seeding existed.
    const parentRow = db
      .prepare('SELECT settings_json FROM workspaces WHERE id = ?')
      .get(parentWorkspaceId) as Pick<WorkspaceRow, 'settings_json'> | undefined
    const parentSettings = parentRow
      ? safeParseJSON<WorkspaceSettings>(parentRow.settings_json, {})
      : {}
    const seeded = mergeShadowRoutingSettings({}, parentSettings)

    const row = db
      .prepare(
        `INSERT INTO workspaces (name, repo_path, is_git_repo, shadow_of_workspace_id, settings_json)
         VALUES (?, ?, 1, ?, ?)
         RETURNING *`
      )
      .get(label, worktreePath, parentWorkspaceId, JSON.stringify(seeded)) as WorkspaceRow
    return mapRow(row)
  }

  /** Shadow rows belonging to a workspace. */
  findShadows(parentWorkspaceId: string): Workspace[] {
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM workspaces WHERE shadow_of_workspace_id = ?')
      .all(parentWorkspaceId) as WorkspaceRow[]
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

  /**
   * Re-record whether the workspace is a git repository.
   *
   * `is_git_repo` was previously written once at registration and never revisited,
   * so a directory that became a repo afterwards (`git init` by hand, or an
   * auto-init that failed at registration time) stayed marked `false` forever.
   * Returns undefined when the row is gone.
   */
  updateIsGitRepo(id: string, isGitRepo: boolean): Workspace | undefined {
    const db = this.db()
    const stmt = db.prepare(`
      UPDATE workspaces SET is_git_repo = ?
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(isGitRepo ? 1 : 0, id) as WorkspaceRow | undefined
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
    return this.settingsWithShadowMerge(workspace)
  }

  /** Get settings for a workspace by its repo path (used when only path is available) */
  getSettingsByPath(repoPath: string): WorkspaceSettings {
    const db = this.db()
    const row = db.prepare('SELECT * FROM workspaces WHERE repo_path = ?').get(repoPath) as
      WorkspaceRow | undefined
    if (!row) return {}
    return this.settingsWithShadowMerge(mapRow(row))
  }

  /**
   * Parse a workspace's settings, inheriting the parent's model-routing keys
   * when this row is a shadow (worktree scope). No-op for real workspaces and
   * for shadows whose parent is gone.
   */
  private settingsWithShadowMerge(workspace: Workspace): WorkspaceSettings {
    // DB-07: Use safeParseJSON for logged fallback on corrupted JSON
    const own = safeParseJSON<WorkspaceSettings>(workspace.settingsJson, {})
    if (!workspace.shadowOfWorkspaceId) return own
    let parentRow: Pick<WorkspaceRow, 'settings_json'> | undefined
    try {
      parentRow = this.db()
        .prepare('SELECT settings_json FROM workspaces WHERE id = ?')
        .get(workspace.shadowOfWorkspaceId) as Pick<WorkspaceRow, 'settings_json'> | undefined
    } catch {
      return own
    }
    if (!parentRow) return own
    const parent = safeParseJSON<WorkspaceSettings>(parentRow.settings_json, {})
    return mergeShadowRoutingSettings(own, parent)
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

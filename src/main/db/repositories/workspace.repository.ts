import { getDatabase } from '../index';
import type { Workspace } from '../../../shared/types';

interface WorkspaceRow {
  id: string;
  name: string;
  repo_path: string;
  git_remote_url: string | null;
  created_at: string;
  last_opened_at: string;
  settings_json: string;
}

function mapRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    gitRemoteUrl: row.git_remote_url ?? undefined,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    settingsJson: row.settings_json
  };
}

export class WorkspaceRepository {
  create(name: string, repoPath: string, gitRemoteUrl?: string): Workspace {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO workspaces (name, repo_path, git_remote_url)
      VALUES (?, ?, ?)
      RETURNING *
    `);
    const row = stmt.get(name, repoPath, gitRemoteUrl ?? null) as WorkspaceRow;
    return mapRow(row);
  }

  findAll(): Workspace[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC');
    const rows = stmt.all() as WorkspaceRow[];
    return rows.map(mapRow);
  }

  findById(id: string): Workspace | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');
    const row = stmt.get(id) as WorkspaceRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  updateLastOpened(id: string): Workspace | undefined {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE workspaces SET last_opened_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id) as WorkspaceRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  delete(id: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?');
    stmt.run(id);
  }
}

export const workspaceRepository = new WorkspaceRepository();

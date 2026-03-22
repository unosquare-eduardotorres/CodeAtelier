import { getDatabase } from '../index';
import type { Skill } from '../../../shared/types';

interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  filename: string;
  file_path: string;
  is_active: number;
  last_updated_date: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    filename: row.filename,
    filePath: row.file_path,
    isActive: row.is_active === 1,
    lastUpdatedDate: row.last_updated_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  filename: string;
  filePath: string;
  isActive?: boolean;
  lastUpdatedDate?: string;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
}

export class SkillRepository {
  findAll(): Skill[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as SkillRow[];
    return rows.map(mapRow);
  }

  findById(id: string): Skill | undefined {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByFilename(filename: string): Skill | undefined {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM skills WHERE filename = ?').get(filename) as SkillRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findActive(): Skill[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM skills WHERE is_active = 1 ORDER BY name ASC').all() as SkillRow[];
    return rows.map(mapRow);
  }

  create(data: CreateSkillInput): Skill {
    const db = getDatabase();
    const row = db.prepare(`
      INSERT INTO skills (name, description, filename, file_path, is_active, last_updated_date)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      data.name,
      data.description ?? '',
      data.filename,
      data.filePath,
      data.isActive !== false ? 1 : 0,
      data.lastUpdatedDate ?? null
    ) as SkillRow;
    return mapRow(row);
  }

  update(id: string, data: UpdateSkillInput): Skill {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description); }

    if (sets.length === 0) {
      const existing = this.findById(id);
      if (!existing) throw new Error(`Skill not found: ${id}`);
      return existing;
    }

    sets.push("updated_at = datetime('now')");
    values.push(id);

    const row = db.prepare(`
      UPDATE skills SET ${sets.join(', ')}
      WHERE id = ?
      RETURNING *
    `).get(...values) as SkillRow | undefined;

    if (!row) throw new Error(`Skill not found: ${id}`);
    return mapRow(row);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  setActive(id: string, isActive: boolean): Skill {
    const db = getDatabase();
    const row = db.prepare(`
      UPDATE skills SET is_active = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `).get(isActive ? 1 : 0, id) as SkillRow | undefined;

    if (!row) throw new Error(`Skill not found: ${id}`);
    return mapRow(row);
  }
}

export const skillRepository = new SkillRepository();

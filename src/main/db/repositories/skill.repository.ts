import { getDatabase } from '../index'
import type { BudgetTier, Skill } from '../../../shared/types'

interface SkillRow {
  id: string
  name: string
  description: string | null
  filename: string
  file_path: string
  is_active: number
  last_updated_date: string | null
  created_at: string
  updated_at: string
  summary_full: string | null
  summary_standard: string | null
  summary_minimal: string | null
  summary_hash: string | null
  tier1_json: string | null
  tier2_instructions: string | null
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
    updatedAt: row.updated_at,
    summaryFull: row.summary_full,
    summaryStandard: row.summary_standard,
    summaryMinimal: row.summary_minimal,
    summaryHash: row.summary_hash,
    tier1Json: row.tier1_json,
    tier2Instructions: row.tier2_instructions
  }
}

export interface CreateSkillInput {
  name: string
  description?: string
  filename: string
  filePath: string
  isActive?: boolean
  lastUpdatedDate?: string
  tier1Json?: string
  tier2Instructions?: string
}

export interface UpdateSkillInput {
  name?: string
  description?: string
}

export class SkillRepository {
  findAll(): Skill[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as SkillRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Skill | undefined {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
    return row ? mapRow(row) : undefined
  }

  findByFilename(filename: string): Skill | undefined {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM skills WHERE filename = ?').get(filename) as
      | SkillRow
      | undefined
    return row ? mapRow(row) : undefined
  }

  findActive(): Skill[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM skills WHERE is_active = 1 ORDER BY name ASC')
      .all() as SkillRow[]
    return rows.map(mapRow)
  }

  create(data: CreateSkillInput): Skill {
    const db = getDatabase()
    const row = db
      .prepare(
        `
      INSERT INTO skills (name, description, filename, file_path, is_active, last_updated_date, tier1_json, tier2_instructions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `
      )
      .get(
        data.name,
        data.description ?? '',
        data.filename,
        data.filePath,
        data.isActive !== false ? 1 : 0,
        data.lastUpdatedDate ?? null,
        data.tier1Json ?? null,
        data.tier2Instructions ?? null
      ) as SkillRow
    return mapRow(row)
  }

  update(id: string, data: UpdateSkillInput): Skill {
    const db = getDatabase()
    const sets: string[] = []
    const values: unknown[] = []

    if (data.name !== undefined) {
      sets.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      sets.push('description = ?')
      values.push(data.description)
    }

    if (sets.length === 0) {
      const existing = this.findById(id)
      if (!existing) throw new Error(`Skill not found: ${id}`)
      return existing
    }

    sets.push("updated_at = datetime('now')")
    values.push(id)

    const row = db
      .prepare(
        `
      UPDATE skills SET ${sets.join(', ')}
      WHERE id = ?
      RETURNING *
    `
      )
      .get(...values) as SkillRow | undefined

    if (!row) throw new Error(`Skill not found: ${id}`)
    return mapRow(row)
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  deleteAll(): void {
    const db = getDatabase()
    db.prepare('DELETE FROM specialist_skills').run()
    db.prepare('DELETE FROM skills').run()
  }

  setActive(id: string, isActive: boolean): Skill {
    const db = getDatabase()
    const row = db
      .prepare(
        `
      UPDATE skills SET is_active = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `
      )
      .get(isActive ? 1 : 0, id) as SkillRow | undefined

    if (!row) throw new Error(`Skill not found: ${id}`)
    return mapRow(row)
  }

  /** Store pre-computed semantic summaries for a skill */
  updateSummaries(
    skillId: string,
    summaries: { full: string; standard: string; minimal: string; hash: string }
  ): void {
    const db = getDatabase()
    db.prepare(
      `
      UPDATE skills SET
        summary_full = ?,
        summary_standard = ?,
        summary_minimal = ?,
        summary_hash = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(summaries.full, summaries.standard, summaries.minimal, summaries.hash, skillId)
  }

  /** Update tier1/tier2 progressive loading data for a skill */
  updateTiers(skillId: string, tier1Json: string, tier2Instructions: string): void {
    const db = getDatabase()
    db.prepare(
      `
      UPDATE skills SET
        tier1_json = ?,
        tier2_instructions = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(tier1Json, tier2Instructions, skillId)
  }

  /** Get all active skills' tier1 metadata for fast keyword matching */
  getActiveTier1Data(): Array<{ id: string; name: string; tier1Json: string | null }> {
    const db = getDatabase()
    return db
      .prepare('SELECT id, name, tier1_json as tier1Json FROM skills WHERE is_active = 1')
      .all() as Array<{ id: string; name: string; tier1Json: string | null }>
  }

  /** Get pre-computed summary for a specific budget tier */
  getSummary(skillId: string, tier: BudgetTier): string | null {
    const col =
      tier === 'full'
        ? 'summary_full'
        : tier === 'standard'
          ? 'summary_standard'
          : 'summary_minimal'
    const db = getDatabase()
    const row = db.prepare(`SELECT ${col} as summary FROM skills WHERE id = ?`).get(skillId) as
      | { summary: string | null }
      | undefined
    return row?.summary ?? null
  }
}

export const skillRepository = new SkillRepository()

import { getDatabase } from '../index'
import type { Specialist, Skill } from '../../../shared/types'

interface SpecialistRow {
  id: string
  agent_id: string
  display_name: string
  icon: string
  color: string
  prompt: string | null
  priority: number
  is_active: number
  source_yaml: string | null
  created_at: string
  updated_at: string
}

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
}

function mapRow(row: SpecialistRow): Specialist {
  return {
    id: row.id,
    agentId: row.agent_id,
    displayName: row.display_name,
    icon: row.icon,
    color: row.color,
    prompt: row.prompt ?? '',
    priority: row.priority,
    isActive: row.is_active === 1,
    sourceYaml: row.source_yaml ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapSkillRow(row: SkillRow): Skill {
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
  }
}

export interface CreateSpecialistInput {
  agentId: string
  displayName: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  sourceYaml?: string | null
  isActive?: boolean
}

export interface UpdateSpecialistInput {
  displayName?: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  isActive?: boolean
  sourceYaml?: string | null
}

export class SpecialistRepository {
  findAll(): Specialist[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM specialists ORDER BY priority ASC')
      .all() as SpecialistRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Specialist | undefined {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM specialists WHERE id = ?').get(id) as
      | SpecialistRow
      | undefined
    return row ? mapRow(row) : undefined
  }

  findByAgentId(agentId: string): Specialist | undefined {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM specialists WHERE agent_id = ?').get(agentId) as
      | SpecialistRow
      | undefined
    return row ? mapRow(row) : undefined
  }

  findActive(): Specialist[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM specialists WHERE is_active = 1 ORDER BY priority ASC')
      .all() as SpecialistRow[]
    return rows.map(mapRow)
  }

  create(data: CreateSpecialistInput): Specialist {
    const db = getDatabase()
    const row = db
      .prepare(
        `
      INSERT INTO specialists (agent_id, display_name, icon, color, prompt, priority, source_yaml, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `
      )
      .get(
        data.agentId,
        data.displayName,
        data.icon ?? '🔧',
        data.color ?? '#6366F1',
        data.prompt ?? '',
        data.priority ?? 100,
        data.sourceYaml ?? null,
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : 0
      ) as SpecialistRow
    return mapRow(row)
  }

  update(id: string, data: UpdateSpecialistInput): Specialist {
    const db = getDatabase()
    const sets: string[] = []
    const values: unknown[] = []

    if (data.displayName !== undefined) {
      sets.push('display_name = ?')
      values.push(data.displayName)
    }
    if (data.icon !== undefined) {
      sets.push('icon = ?')
      values.push(data.icon)
    }
    if (data.color !== undefined) {
      sets.push('color = ?')
      values.push(data.color)
    }
    if (data.prompt !== undefined) {
      sets.push('prompt = ?')
      values.push(data.prompt)
    }
    if (data.priority !== undefined) {
      sets.push('priority = ?')
      values.push(data.priority)
    }
    if (data.isActive !== undefined) {
      sets.push('is_active = ?')
      values.push(data.isActive ? 1 : 0)
    }
    if (data.sourceYaml !== undefined) {
      sets.push('source_yaml = ?')
      values.push(data.sourceYaml)
    }

    if (sets.length === 0) {
      const existing = this.findById(id)
      if (!existing) throw new Error(`Specialist not found: ${id}`)
      return existing
    }

    sets.push("updated_at = datetime('now')")
    values.push(id)

    const row = db
      .prepare(
        `
      UPDATE specialists SET ${sets.join(', ')}
      WHERE id = ?
      RETURNING *
    `
      )
      .get(...values) as SpecialistRow | undefined

    if (!row) throw new Error(`Specialist not found: ${id}`)
    return mapRow(row)
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM specialists WHERE id = ?').run(id)
  }

  deleteAll(): void {
    const db = getDatabase()
    db.prepare('DELETE FROM specialist_skills').run()
    db.prepare('DELETE FROM specialists').run()
  }

  assignSkill(specialistId: string, skillId: string): void {
    const db = getDatabase()
    db.prepare(
      `
      INSERT OR IGNORE INTO specialist_skills (specialist_id, skill_id)
      VALUES (?, ?)
    `
    ).run(specialistId, skillId)
  }

  removeSkill(specialistId: string, skillId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM specialist_skills WHERE specialist_id = ? AND skill_id = ?').run(
      specialistId,
      skillId
    )
  }

  getSkills(specialistId: string): Skill[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `
      SELECT s.* FROM skills s
      INNER JOIN specialist_skills ss ON ss.skill_id = s.id
      WHERE ss.specialist_id = ?
      ORDER BY s.name ASC
    `
      )
      .all(specialistId) as SkillRow[]
    return rows.map(mapSkillRow)
  }

  findSpecialistsForSkill(skillId: string): Specialist[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `
      SELECT sp.* FROM specialists sp
      INNER JOIN specialist_skills ss ON ss.specialist_id = sp.id
      WHERE ss.skill_id = ?
      ORDER BY sp.priority ASC
    `
      )
      .all(skillId) as SpecialistRow[]
    return rows.map(mapRow)
  }

  canDelete(id: string): { allowed: boolean; blockingSkills?: string[] } {
    const db = getDatabase()
    // Find active skills where this specialist is the ONLY specialist assigned
    const blockingSkills = db
      .prepare(
        `
      SELECT s.name FROM skills s
      INNER JOIN specialist_skills ss ON ss.skill_id = s.id
      WHERE s.is_active = 1
        AND ss.specialist_id = ?
        AND (SELECT COUNT(*) FROM specialist_skills ss2 WHERE ss2.skill_id = s.id) = 1
    `
      )
      .all(id) as { name: string }[]

    if (blockingSkills.length > 0) {
      return { allowed: false, blockingSkills: blockingSkills.map((s) => s.name) }
    }
    return { allowed: true }
  }
}

export const specialistRepository = new SpecialistRepository()

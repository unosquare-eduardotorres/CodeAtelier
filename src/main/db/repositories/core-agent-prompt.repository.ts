import { BaseRepository } from '../base-repository'
import type { CoreAgentPrompt } from '../../../shared/types'

interface CoreAgentPromptRow {
  id: string
  agent_role: 'da-vinci'
  mode: 'plan' | 'build' | 'danger'
  prompt_text: string
  default_prompt_text: string
  is_custom: number
  updated_at: string
}

function mapRow(row: CoreAgentPromptRow): CoreAgentPrompt {
  return {
    id: row.id,
    agentRole: row.agent_role,
    mode: row.mode,
    promptText: row.prompt_text,
    defaultPromptText: row.default_prompt_text,
    isCustom: row.is_custom === 1,
    updatedAt: row.updated_at
  }
}

export class CoreAgentPromptRepository extends BaseRepository<CoreAgentPromptRow, CoreAgentPrompt> {
  protected readonly tableName = 'core_agent_prompts'
  protected mapRow(row: CoreAgentPromptRow): CoreAgentPrompt { return mapRow(row) }

  findAll(): CoreAgentPrompt[] {
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM core_agent_prompts ORDER BY agent_role, mode')
      .all() as CoreAgentPromptRow[]
    return rows.map(mapRow)
  }

  findByRoleAndMode(agentRole: 'da-vinci', mode: 'plan' | 'build' | 'danger'): CoreAgentPrompt | undefined {
    const db = this.db()
    const row = db
      .prepare('SELECT * FROM core_agent_prompts WHERE agent_role = ? AND mode = ?')
      .get(agentRole, mode) as CoreAgentPromptRow | undefined
    return row ? mapRow(row) : undefined
  }

  upsert(agentRole: 'da-vinci', mode: 'plan' | 'build' | 'danger', promptText: string): CoreAgentPrompt {
    const db = this.db()
    const row = db
      .prepare(
        `
      UPDATE core_agent_prompts
      SET prompt_text = ?,
          is_custom = 1,
          updated_at = datetime('now')
      WHERE agent_role = ? AND mode = ?
      RETURNING *
    `
      )
      .get(promptText, agentRole, mode) as CoreAgentPromptRow | undefined

    if (!row) {
      throw new Error(`Core agent prompt not found: ${agentRole}/${mode}`)
    }
    return mapRow(row)
  }

  resetToDefault(agentRole: 'da-vinci', mode: 'plan' | 'build' | 'danger'): CoreAgentPrompt {
    const db = this.db()
    const row = db
      .prepare(
        `
      UPDATE core_agent_prompts
      SET prompt_text = default_prompt_text,
          is_custom = 0,
          updated_at = datetime('now')
      WHERE agent_role = ? AND mode = ?
      RETURNING *
    `
      )
      .get(agentRole, mode) as CoreAgentPromptRow | undefined

    if (!row) {
      throw new Error(`Core agent prompt not found: ${agentRole}/${mode}`)
    }
    return mapRow(row)
  }
}

export const coreAgentPromptRepository = new CoreAgentPromptRepository()

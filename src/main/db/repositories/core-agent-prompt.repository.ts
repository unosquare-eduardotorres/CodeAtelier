import { getDatabase } from '../index'
import type { CoreAgentPrompt } from '../../../shared/types'

interface CoreAgentPromptRow {
  id: string
  agent_role: 'generalist' | 'orchestrator'
  mode: 'plan' | 'build'
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

export class CoreAgentPromptRepository {
  findAll(): CoreAgentPrompt[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM core_agent_prompts ORDER BY agent_role, mode')
      .all() as CoreAgentPromptRow[]
    return rows.map(mapRow)
  }

  findByRoleAndMode(
    agentRole: 'generalist' | 'orchestrator',
    mode: 'plan' | 'build'
  ): CoreAgentPrompt | undefined {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM core_agent_prompts WHERE agent_role = ? AND mode = ?')
      .get(agentRole, mode) as CoreAgentPromptRow | undefined
    return row ? mapRow(row) : undefined
  }

  upsert(
    agentRole: 'generalist' | 'orchestrator',
    mode: 'plan' | 'build',
    promptText: string
  ): CoreAgentPrompt {
    const db = getDatabase()
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

  resetToDefault(
    agentRole: 'generalist' | 'orchestrator',
    mode: 'plan' | 'build'
  ): CoreAgentPrompt {
    const db = getDatabase()
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

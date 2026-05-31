import { BaseRepository } from '../base-repository'
import type { CoreAgentAlias } from '../../../shared/types'

interface CoreAgentAliasRow {
  agent_role: 'da-vinci'
  alias: string | null
  avatar_key: string | null
  updated_at: string
}

function mapRow(row: CoreAgentAliasRow): CoreAgentAlias {
  return {
    agentRole: row.agent_role,
    alias: row.alias,
    avatarKey: row.avatar_key,
    updatedAt: row.updated_at
  }
}

export class CoreAgentAliasRepository extends BaseRepository<CoreAgentAliasRow, CoreAgentAlias> {
  protected readonly tableName = 'core_agent_aliases'
  protected mapRow(row: CoreAgentAliasRow): CoreAgentAlias { return mapRow(row) }

  findAll(): CoreAgentAlias[] {
    const db = this.db()
    const rows = db.prepare('SELECT * FROM core_agent_aliases').all() as CoreAgentAliasRow[]
    return rows.map(mapRow)
  }

  upsert(agentRole: 'da-vinci', alias: string | null, avatarKey: string | null): CoreAgentAlias {
    const db = this.db()
    const row = db
      .prepare(
        `
      INSERT INTO core_agent_aliases (agent_role, alias, avatar_key, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(agent_role) DO UPDATE SET
        alias = excluded.alias,
        avatar_key = excluded.avatar_key,
        updated_at = datetime('now')
      RETURNING *
    `
      )
      .get(agentRole, alias, avatarKey) as CoreAgentAliasRow
    return mapRow(row)
  }
}

export const coreAgentAliasRepository = new CoreAgentAliasRepository()

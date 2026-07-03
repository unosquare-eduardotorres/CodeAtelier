/**
 * preset.repository — CRUD for named LLM configuration presets.
 *
 * Each workspace has built-in presets ("Full Claude", "Full Local") and
 * user-created custom presets. A preset maps ModelAction → ActionModelConfig
 * via a sparse JSON column. Unset actions fall through to DEFAULT_MODEL_CONFIG.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { ActionModelConfig, LLMPreset, ModelAction } from '../../../shared/types'
import {
  buildClaudeModelConfig,
  BUILTIN_CLAUDE_MODEL_PRESETS
} from '../../../shared/constants'

// ── Row shape (snake_case from DB) ──

interface PresetRow {
  id: string
  workspace_id: string
  name: string
  is_built_in: number
  action_config_json: string
  created_at: string
  updated_at: string
}

function mapRow(row: PresetRow): LLMPreset {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    isBuiltIn: row.is_built_in === 1,
    actionConfig: safeParseJSON<Partial<Record<ModelAction, ActionModelConfig>>>(
      row.action_config_json,
      {}
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Repository ──

export class PresetRepository extends BaseRepository<PresetRow, LLMPreset> {
  protected readonly tableName = 'llm_presets'
  protected mapRow(row: PresetRow): LLMPreset {
    return mapRow(row)
  }

  /** Get all presets for a workspace (built-in first, then custom by name). */
  getAll(workspaceId: string): LLMPreset[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM llm_presets WHERE workspace_id = ? ORDER BY is_built_in DESC, name ASC`
      )
      .all(workspaceId) as PresetRow[]
    return rows.map(mapRow)
  }

  /** Get a single preset by ID. */
  getById(presetId: string): LLMPreset | null {
    const row = this.db().prepare('SELECT * FROM llm_presets WHERE id = ?').get(presetId) as
      | PresetRow
      | undefined
    return row ? mapRow(row) : null
  }

  /** Create a custom preset. */
  create(
    workspaceId: string,
    name: string,
    actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  ): LLMPreset {
    const row = this.db()
      .prepare(
        `INSERT INTO llm_presets (workspace_id, name, is_built_in, action_config_json)
         VALUES (?, ?, 0, ?)
         RETURNING *`
      )
      .get(workspaceId, name, JSON.stringify(actionConfig)) as PresetRow
    return mapRow(row)
  }

  /** Update a custom preset's name and/or action config. */
  update(
    presetId: string,
    changes: { name?: string; actionConfig?: Partial<Record<ModelAction, ActionModelConfig>> }
  ): LLMPreset | null {
    const existing = this.getById(presetId)
    if (!existing || existing.isBuiltIn) return null

    const name = changes.name ?? existing.name
    const actionConfig = changes.actionConfig ?? existing.actionConfig

    const row = this.db()
      .prepare(
        `UPDATE llm_presets
         SET name = ?, action_config_json = ?, updated_at = datetime('now')
         WHERE id = ? AND is_built_in = 0
         RETURNING *`
      )
      .get(name, JSON.stringify(actionConfig), presetId) as PresetRow | undefined
    return row ? mapRow(row) : null
  }

  /** Delete a custom preset (built-in presets cannot be deleted). */
  delete(presetId: string): boolean {
    const result = this.db()
      .prepare('DELETE FROM llm_presets WHERE id = ? AND is_built_in = 0')
      .run(presetId)
    return result.changes > 0
  }

  /**
   * Ensure built-in presets exist for a workspace.
   * Called on workspace creation and migration.
   */
  ensureBuiltIns(workspaceId: string): void {
    const insert = this.db().prepare(`
      INSERT OR IGNORE INTO llm_presets (id, workspace_id, name, is_built_in, action_config_json)
      VALUES (?, ?, ?, 1, ?)
    `)
    insert.run(`${workspaceId}_full-claude`, workspaceId, 'Full Claude', '{}')
    insert.run(`${workspaceId}_full-local`, workspaceId, 'Full Local', '{}')

    // Seed per-model Claude presets (chat-group actions only)
    for (const preset of BUILTIN_CLAUDE_MODEL_PRESETS) {
      insert.run(
        `${workspaceId}_${preset.suffix}`,
        workspaceId,
        preset.name,
        JSON.stringify(buildClaudeModelConfig(preset.modelId))
      )
    }
  }
}

export const presetRepository = new PresetRepository()

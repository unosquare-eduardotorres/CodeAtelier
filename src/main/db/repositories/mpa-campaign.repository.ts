import { BaseRepository } from '../base-repository'
import type { MpaCampaign, MpaCampaignStatus } from '../../../shared/mpa-types'

// ── Row interface ──

interface MpaCampaignRow {
  id: string
  workspace_id: string
  title: string
  original_plan_md: string
  status: string
  created_at: string
  completed_at: string | null
}

// ── Mapper ──

function mapRow(row: MpaCampaignRow): MpaCampaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    originalPlanMd: row.original_plan_md,
    status: row.status as MpaCampaignStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

// ── Repository ──

export class MpaCampaignRepository extends BaseRepository<MpaCampaignRow, MpaCampaign> {
  protected readonly tableName = 'mpa_campaigns'
  protected mapRow(row: MpaCampaignRow): MpaCampaign {
    return mapRow(row)
  }

  create(params: { workspaceId: string; title: string; originalPlanMd: string }): MpaCampaign {
    const row = this.db()
      .prepare(
        `INSERT INTO mpa_campaigns (workspace_id, title, original_plan_md)
         VALUES (?, ?, ?)
         RETURNING *`
      )
      .get(params.workspaceId, params.title, params.originalPlanMd) as MpaCampaignRow
    return mapRow(row)
  }

  override findById(id: string): MpaCampaign | undefined {
    return this.findOneBy('id', id)
  }

  findByWorkspace(workspaceId: string, limit = 20): MpaCampaign[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM mpa_campaigns
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(workspaceId, limit) as MpaCampaignRow[]
    return rows.map(mapRow)
  }

  updateStatus(id: string, status: MpaCampaignStatus): MpaCampaign | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? new Date().toISOString()
        : null
    const row = this.db()
      .prepare(
        `UPDATE mpa_campaigns
         SET status = ?, completed_at = COALESCE(?, completed_at)
         WHERE id = ?
         RETURNING *`
      )
      .get(status, completedAt, id) as MpaCampaignRow | undefined
    return row ? mapRow(row) : undefined
  }

  /** Mark all 'running'/'paused' campaigns as failed (stale detection on restart). */
  markStaleAsFailed(): number {
    return this.db()
      .prepare(
        `UPDATE mpa_campaigns SET status = 'failed', completed_at = datetime('now')
         WHERE status IN ('running', 'paused')`
      )
      .run().changes
  }
}

export const mpaCampaignRepository = new MpaCampaignRepository()

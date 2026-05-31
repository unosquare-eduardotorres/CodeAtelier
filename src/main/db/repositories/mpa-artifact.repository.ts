import { BaseRepository } from '../base-repository'
import type { MpaArtifact, MpaArtifactType } from '../../../shared/mpa-types'

// ── Row interface ──

interface MpaArtifactRow {
  id: string
  run_id: string
  phase_id: string | null
  artifact_type: string
  content_json: string
  content_md: string | null
  version: number
  created_at: string
}

// ── Mapper ──

function mapRow(row: MpaArtifactRow): MpaArtifact {
  let contentJson: Record<string, unknown> = {}
  try {
    contentJson = JSON.parse(row.content_json)
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    runId: row.run_id,
    phaseId: row.phase_id,
    artifactType: row.artifact_type as MpaArtifactType,
    contentJson,
    contentMd: row.content_md,
    version: row.version,
    createdAt: row.created_at
  }
}

// ── Repository ──

export class MpaArtifactRepository extends BaseRepository<MpaArtifactRow, MpaArtifact> {
  protected readonly tableName = 'mpa_artifacts'
  protected mapRow(row: MpaArtifactRow): MpaArtifact { return mapRow(row) }

  create(params: {
    runId: string
    phaseId?: string
    artifactType: MpaArtifactType
    contentJson: Record<string, unknown>
    contentMd?: string
    version?: number
  }): MpaArtifact {
    const row = this.db()
      .prepare(
        `INSERT INTO mpa_artifacts (run_id, phase_id, artifact_type, content_json, content_md, version)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.runId,
        params.phaseId ?? null,
        params.artifactType,
        JSON.stringify(params.contentJson),
        params.contentMd ?? null,
        params.version ?? 1
      ) as MpaArtifactRow
    return mapRow(row)
  }

  override findById(id: string): MpaArtifact | undefined {
    return this.findOneBy('id', id)
  }

  findByRun(runId: string): MpaArtifact[] {
    return this.findManyBy('run_id', runId, { orderBy: 'created_at ASC' })
  }


}

export const mpaArtifactRepository = new MpaArtifactRepository()

/**
 * StackDriftDetectorService — detects when a workspace's tech stack has
 * changed since the Project Specialist was last built.
 *
 * Phase 2 of the Project Specialist refactor. Triggered from:
 *   - workspace-open handler (once per session)
 *   - debounced after chat turns (non-blocking)
 *
 * Detection is cheap: detectTechStack() runs in well under 100ms on a normal
 * repo. We compute a fresh SHA-256 fingerprint and compare against the
 * persisted specialists.stack_fingerprint.
 *
 * The result is returned to the renderer as a non-intrusive banner.
 */

import { createHash } from 'node:crypto'
import log from 'electron-log'
import { getDatabase } from '../db/index'
import { detectTechStack } from './tech-stack-detector.service'

const driftLog = log.scope('stack-drift')

export interface DriftReport {
  specialistId: string
  workspaceId: string
  oldFingerprint: string | null
  newFingerprint: string
  added: string[]
  removed: string[]
  drifted: boolean
}

interface Row {
  id: string
  workspace_id: string
  stack_fingerprint: string | null
  detected_techs: string
}

interface WorkspaceRow {
  id: string
  repo_path: string
}

export class StackDriftDetectorService {
  /**
   * Detect drift for a single Project Specialist. Returns null if the workspace
   * has no Project Specialist row yet (pending migration / not built).
   */
  detectForWorkspace(workspaceId: string): DriftReport | null {
    const db = getDatabase()
    const specialist = db
      .prepare(
        `SELECT id, workspace_id, stack_fingerprint, detected_techs
           FROM specialists WHERE workspace_id = ?`
      )
      .get(workspaceId) as Row | undefined
    if (!specialist) return null

    const workspace = db
      .prepare(`SELECT id, repo_path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as WorkspaceRow | undefined
    if (!workspace) return null

    const fresh = detectTechStack(workspace.repo_path)
    const newFingerprint = this.fingerprint(fresh.detectedTechs)

    const prevTechs = this.parseTechs(specialist.detected_techs)
    const added = fresh.detectedTechs.filter((t) => !prevTechs.includes(t))
    const removed = prevTechs.filter((t) => !fresh.detectedTechs.includes(t))

    const drifted =
      specialist.stack_fingerprint !== newFingerprint || added.length > 0 || removed.length > 0

    if (drifted) {
      driftLog.info(
        `[stack-drift] workspace=${workspaceId} +[${added.join(',')}] -[${removed.join(',')}]`
      )
    }

    return {
      specialistId: specialist.id,
      workspaceId,
      oldFingerprint: specialist.stack_fingerprint,
      newFingerprint,
      added,
      removed,
      drifted
    }
  }

  /** Quick boolean check — useful for debounced post-turn hooks. */
  hasDrifted(workspaceId: string): boolean {
    const report = this.detectForWorkspace(workspaceId)
    return report?.drifted ?? false
  }

  private fingerprint(techs: string[]): string {
    const sorted = [...techs].sort()
    return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
  }

  private parseTechs(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw || '[]')
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      return []
    }
  }
}

export const stackDriftDetectorService = new StackDriftDetectorService()

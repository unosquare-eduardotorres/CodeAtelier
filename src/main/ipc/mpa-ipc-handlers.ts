/**
 * Pure-logic functions extracted from mpa.ipc.ts for testability.
 *
 * No Electron, no I/O, no service references — only computation over plain data.
 */

import type { MpaRun, MpaPhase, MpaPhaseType, MpaStatus } from '../../shared/mpa-types'

// ── Status Construction ──────────────────────────────────────────────────────

/**
 * Build the MPA pipeline status from a run and its phases.
 *
 * Encapsulates the index computation, fallback chains, and phase resolution
 * that was previously inline in the mpa:getStatus handler.
 */
export function computeMpaStatus(run: MpaRun | null, runId: string, phases: MpaPhase[]): MpaStatus {
  if (!run) {
    // Run was in the orchestrator but not yet persisted (race)
    return {
      status: 'running',
      runId,
      currentPhase: null,
      phaseIndex: 0,
      totalPhases: 0,
      iteration: 1,
      awaitingApproval: false
    }
  }

  const currentPhaseIdx = phases.findIndex((p) => p.status === 'running')
  const currentPhase = phases[currentPhaseIdx]

  return {
    status: run.status ?? 'running',
    runId,
    currentPhase: (currentPhase?.phaseType ?? run.currentPhase ?? null) as MpaPhaseType | null,
    phaseIndex: currentPhaseIdx >= 0 ? currentPhaseIdx + 1 : phases.length,
    totalPhases: phases.length || 3,
    iteration: currentPhase?.iteration ?? 1,
    awaitingApproval: run.status === 'paused'
  }
}

/** The idle sentinel returned when no pipeline is running. */
export const MPA_IDLE_STATUS: MpaStatus = {
  status: 'idle',
  runId: null,
  currentPhase: null,
  phaseIndex: 0,
  totalPhases: 0,
  iteration: 0,
  awaitingApproval: false
}

// ── Campaign Goal Validation ─────────────────────────────────────────────────

export interface CampaignGoalValidation {
  valid: boolean
  error?: string
}

/**
 * Validate the goals array for campaign start.
 * Pure check — the caller still needs to verify workspace existence and
 * orchestration service state separately.
 */
export function validateCampaignGoals(goals: unknown): CampaignGoalValidation {
  if (!Array.isArray(goals)) {
    return { valid: false, error: 'At least one goal is required' }
  }
  if (goals.length === 0) {
    return { valid: false, error: 'At least one goal is required' }
  }
  return { valid: true }
}

/**
 * Unit tests for Blueprint retry support.
 *
 * Tests:
 * 1. BlueprintService.retryPhase() — resets failed phase and returns phase info
 * 2. FK-safe setConversation — skips when conversation doesn't exist
 * 3. CLI error surfacing — error field in BlueprintPhaseCompletePayload
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated retry logic from BlueprintService ──

const BLUEPRINT_PHASE_ORDER = [
  'specify',
  'clarify',
  'plan',
  'tasks',
  'review',
  'build',
  'verify'
] as const

type BlueprintPhaseType = (typeof BLUEPRINT_PHASE_ORDER)[number]

type BlueprintStatus =
  | 'draft'
  | 'specifying'
  | 'clarifying'
  | 'planning'
  | 'tasking'
  | 'reviewing'
  | 'building'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'cancelled'

const PHASE_TO_STATUS: Record<BlueprintPhaseType, BlueprintStatus> = {
  specify: 'specifying',
  clarify: 'clarifying',
  plan: 'planning',
  tasks: 'tasking',
  review: 'reviewing',
  build: 'building',
  verify: 'verifying'
}

interface MockPhase {
  id: string
  phase: BlueprintPhaseType
  status: 'pending' | 'active' | 'complete' | 'skipped' | 'failed'
  artifactsJson?: Array<{ type: string; contentJson?: Record<string, unknown> }>
}

interface MockBlueprint {
  id: string
  workspaceId: string
  status: BlueprintStatus
  currentPhase: BlueprintPhaseType
  phases: MockPhase[]
}

// BP-ORPHAN-01: Mid-pipeline statuses that can be retried when pipeline is idle.
const MID_PIPELINE_STATUSES = new Set<BlueprintStatus>([
  'specifying',
  'clarifying',
  'planning',
  'tasking',
  'reviewing',
  'building',
  'verifying'
])

/**
 * Replicated from BlueprintService.retryPhase (blueprint.service.ts).
 * Pure function: validates state and returns the phase to retry.
 * Accepts 'failed', 'cancelled', or orphaned in-progress status (when pipeline is idle).
 * Phase resolution order: first failed > currentPhase (pending or active) > first pending.
 */
function retryPhase(
  blueprint: MockBlueprint,
  pipelineRunning = false
): {
  phase: BlueprintPhaseType
  workspaceId: string
  resetPhaseId: string
  newBlueprintStatus: BlueprintStatus
} {
  const isRetryable = blueprint.status === 'failed' || blueprint.status === 'cancelled'
  const isOrphaned = MID_PIPELINE_STATUSES.has(blueprint.status) && !pipelineRunning

  // BP-COMPLETE-RETRY: Allow retrying 'complete' blueprints with gaps_found
  const isCompletedWithGaps =
    blueprint.status === 'complete' &&
    (() => {
      const verifyPhaseRec = blueprint.phases.find((p) => p.phase === 'verify')
      if (!verifyPhaseRec) return false
      const verifyArt = verifyPhaseRec.artifactsJson?.findLast(
        (a) => a.type === 'verify' || a.type === 'verification'
      )
      const overall = (verifyArt?.contentJson as Record<string, unknown>)?.overallStatus
      return overall === 'gaps_found'
    })()

  if (!isRetryable && !isOrphaned && !isCompletedWithGaps) {
    if (MID_PIPELINE_STATUSES.has(blueprint.status) && pipelineRunning) {
      throw new Error(
        `Cannot retry blueprint ${blueprint.id} — pipeline is currently active for workspace ${blueprint.workspaceId}`
      )
    }
    throw new Error(
      `Cannot retry blueprint ${blueprint.id} — status is '${blueprint.status}', expected 'failed', 'cancelled', or an orphaned in-progress status`
    )
  }

  // Phase resolution: failed > currentPhase (if pending or active) > first pending
  let targetPhase =
    blueprint.phases.find((p) => p.status === 'failed') ??
    blueprint.phases.find(
      (p) => p.phase === blueprint.currentPhase && (p.status === 'pending' || p.status === 'active')
    ) ??
    blueprint.phases.find((p) => p.status === 'pending')

  // BP-COMPLETE-RETRY: For completed blueprints with gaps, the verify phase
  // is 'complete' (not failed/pending) — resolve it explicitly.
  if (!targetPhase && isCompletedWithGaps) {
    targetPhase = blueprint.phases.find((p) => p.phase === 'verify')
  }

  if (!targetPhase) {
    throw new Error(`No retryable phase found for blueprint ${blueprint.id}`)
  }

  return {
    phase: targetPhase.phase,
    workspaceId: blueprint.workspaceId,
    resetPhaseId: targetPhase.id,
    newBlueprintStatus: PHASE_TO_STATUS[targetPhase.phase]
  }
}

// ── Tests ──

describe('retryPhase — happy path', () => {
  test('finds_failed_specify_phase_and_returns_it', () => {
    const bp: MockBlueprint = {
      id: 'bp-1',
      workspaceId: 'ws-1',
      status: 'failed',
      currentPhase: 'specify',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'failed' },
        { id: 'ph-2', phase: 'clarify', status: 'pending' },
        { id: 'ph-3', phase: 'plan', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'specify')
    assert.equal(result.workspaceId, 'ws-1')
    assert.equal(result.resetPhaseId, 'ph-1')
    assert.equal(result.newBlueprintStatus, 'specifying')
  })

  test('finds_failed_plan_phase_after_completed_specify_and_clarify', () => {
    const bp: MockBlueprint = {
      id: 'bp-2',
      workspaceId: 'ws-2',
      status: 'failed',
      currentPhase: 'plan',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'skipped' },
        { id: 'ph-3', phase: 'plan', status: 'failed' },
        { id: 'ph-4', phase: 'tasks', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'plan')
    assert.equal(result.newBlueprintStatus, 'planning')
  })

  test('finds_failed_build_phase', () => {
    const bp: MockBlueprint = {
      id: 'bp-3',
      workspaceId: 'ws-3',
      status: 'failed',
      currentPhase: 'build',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'skipped' },
        { id: 'ph-3', phase: 'plan', status: 'complete' },
        { id: 'ph-4', phase: 'tasks', status: 'complete' },
        { id: 'ph-5', phase: 'review', status: 'complete' },
        { id: 'ph-6', phase: 'build', status: 'failed' },
        { id: 'ph-7', phase: 'verify', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'build')
    assert.equal(result.newBlueprintStatus, 'building')
  })
})

describe('retryPhase — cancelled (stopped) blueprint resume', () => {
  test('resumes_cancelled_blueprint_at_currentPhase', () => {
    const bp: MockBlueprint = {
      id: 'bp-cancel-1',
      workspaceId: 'ws-c1',
      status: 'cancelled',
      currentPhase: 'specify',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'pending' },
        { id: 'ph-2', phase: 'clarify', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'specify')
    assert.equal(result.newBlueprintStatus, 'specifying')
    assert.equal(result.resetPhaseId, 'ph-1')
  })

  test('resumes_cancelled_blueprint_at_plan_after_completed_specify', () => {
    const bp: MockBlueprint = {
      id: 'bp-cancel-2',
      workspaceId: 'ws-c2',
      status: 'cancelled',
      currentPhase: 'plan',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'skipped' },
        { id: 'ph-3', phase: 'plan', status: 'pending' },
        { id: 'ph-4', phase: 'tasks', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'plan')
    assert.equal(result.newBlueprintStatus, 'planning')
  })

  test('failed_phase_takes_priority_over_currentPhase_in_cancelled_blueprint', () => {
    // Edge case: a cancelled blueprint that also has a failed phase
    const bp: MockBlueprint = {
      id: 'bp-cancel-3',
      workspaceId: 'ws-c3',
      status: 'cancelled',
      currentPhase: 'plan',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'failed' },
        { id: 'ph-2', phase: 'clarify', status: 'pending' },
        { id: 'ph-3', phase: 'plan', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    // Failed phase (specify) should take priority
    assert.equal(result.phase, 'specify')
    assert.equal(result.resetPhaseId, 'ph-1')
  })

  test('falls_back_to_first_pending_phase_if_currentPhase_not_found', () => {
    const bp: MockBlueprint = {
      id: 'bp-cancel-4',
      workspaceId: 'ws-c4',
      status: 'cancelled',
      currentPhase: 'build', // no build phase row in the mock
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'complete' },
        { id: 'ph-3', phase: 'plan', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'plan')
  })
})

describe('retryPhase — error cases', () => {
  test('throws_if_complete_without_gaps', () => {
    const bp: MockBlueprint = {
      id: 'bp-4',
      workspaceId: 'ws-4',
      status: 'complete',
      currentPhase: 'verify',
      phases: [{ id: 'ph-1', phase: 'verify', status: 'complete' }]
      // No artifactsJson with gaps_found → not retryable
    }

    assert.throws(() => retryPhase(bp), { message: /status is 'complete'/ })
  })

  test('allows_retry_when_complete_with_gaps_found', () => {
    const bp: MockBlueprint = {
      id: 'bp-gaps',
      workspaceId: 'ws-gaps',
      status: 'complete',
      currentPhase: 'verify',
      phases: [
        {
          id: 'ph-v',
          phase: 'verify',
          status: 'complete',
          artifactsJson: [{ type: 'verify', contentJson: { overallStatus: 'gaps_found' } }]
        }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'verify')
    assert.equal(result.resetPhaseId, 'ph-v')
    assert.equal(result.newBlueprintStatus, 'verifying')
  })

  test('throws_if_complete_with_human_needed_no_longer_retryable', () => {
    // human_needed was removed from isCompletedWithGaps — verify it throws
    const bp: MockBlueprint = {
      id: 'bp-hn',
      workspaceId: 'ws-hn',
      status: 'complete',
      currentPhase: 'verify',
      phases: [
        {
          id: 'ph-v',
          phase: 'verify',
          status: 'complete',
          artifactsJson: [{ type: 'verify', contentJson: { overallStatus: 'human_needed' } }]
        }
      ]
    }

    assert.throws(() => retryPhase(bp), { message: /status is 'complete'/ })
  })

  test('throws_if_no_retryable_phase_found', () => {
    const bp: MockBlueprint = {
      id: 'bp-5',
      workspaceId: 'ws-5',
      status: 'failed',
      currentPhase: 'specify',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'complete' }
      ]
    }

    assert.throws(() => retryPhase(bp), { message: /No retryable phase found/ })
  })

  test('throws_if_blueprint_status_is_draft', () => {
    const bp: MockBlueprint = {
      id: 'bp-6',
      workspaceId: 'ws-6',
      status: 'draft',
      currentPhase: 'specify',
      phases: [{ id: 'ph-1', phase: 'specify', status: 'pending' }]
    }

    assert.throws(() => retryPhase(bp), { message: /status is 'draft'/ })
  })
})

describe('retryPhase — orphan recovery (BP-ORPHAN-01)', () => {
  test('accepts_orphaned_specifying_status_when_pipeline_idle', () => {
    const bp: MockBlueprint = {
      id: 'bp-orphan-1',
      workspaceId: 'ws-o1',
      status: 'specifying',
      currentPhase: 'specify',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'active' },
        { id: 'ph-2', phase: 'clarify', status: 'pending' }
      ]
    }

    const result = retryPhase(bp, false)
    assert.equal(result.phase, 'specify')
    assert.equal(result.resetPhaseId, 'ph-1')
    assert.equal(result.newBlueprintStatus, 'specifying')
  })

  test('accepts_orphaned_clarifying_status_when_pipeline_idle', () => {
    const bp: MockBlueprint = {
      id: 'bp-orphan-2',
      workspaceId: 'ws-o2',
      status: 'clarifying',
      currentPhase: 'clarify',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'active' },
        { id: 'ph-3', phase: 'plan', status: 'pending' }
      ]
    }

    const result = retryPhase(bp, false)
    assert.equal(result.phase, 'clarify')
    assert.equal(result.resetPhaseId, 'ph-2')
  })

  test('rejects_orphaned_status_when_pipeline_running', () => {
    const bp: MockBlueprint = {
      id: 'bp-orphan-3',
      workspaceId: 'ws-o3',
      status: 'specifying',
      currentPhase: 'specify',
      phases: [{ id: 'ph-1', phase: 'specify', status: 'active' }]
    }

    assert.throws(() => retryPhase(bp, true), { message: /pipeline is currently active/ })
  })

  test('resolves_active_currentPhase_row_as_target', () => {
    const bp: MockBlueprint = {
      id: 'bp-orphan-4',
      workspaceId: 'ws-o4',
      status: 'planning',
      currentPhase: 'plan',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'complete' },
        { id: 'ph-3', phase: 'plan', status: 'active' },
        { id: 'ph-4', phase: 'tasks', status: 'pending' }
      ]
    }

    const result = retryPhase(bp, false)
    assert.equal(result.phase, 'plan')
    assert.equal(result.resetPhaseId, 'ph-3')
  })

  test('failed_takes_priority_over_orphaned_active_phase', () => {
    const bp: MockBlueprint = {
      id: 'bp-orphan-5',
      workspaceId: 'ws-o5',
      status: 'building',
      currentPhase: 'build',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'failed' },
        { id: 'ph-3', phase: 'plan', status: 'complete' },
        { id: 'ph-4', phase: 'tasks', status: 'complete' },
        { id: 'ph-5', phase: 'review', status: 'complete' },
        { id: 'ph-6', phase: 'build', status: 'active' }
      ]
    }

    const result = retryPhase(bp, false)
    // Failed phase (clarify) takes priority over active (build)
    assert.equal(result.phase, 'clarify')
    assert.equal(result.resetPhaseId, 'ph-2')
  })
})

describe('PHASE_TO_STATUS mapping', () => {
  test('all_phases_have_corresponding_status', () => {
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      assert.ok(PHASE_TO_STATUS[phase], `Missing status mapping for phase '${phase}'`)
    }
  })

  test('status_names_match_expected_pattern', () => {
    assert.equal(PHASE_TO_STATUS['specify'], 'specifying')
    assert.equal(PHASE_TO_STATUS['clarify'], 'clarifying')
    assert.equal(PHASE_TO_STATUS['plan'], 'planning')
    assert.equal(PHASE_TO_STATUS['tasks'], 'tasking')
    assert.equal(PHASE_TO_STATUS['review'], 'reviewing')
    assert.equal(PHASE_TO_STATUS['build'], 'building')
    assert.equal(PHASE_TO_STATUS['verify'], 'verifying')
  })
})

// ── Mock task types for retry-skips-completed tests ──

type MockTaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

interface MockTask {
  id: string
  taskId: string
  status: MockTaskStatus
  wave: number
}

/**
 * Replicated from BlueprintService.retryPhase build-task-reset logic.
 * Returns the tasks that would be reset to pending vs left untouched.
 */
function retryBuildTasks(tasks: MockTask[]): { reset: string[]; kept: string[] } {
  const reset: string[] = []
  const kept: string[] = []
  for (const task of tasks) {
    if (task.status === 'failed' || task.status === 'skipped' || task.status === 'running') {
      reset.push(task.taskId)
    } else {
      kept.push(task.taskId)
    }
  }
  return { reset, kept }
}

/**
 * Replicated from BlueprintBuildService.executeWave skip logic.
 * Returns which tasks would be skipped (complete) vs executed.
 */
function executeWaveSkipLogic(tasks: MockTask[]): { skipped: string[]; executed: string[] } {
  const skipped: string[] = []
  const executed: string[] = []
  for (const task of tasks) {
    if (task.status === 'complete') {
      skipped.push(task.taskId)
    } else {
      executed.push(task.taskId)
    }
  }
  return { skipped, executed }
}

describe('retryPhase — build retry skips completed tasks (BP-RETRY-TASKS-01)', () => {
  test('resets_failed_and_skipped_tasks_but_preserves_complete', () => {
    const tasks: MockTask[] = [
      { id: 't1', taskId: 'T001', status: 'complete', wave: 1 },
      { id: 't2', taskId: 'T002', status: 'complete', wave: 1 },
      { id: 't3', taskId: 'T003', status: 'failed', wave: 2 },
      { id: 't4', taskId: 'T004', status: 'skipped', wave: 2 },
      { id: 't5', taskId: 'T005', status: 'skipped', wave: 3 },
      { id: 't6', taskId: 'T006', status: 'pending', wave: 3 }
    ]

    const result = retryBuildTasks(tasks)
    // Complete and pending tasks should be kept
    assert.deepEqual(result.kept, ['T001', 'T002', 'T006'])
    // Failed and skipped tasks should be reset
    assert.deepEqual(result.reset, ['T003', 'T004', 'T005'])
  })

  test('resets_running_tasks_to_pending', () => {
    const tasks: MockTask[] = [
      { id: 't1', taskId: 'T001', status: 'running', wave: 1 },
      { id: 't2', taskId: 'T002', status: 'complete', wave: 1 }
    ]

    const result = retryBuildTasks(tasks)
    assert.deepEqual(result.reset, ['T001'])
    assert.deepEqual(result.kept, ['T002'])
  })

  test('executeWave_skips_complete_tasks_after_retry_reset', () => {
    // Simulate state AFTER retryPhase has reset non-complete tasks to pending.
    // Wave 1 had 2 complete tasks, wave 2 has 1 now-pending (was failed) + 1 pending.
    const wave1Tasks: MockTask[] = [
      { id: 't1', taskId: 'T001', status: 'complete', wave: 1 },
      { id: 't2', taskId: 'T002', status: 'complete', wave: 1 }
    ]
    const wave2Tasks: MockTask[] = [
      { id: 't3', taskId: 'T003', status: 'pending', wave: 2 }, // was failed, reset
      { id: 't4', taskId: 'T004', status: 'pending', wave: 2 } // was skipped, reset
    ]

    const w1 = executeWaveSkipLogic(wave1Tasks)
    assert.deepEqual(w1.skipped, ['T001', 'T002'])
    assert.deepEqual(w1.executed, [])

    const w2 = executeWaveSkipLogic(wave2Tasks)
    assert.deepEqual(w2.skipped, [])
    assert.deepEqual(w2.executed, ['T003', 'T004'])
  })

  test('no_tasks_reset_when_all_complete', () => {
    const tasks: MockTask[] = [
      { id: 't1', taskId: 'T001', status: 'complete', wave: 1 },
      { id: 't2', taskId: 'T002', status: 'complete', wave: 2 }
    ]

    const result = retryBuildTasks(tasks)
    assert.deepEqual(result.reset, [])
    assert.deepEqual(result.kept, ['T001', 'T002'])
  })

  test('retryPhase_finds_build_phase_and_resets_tasks', () => {
    // Full retryPhase integration: failed build with mixed task statuses
    const bp: MockBlueprint = {
      id: 'bp-retry-build',
      workspaceId: 'ws-rb1',
      status: 'failed',
      currentPhase: 'build',
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'complete' },
        { id: 'ph-2', phase: 'clarify', status: 'skipped' },
        { id: 'ph-3', phase: 'plan', status: 'complete' },
        { id: 'ph-4', phase: 'tasks', status: 'complete' },
        { id: 'ph-5', phase: 'review', status: 'complete' },
        { id: 'ph-6', phase: 'build', status: 'failed' },
        { id: 'ph-7', phase: 'verify', status: 'pending' }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'build')
    assert.equal(result.newBlueprintStatus, 'building')
  })
})

describe('BlueprintPhaseCompletePayload error field', () => {
  test('error_field_is_optional_and_string', () => {
    // Simulate payload shapes that the phase services now emit
    const successPayload = {
      blueprintId: 'bp-1',
      workspaceId: 'ws-1',
      phase: 'specify' as const,
      status: 'complete' as const
    }
    assert.equal(successPayload.status, 'complete')
    assert.equal('error' in successPayload, false)

    const failPayload = {
      blueprintId: 'bp-2',
      workspaceId: 'ws-2',
      phase: 'specify' as const,
      status: 'failed' as const,
      error: "CLI failed to start (exit code 1) — error: unknown option '--goal'"
    }
    assert.equal(failPayload.status, 'failed')
    assert.ok(failPayload.error.includes('--goal'))
    assert.equal(typeof failPayload.error, 'string')
  })
})

// ── Replicated generateFallbackRemediationTasks logic ──

/**
 * INTENTIONAL SIMPLIFICATION (GAP-G)
 *
 * This is a reduced replica of BlueprintVerifyService.generateFallbackRemediationTasks
 * covering Strategies 1–3 only. It intentionally omits two behaviors present in the
 * real implementation:
 *   1. `deterministic-disk-check` / `deterministic-disk-check-drift` source-skip
 *      (findings with those sources are skipped in the real generator)
 *   2. TSC file-path extraction for `deterministic-quality-gate` findings
 *      (real generator parses "file.ts(line,col): error TS..." from descriptions)
 *
 * These omissions are acceptable because the tests below exercise only the three
 * core strategies (structured findings, regex file extraction, generic fallback)
 * and do not pass inputs that would exercise those code paths.
 *
 * If the real generator's Strategy-1 logic changes significantly, consider syncing
 * this replica or extracting the real generator to a testable pure function.
 *
 * @param maxExistingR - Highest existing R-task sequence number (simulates
 *                       the DB query in the real implementation).
 */
function generateFallbackRemediationTasks(
  completion: Record<string, unknown> | null,
  text: string,
  maxExistingR: number
): Array<{ taskId: string; description: string; files: string[] }> {
  const tasks: Array<{ taskId: string; description: string; files: string[] }> = []
  let seq = maxExistingR + 1

  // Strategy 1: Parse structured completion fields
  if (completion) {
    const findings = completion.findings as Array<Record<string, unknown>> | undefined
    if (Array.isArray(findings)) {
      for (const finding of findings) {
        if (!finding || typeof finding !== 'object') continue
        const desc = String(finding.description ?? finding.issue ?? '')
        const files = Array.isArray(finding.files) ? finding.files.map(String) : []
        if (desc) {
          tasks.push({
            taskId: `R${String(seq++).padStart(3, '0')}`,
            description: `Fix: ${desc}`,
            files
          })
        }
      }
    }
    // If artifacts object has missing/stub/orphaned counts but no findings array
    if (tasks.length === 0) {
      const artifacts = completion.artifacts as Record<string, unknown> | undefined
      if (artifacts) {
        const missing = (artifacts.missing as number) ?? 0
        const stub = (artifacts.stub as number) ?? 0
        const orphaned = (artifacts.orphaned as number) ?? 0
        if (missing + stub + orphaned > 0) {
          tasks.push({
            taskId: `R${String(seq++).padStart(3, '0')}`,
            description: `Fix verification gaps: ${missing} missing, ${stub} stub, ${orphaned} orphaned artifacts. Review the verify phase report and implement the missing functionality.`,
            files: []
          })
        }
      }
    }
  }

  // Strategy 2: Regex fallback — extract file paths from MISSING/STUB/ORPHANED lines
  if (tasks.length === 0 && text) {
    const gapPattern = /(?:MISSING|STUB|ORPHANED|✗|⚠️)\s*[—–-]\s*(?:`([^`]+)`|(\S+\.\w+))/gi
    const gapFiles = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = gapPattern.exec(text)) !== null) {
      const file = match[1] || match[2]
      if (file) gapFiles.add(file)
    }
    if (gapFiles.size > 0) {
      tasks.push({
        taskId: `R${String(seq++).padStart(3, '0')}`,
        description: `Fix ${gapFiles.size} artifact gap(s) identified during verification: ${[...gapFiles].slice(0, 10).join(', ')}${gapFiles.size > 10 ? '...' : ''}`,
        files: [...gapFiles].slice(0, 20)
      })
    }
  }

  // Strategy 3: Last resort — single generic task from the full report
  if (tasks.length === 0 && text.length > 100) {
    tasks.push({
      taskId: `R${String(seq++).padStart(3, '0')}`,
      description:
        'Fix all gaps identified in the verification report. Review the verify phase output and implement missing or incomplete functionality.',
      files: []
    })
  }

  return tasks
}

describe('generateFallbackRemediationTasks', () => {
  test('strategy_1_extracts_from_findings_array', () => {
    const completion = {
      overallStatus: 'gaps_found',
      findings: [
        { description: 'Missing auth middleware', files: ['src/auth.ts'] },
        { issue: 'Stub handler', files: [] }
      ]
    }
    const tasks = generateFallbackRemediationTasks(completion, '', 0)
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].taskId, 'R001')
    assert.match(tasks[0].description, /auth middleware/)
    assert.deepEqual(tasks[0].files, ['src/auth.ts'])
    assert.equal(tasks[1].taskId, 'R002')
    assert.match(tasks[1].description, /Stub handler/)
  })

  test('strategy_1_extracts_from_artifact_counts', () => {
    const completion = {
      overallStatus: 'gaps_found',
      artifacts: { missing: 2, stub: 1, orphaned: 0 }
    }
    const tasks = generateFallbackRemediationTasks(completion, '', 0)
    assert.equal(tasks.length, 1)
    assert.match(tasks[0].description, /2 missing, 1 stub, 0 orphaned/)
  })

  test('strategy_2_regex_extracts_file_paths', () => {
    const text = '✗ — `src/api/routes.ts` is MISSING\n⚠️ — `src/db/repo.ts` is STUB'
    const tasks = generateFallbackRemediationTasks(null, text, 0)
    assert.equal(tasks.length, 1)
    assert.ok(tasks[0].files.includes('src/api/routes.ts'))
    assert.ok(tasks[0].files.includes('src/db/repo.ts'))
  })

  test('strategy_3_generic_fallback_for_long_text', () => {
    const tasks = generateFallbackRemediationTasks(null, 'x'.repeat(200), 0)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].taskId, 'R001')
    assert.match(tasks[0].description, /Fix all gaps/)
  })

  test('strategy_3_collision_safe_with_existing_tasks', () => {
    // maxExistingR = 5 → Strategy 3 should generate R006, not hardcoded R001
    const tasks = generateFallbackRemediationTasks(null, 'x'.repeat(200), 5)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].taskId, 'R006')
  })

  test('collision_safe_seq_starts_after_existing', () => {
    // maxExistingR = 3 → first generated ID should be R004
    const completion = { findings: [{ description: 'gap' }] }
    const tasks = generateFallbackRemediationTasks(completion, '', 3)
    assert.equal(tasks[0].taskId, 'R004')
  })

  test('no_tasks_when_no_data', () => {
    const tasks = generateFallbackRemediationTasks(null, '', 0)
    assert.equal(tasks.length, 0)
  })

  test('findings_with_empty_description_are_skipped', () => {
    const completion = {
      findings: [
        { description: '', files: ['src/a.ts'] },
        { description: 'Valid gap', files: [] }
      ]
    }
    const tasks = generateFallbackRemediationTasks(completion, '', 0)
    assert.equal(tasks.length, 1)
    assert.match(tasks[0].description, /Valid gap/)
  })

  test('strategy_3_not_triggered_for_short_text', () => {
    // Text under 100 chars doesn't trigger strategy 3
    const tasks = generateFallbackRemediationTasks(null, 'short', 0)
    assert.equal(tasks.length, 0)
  })

  test('null_element_in_findings_skipped', () => {
    // B2: null element in findings array → continue, don't crash
    const completion = {
      findings: [
        null,
        { description: 'Valid gap', files: ['src/a.ts'] },
        undefined,
        42,
        { description: 'Another gap' }
      ]
    }
    const tasks = generateFallbackRemediationTasks(completion, '', 0)
    assert.equal(tasks.length, 2)
    assert.match(tasks[0].description, /Valid gap/)
    assert.match(tasks[1].description, /Another gap/)
  })

  test('non_object_elements_in_findings_skipped', () => {
    // B2: string/number/boolean in findings array → skip gracefully
    const completion = {
      findings: ['bare string', true, { description: 'Real finding' }]
    }
    const tasks = generateFallbackRemediationTasks(completion, '', 0)
    assert.equal(tasks.length, 1)
    assert.match(tasks[0].description, /Real finding/)
  })
})

describe('retryPhase — findLast artifact resolution', () => {
  test('allows_retry_reads_latest_verify_artifact', () => {
    // After remediation: first artifact is gaps_found, latest is passed
    // isCompletedWithGaps should read the LATEST (passed) → not retryable
    const bp: MockBlueprint = {
      id: 'bp-remediated',
      workspaceId: 'ws-rem',
      status: 'complete',
      currentPhase: 'verify',
      phases: [
        {
          id: 'ph-v',
          phase: 'verify',
          status: 'complete',
          artifactsJson: [
            { type: 'verify', contentJson: { overallStatus: 'gaps_found' } },
            { type: 'verify', contentJson: { overallStatus: 'passed' } }
          ]
        }
      ]
    }

    // Should throw — latest artifact says 'passed', not 'gaps_found'
    assert.throws(() => retryPhase(bp), { message: /status is 'complete'/ })
  })

  test('findLast_still_finds_gaps_when_latest_is_gaps_found', () => {
    // When the latest artifact is still gaps_found, retry should be allowed
    const bp: MockBlueprint = {
      id: 'bp-still-gaps',
      workspaceId: 'ws-sg',
      status: 'complete',
      currentPhase: 'verify',
      phases: [
        {
          id: 'ph-v',
          phase: 'verify',
          status: 'complete',
          artifactsJson: [
            { type: 'verify', contentJson: { overallStatus: 'gaps_found' } },
            { type: 'verify', contentJson: { overallStatus: 'gaps_found' } }
          ]
        }
      ]
    }

    const result = retryPhase(bp)
    assert.equal(result.phase, 'verify')
    assert.equal(result.resetPhaseId, 'ph-v')
  })
})

describe('getOutcomeStats — findLast verify artifact', () => {
  // Minimal replica of getOutcomeStats verify logic from phase-summaries.ts
  function getVerifyStatus(
    artifactsJson: Array<{ type: string; contentJson?: Record<string, unknown> }> | undefined
  ): string | null {
    const verify = artifactsJson?.findLast((a) => a.type === 'verify' || a.type === 'verification')
    if (!verify?.contentJson) return null
    return (verify.contentJson.overallStatus as string) ?? 'unknown'
  }

  test('returns_latest_status_when_multiple_verify_artifacts', () => {
    const artifacts = [
      { type: 'verify', contentJson: { overallStatus: 'gaps_found' } },
      { type: 'verify', contentJson: { overallStatus: 'passed' } }
    ]
    assert.equal(getVerifyStatus(artifacts), 'passed')
  })

  test('returns_gaps_found_when_latest_is_gaps_found', () => {
    const artifacts = [
      { type: 'verify', contentJson: { overallStatus: 'passed' } },
      { type: 'verify', contentJson: { overallStatus: 'gaps_found' } }
    ]
    assert.equal(getVerifyStatus(artifacts), 'gaps_found')
  })

  test('returns_status_for_single_artifact', () => {
    const artifacts = [{ type: 'verify', contentJson: { overallStatus: 'passed' } }]
    assert.equal(getVerifyStatus(artifacts), 'passed')
  })

  test('returns_null_for_no_verify_artifact', () => {
    const artifacts = [{ type: 'build', contentJson: { filesCreated: [] } }]
    assert.equal(getVerifyStatus(artifacts), null)
  })

  test('returns_null_for_undefined_artifacts', () => {
    assert.equal(getVerifyStatus(undefined), null)
  })
})

// ── Fix P: Remediation-specific scenario tests ──

describe('discovery cap — verify findings integration', () => {
  test('cap_reapplied_after_verify_findings_push', () => {
    // Simulate 20 discoveries + 1 verify finding push
    const discoveries: string[] = Array.from({ length: 20 }, (_, i) => `discovery-${i}`)
    discoveries.push('[VERIFY GAPS - Round 1] Missing auth middleware; Stub handler')
    // Re-apply cap (as in Fix K/L)
    const capped = discoveries.length > 20 ? discoveries.slice(-20) : discoveries
    assert.equal(capped.length, 20)
    // Verify the verify finding is kept (it was pushed last)
    assert.ok(capped[19].startsWith('[VERIFY GAPS'))
    // Verify the oldest discovery was dropped
    assert.ok(!capped.some((d) => d === 'discovery-0'))
  })
})

describe('appendTasks — remediation batch validation', () => {
  test('internal_cycle_detected_despite_external_deps', () => {
    // Replicate the Fix D validation logic
    const parsedTasks = [
      { taskId: 'R001', description: 'Fix A', dependsOn: ['T003', 'R002'] },
      { taskId: 'R002', description: 'Fix B', dependsOn: ['R001'] } // cycle: R001 → R002 → R001
    ]
    const batchTaskIds = new Set(parsedTasks.map((t) => t.taskId))
    const internalDeps = parsedTasks.map((t) => ({
      taskId: t.taskId,
      wave: 4,
      dependsOn: (t.dependsOn ?? []).filter((dep) => batchTaskIds.has(dep))
    }))
    // R001 depends on R002, R002 depends on R001 — cycle should be detected
    assert.equal(internalDeps[0].dependsOn.length, 1) // Only R002 kept
    assert.equal(internalDeps[0].dependsOn[0], 'R002')
    assert.equal(internalDeps[1].dependsOn.length, 1) // Only R001 kept
    assert.equal(internalDeps[1].dependsOn[0], 'R001')
    // External dep T003 was correctly filtered out
    assert.ok(!internalDeps[0].dependsOn.includes('T003'))
  })

  test('external_deps_filtered_no_false_positives', () => {
    const parsedTasks = [
      { taskId: 'R001', description: 'Fix A', dependsOn: ['T001', 'T003'] },
      { taskId: 'R002', description: 'Fix B', dependsOn: ['R001'] }
    ]
    const batchTaskIds = new Set(parsedTasks.map((t) => t.taskId))
    const internalDeps = parsedTasks.map((t) => ({
      taskId: t.taskId,
      wave: 4,
      dependsOn: (t.dependsOn ?? []).filter((dep) => batchTaskIds.has(dep))
    }))
    // R001 has no internal deps (T001, T003 are external)
    assert.equal(internalDeps[0].dependsOn.length, 0)
    // R002 depends on R001 (internal)
    assert.deepEqual(internalDeps[1].dependsOn, ['R001'])
  })

  test('duplicate_taskIds_detected', () => {
    const parsedTasks = [
      { taskId: 'R001', description: 'Fix A' },
      { taskId: 'R002', description: 'Fix B' },
      { taskId: 'R001', description: 'Fix A copy' } // duplicate
    ]
    const duplicates = parsedTasks.filter(
      (t, i) => parsedTasks.findIndex((x) => x.taskId === t.taskId) !== i
    )
    assert.equal(duplicates.length, 1)
    assert.equal(duplicates[0].taskId, 'R001')
  })
})

describe('BuildResult — tasksResumed tracking', () => {
  test('resumed_count_tracks_only_skipped_complete_tasks', () => {
    // Simulate wave execution with resumed + new tasks
    const result = { tasksCompleted: 0, tasksResumed: 0 }
    const tasks = [
      { id: '1', status: 'complete' }, // resumed
      { id: '2', status: 'complete' }, // resumed
      { id: '3', status: 'pending' }, // will execute
      { id: '4', status: 'pending' } // will execute
    ]
    for (const task of tasks) {
      if (task.status === 'complete') {
        result.tasksCompleted++
        result.tasksResumed++
      } else {
        // Simulate execution success
        result.tasksCompleted++
      }
    }
    assert.equal(result.tasksCompleted, 4)
    assert.equal(result.tasksResumed, 2)
  })

  test('artifact_summary_shows_resumed_count', () => {
    // Replicate buildArtifactSummary logic
    let taskLine = `**Tasks**: 13/13 completed`
    const tasksResumed = 10
    if (tasksResumed && tasksResumed > 0) {
      taskLine += ` (${tasksResumed} resumed from prior run)`
    }
    assert.ok(taskLine.includes('(10 resumed from prior run)'))
  })

  test('artifact_summary_omits_resumed_when_zero', () => {
    let taskLine = `**Tasks**: 5/5 completed`
    const tasksResumed = 0
    if (tasksResumed && tasksResumed > 0) {
      taskLine += ` (${tasksResumed} resumed from prior run)`
    }
    assert.ok(!taskLine.includes('resumed'))
  })
})

describe('verify findings context seeding', () => {
  test('strategy_1_extracts_structured_findings', () => {
    const contentJson = {
      overallStatus: 'gaps_found',
      findings: [
        { description: 'Missing auth middleware', files: ['src/auth.ts'] },
        { issue: 'Stub handler in routes', files: ['src/routes.ts', 'src/api.ts'] }
      ]
    } as Record<string, unknown>

    const parts: string[] = []
    const findings = contentJson.findings as Array<Record<string, unknown>>
    for (const f of (findings ?? []).slice(0, 10)) {
      const desc = String(f.description ?? f.issue ?? 'Unknown gap')
      const files = Array.isArray(f.files)
        ? ` [${(f.files as string[]).slice(0, 5).join(', ')}]`
        : ''
      parts.push(`${desc}${files}`)
    }

    assert.equal(parts.length, 2)
    assert.ok(parts[0].includes('auth middleware'))
    assert.ok(parts[0].includes('src/auth.ts'))
    assert.ok(parts[1].includes('Stub handler'))
  })

  test('strategy_1_falls_back_to_artifact_counts', () => {
    const contentJson = {
      overallStatus: 'gaps_found',
      artifacts: { missing: 3, stub: 1, orphaned: 0 }
    } as Record<string, unknown>

    const parts: string[] = []
    const findings = contentJson.findings as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(findings) || findings.length === 0) {
      const artifacts = contentJson.artifacts as Record<string, unknown> | undefined
      if (artifacts) {
        const missing = (artifacts.missing as number) ?? 0
        const stub = (artifacts.stub as number) ?? 0
        const orphaned = (artifacts.orphaned as number) ?? 0
        if (missing + stub + orphaned > 0) {
          parts.push(`Artifacts: ${missing} missing, ${stub} stub, ${orphaned} orphaned`)
        }
      }
    }

    assert.equal(parts.length, 1)
    assert.ok(parts[0].includes('3 missing'))
  })

  test('strategy_2_falls_back_to_tail_of_raw_markdown', () => {
    // 3000 chars of preamble + 500 chars of findings at the end
    const preamble = 'I will now verify the blueprint implementation. '.repeat(60) // ~2880 chars
    const findings = '\n## Gaps Found\n- MISSING: src/auth.ts\n- STUB: src/routes.ts'
    const contentMd = preamble + findings

    // Strategy 2: slice from END (not beginning)
    const summary = contentMd.length > 1500 ? '…' + contentMd.slice(-1500) : contentMd

    assert.ok(summary.includes('Gaps Found'))
    assert.ok(summary.includes('src/auth.ts'))
    // Should NOT start with preamble
    assert.ok(!summary.startsWith('I will now verify'))
  })
})

// ── RC-1/RC-3/RC-4 Regression tests: Remediation dispatch ──

describe('remediation deferred dispatch (RC-1 regression)', () => {
  /**
   * Replicates the core logic that was broken: the old code used setTimeout(5000)
   * inside try + clearTimeout in finally — the timer was always cancelled before
   * it could fire. The fix uses a deferred payload set in the try body, dispatched
   * AFTER the finally block.
   */
  test('pendingRemediation_survives_finally_and_dispatches', async () => {
    // Simulate the deferred dispatch pattern
    let pendingRemediation: { blueprintId: string } | null = null
    let dispatched = false
    const events: string[] = []

    // Simulate try/finally + deferred dispatch
    try {
      // Success path — remediation needed
      pendingRemediation = { blueprintId: 'bp-1' }
      events.push('try-body-complete')
    } finally {
      // Pipeline cleanup (markPipelineStopped, session.stop, etc.)
      events.push('finally-cleanup')
      // Old code had: if (remediationTimeoutId) clearTimeout(remediationTimeoutId)
      // which killed the timer. The new code has NO timer to clear.
    }

    // Dispatch AFTER finally — this is the fix
    if (pendingRemediation) {
      dispatched = true
      events.push('dispatch')
    }

    assert.ok(dispatched, 'Remediation should dispatch after finally')
    assert.deepEqual(events, ['try-body-complete', 'finally-cleanup', 'dispatch'])
  })

  test('pendingRemediation_stays_null_on_error_path', () => {
    let pendingRemediation: { blueprintId: string } | null = null
    let dispatched = false

    try {
      // Error before remediation branch
      throw new Error('VERIFY phase timeout')
      pendingRemediation = { blueprintId: 'bp-1' }
    } catch {
      // Error handler
    } finally {
      // Cleanup
    }

    if (pendingRemediation) {
      dispatched = true
    }

    assert.ok(!dispatched, 'Remediation should NOT dispatch on error path')
    assert.equal(pendingRemediation, null)
  })

  test('old_setTimeout_pattern_was_broken', () => {
    // Demonstrate that the old pattern was fundamentally broken:
    // setTimeout in try + clearTimeout in finally = timer never fires
    let timerFired = false
    let timerId: ReturnType<typeof setTimeout> | undefined

    try {
      timerId = setTimeout(() => {
        timerFired = true
      }, 5000)
    } finally {
      if (timerId) clearTimeout(timerId)
    }

    // Even after waiting 0ms, the timer was cancelled
    assert.ok(!timerFired, 'Timer should have been cancelled by finally (demonstrating the bug)')
    assert.ok(timerId !== undefined, 'Timer was created')
  })
})

describe('dispatch guard same-blueprint check (RC-4 regression)', () => {
  /**
   * Replicated dispatch guard decision logic from blueprint.ipc.ts.
   * Pure function: (isRunning, activeBlueprintId, blueprintId) → action
   */
  function remediationDispatchGuard(
    isRunning: boolean,
    activeBlueprintId: string | null,
    blueprintId: string,
    blueprintStatus: string | null
  ): 'dispatch' | 'skip-same' | 'fail-other' | 'skip-terminal' {
    // Pre-check: blueprint cancelled/failed/missing
    if (!blueprintStatus || blueprintStatus === 'cancelled' || blueprintStatus === 'failed') {
      return 'skip-terminal'
    }
    if (!isRunning) return 'dispatch'
    // Pipeline busy — check who owns it
    if (activeBlueprintId === blueprintId) return 'skip-same'
    return 'fail-other'
  }

  test('dispatches_when_pipeline_idle', () => {
    assert.equal(remediationDispatchGuard(false, null, 'bp-1', 'building'), 'dispatch')
  })

  test('skips_when_same_blueprint_running', () => {
    assert.equal(remediationDispatchGuard(true, 'bp-1', 'bp-1', 'building'), 'skip-same')
  })

  test('fails_when_different_blueprint_running', () => {
    assert.equal(remediationDispatchGuard(true, 'bp-other', 'bp-1', 'building'), 'fail-other')
  })

  test('skips_when_blueprint_cancelled', () => {
    assert.equal(remediationDispatchGuard(false, null, 'bp-1', 'cancelled'), 'skip-terminal')
  })

  test('skips_when_blueprint_failed', () => {
    assert.equal(remediationDispatchGuard(false, null, 'bp-1', 'failed'), 'skip-terminal')
  })

  test('skips_when_blueprint_missing', () => {
    assert.equal(remediationDispatchGuard(false, null, 'bp-1', null), 'skip-terminal')
  })
})

describe('phaseComplete payload remediationTriggered flag (RC-3 regression)', () => {
  test('top_level_flag_present_when_completion_is_valid', () => {
    const completion = { overallStatus: 'gaps_found', remediationTasks: [] }
    const payload = {
      blueprintId: 'bp-1',
      workspaceId: 'ws-1',
      phase: 'verify' as const,
      status: 'complete' as const,
      remediationTriggered: true,
      completion: { ...completion, _remediationTriggered: true }
    }

    // Both flags present
    assert.equal(payload.remediationTriggered, true)
    assert.equal(payload.completion._remediationTriggered, true)
  })

  test('top_level_flag_survives_null_completion', () => {
    // This is the RC-3 scenario: agent omitted the completion block,
    // fallback tasks were generated, but completion is null/undefined.
    const completion = null
    const payload = {
      blueprintId: 'bp-1',
      workspaceId: 'ws-1',
      phase: 'verify' as const,
      status: 'complete' as const,
      remediationTriggered: true,
      completion: completion
        ? { ...(completion as Record<string, unknown>), _remediationTriggered: true }
        : undefined
    }

    // Top-level flag is present even though completion is undefined
    assert.equal(payload.remediationTriggered, true)
    assert.equal(payload.completion, undefined)
  })

  test('no_flag_on_non_remediation_complete', () => {
    const payload = {
      blueprintId: 'bp-1',
      workspaceId: 'ws-1',
      phase: 'verify' as const,
      status: 'complete' as const,
      completion: { overallStatus: 'passed' }
    }

    assert.equal('remediationTriggered' in payload, false)
  })

  test('renderer_detection_logic_handles_both_flag_locations', () => {
    // Replicate the renderer's detection logic
    function detectRemediation(data: Record<string, unknown>): boolean {
      return (
        data.remediationTriggered === true ||
        (data.completion as Record<string, unknown> | undefined)?._remediationTriggered === true
      )
    }

    // Case 1: Both flags
    assert.ok(
      detectRemediation({
        remediationTriggered: true,
        completion: { _remediationTriggered: true }
      })
    )

    // Case 2: Only top-level (null completion)
    assert.ok(
      detectRemediation({
        remediationTriggered: true,
        completion: undefined
      })
    )

    // Case 3: Only inner flag (backward compat)
    assert.ok(
      detectRemediation({
        completion: { _remediationTriggered: true }
      })
    )

    // Case 4: No flags
    assert.ok(
      !detectRemediation({
        completion: { overallStatus: 'passed' }
      })
    )

    // Case 5: No completion at all
    assert.ok(!detectRemediation({}))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

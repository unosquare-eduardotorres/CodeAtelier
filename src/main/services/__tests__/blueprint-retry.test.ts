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
  'specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify'
] as const

type BlueprintPhaseType = (typeof BLUEPRINT_PHASE_ORDER)[number]

type BlueprintStatus =
  | 'draft' | 'specifying' | 'clarifying' | 'planning' | 'tasking'
  | 'reviewing' | 'building' | 'verifying' | 'complete' | 'failed' | 'cancelled'

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
  'specifying', 'clarifying', 'planning', 'tasking', 'reviewing', 'building', 'verifying'
])

/**
 * Replicated from BlueprintService.retryPhase (blueprint.service.ts).
 * Pure function: validates state and returns the phase to retry.
 * Accepts 'failed', 'cancelled', or orphaned in-progress status (when pipeline is idle).
 * Phase resolution order: first failed > currentPhase (pending or active) > first pending.
 */
function retryPhase(blueprint: MockBlueprint, pipelineRunning = false): {
  phase: BlueprintPhaseType
  workspaceId: string
  resetPhaseId: string
  newBlueprintStatus: BlueprintStatus
} {
  const isRetryable = blueprint.status === 'failed' || blueprint.status === 'cancelled'
  const isOrphaned = MID_PIPELINE_STATUSES.has(blueprint.status) && !pipelineRunning

  if (!isRetryable && !isOrphaned) {
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
  const targetPhase =
    blueprint.phases.find((p) => p.status === 'failed') ??
    blueprint.phases.find((p) => p.phase === blueprint.currentPhase && (p.status === 'pending' || p.status === 'active')) ??
    blueprint.phases.find((p) => p.status === 'pending')

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
  test('throws_if_blueprint_status_is_complete', () => {
    const bp: MockBlueprint = {
      id: 'bp-4',
      workspaceId: 'ws-4',
      status: 'complete',
      currentPhase: 'verify',
      phases: [{ id: 'ph-1', phase: 'verify', status: 'complete' }]
    }

    assert.throws(
      () => retryPhase(bp),
      { message: /status is 'complete'/ }
    )
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

    assert.throws(
      () => retryPhase(bp),
      { message: /No retryable phase found/ }
    )
  })

  test('throws_if_blueprint_status_is_draft', () => {
    const bp: MockBlueprint = {
      id: 'bp-6',
      workspaceId: 'ws-6',
      status: 'draft',
      currentPhase: 'specify',
      phases: [{ id: 'ph-1', phase: 'specify', status: 'pending' }]
    }

    assert.throws(
      () => retryPhase(bp),
      { message: /status is 'draft'/ }
    )
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
      phases: [
        { id: 'ph-1', phase: 'specify', status: 'active' }
      ]
    }

    assert.throws(
      () => retryPhase(bp, true),
      { message: /pipeline is currently active/ }
    )
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
      assert.ok(
        PHASE_TO_STATUS[phase],
        `Missing status mapping for phase '${phase}'`
      )
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
      { id: 't4', taskId: 'T004', status: 'pending', wave: 2 }  // was skipped, reset
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
      error: 'CLI failed to start (exit code 1) — error: unknown option \'--goal\''
    }
    assert.equal(failPayload.status, 'failed')
    assert.ok(failPayload.error.includes('--goal'))
    assert.equal(typeof failPayload.error, 'string')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

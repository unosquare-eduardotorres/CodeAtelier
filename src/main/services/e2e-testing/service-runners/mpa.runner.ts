/**
 * MPA Service Runner — preflight classification (deterministic), orchestration (LLM),
 * and campaign lifecycle testing.
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EMpaRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function textEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'text', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

// ── MPA Preflight (deterministic — no LLM) ──

export async function runMpaPreflight(_ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const result = classifyGoal('Add a dark mode toggle to the settings page with system preference detection')

    log.info(`[mpa-preflight] Result: goalType=${result.goalType}, phases=${result.phases.length}, isValid=${result.isValid}`)

    transcript.push(textEntry(JSON.stringify({
      goalType: result.goalType,
      phases: result.phases,
      isValid: result.isValid
    })))

    transcript.push(statusEntry('preflight_complete'))
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── MPA Goal Conditions (invalid goal — deterministic) ──

export async function runMpaGoalConditions(_ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { classifyGoal } = await import('../../mpa-preflight.service')
    // Intentionally vague/invalid goal
    const result = classifyGoal('fix stuff')

    log.info(`[mpa-goal-conditions] Result: isValid=${result.isValid}, rejectionReason=${result.rejectionReason}`)

    transcript.push(textEntry(JSON.stringify({
      isValid: result.isValid,
      rejectionReason: result.rejectionReason ?? 'Goal too vague'
    })))

    transcript.push(statusEntry('goal_conditions_checked'))
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── MPA Orchestration (heavy — LLM, gate auto-approver) ──

export async function runMpaOrchestration(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const { mpaOrchestrationService } = await import('../../mpa-orchestration.service')

    const classification = classifyGoal('Add input validation to the createTask function in src/tasks.ts')
    if (!classification.isValid) {
      transcript.push(statusEntry(`preflight_rejected: ${classification.rejectionReason}`))
      return transcript
    }

    transcript.push(statusEntry('orchestration_starting'))

    // Setup gate auto-approver
    const onApproval = (data: { runId?: string }) => {
      if (data.runId) {
        log.info(`[mpa-orchestration] Auto-approving gate for runId=${data.runId}`)
        setTimeout(() => mpaOrchestrationService.respondToGate(data.runId!, true), 500)
      }
    }
    mpaOrchestrationService.on('approvalNeeded', onApproval)

    // Capture phase events
    const onPhaseStart = (data: { phase?: string }) => {
      transcript.push(statusEntry(`phase_start: ${data.phase ?? 'unknown'}`))
    }
    const onComplete = () => {
      transcript.push(statusEntry('pipeline_complete'))
    }
    mpaOrchestrationService.on('phaseStart', onPhaseStart)
    mpaOrchestrationService.on('pipelineComplete', onComplete)

    try {
      await mpaOrchestrationService.orchestrate({
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        goal: 'Add input validation to the createTask function in src/tasks.ts',
        title: 'E2E MPA Test',
        goalType: classification.goalType,
        phases: classification.phases
      })
    } finally {
      mpaOrchestrationService.off('approvalNeeded', onApproval)
      mpaOrchestrationService.off('phaseStart', onPhaseStart)
      mpaOrchestrationService.off('pipelineComplete', onComplete)
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── MPA Cancellation ──

export async function runMpaCancellation(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const { mpaOrchestrationService } = await import('../../mpa-orchestration.service')

    const classification = classifyGoal('Refactor the hello module to use class-based pattern')
    if (!classification.isValid) {
      transcript.push(statusEntry(`preflight_rejected: ${classification.rejectionReason}`))
      return transcript
    }

    transcript.push(statusEntry('orchestration_starting_for_cancel'))

    // Wait for first phase start, then cancel
    const cancelPromise = new Promise<void>((resolve) => {
      const onPhaseStart = () => {
        log.info('[mpa-cancellation] First phase started — cancelling')
        transcript.push(statusEntry('first_phase_started'))
        mpaOrchestrationService.off('phaseStart', onPhaseStart)
        setTimeout(() => {
          mpaOrchestrationService.cancel(ctx.workspaceId)
          transcript.push(statusEntry('cancelled'))
          resolve()
        }, 1000)
      }
      mpaOrchestrationService.on('phaseStart', onPhaseStart)

      // Timeout fallback
      setTimeout(() => {
        mpaOrchestrationService.off('phaseStart', onPhaseStart)
        mpaOrchestrationService.cancel(ctx.workspaceId)
        transcript.push(statusEntry('cancelled'))
        resolve()
      }, 30_000)
    })

    // Start orchestration (don't await — we cancel mid-run)
    mpaOrchestrationService.orchestrate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      goal: 'Refactor the hello module to use class-based pattern',
      title: 'E2E MPA Cancel Test',
      goalType: classification.goalType,
      phases: classification.phases
    }).catch(() => {
      // Expected — orchestration interrupted by cancel
    })

    await cancelPromise
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Wave E: Campaign Runners ───────────────────────────────────────────────────

/**
 * Campaign sequential: 2 tiny goals → assert campaignGoalComplete ×2 + campaignComplete.
 * Heavy — requires LLM.
 */
export async function runMpaCampaignSequential(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { mpaCampaignService } = await import('../../mpa-campaign.service')
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const { v4: uuid } = await import('uuid')

    const goal1Class = classifyGoal('Add a greeting function to src/hello.ts')
    const goal2Class = classifyGoal('Add input validation to createTask in src/tasks.ts')

    const goals = [
      {
        id: uuid(),
        title: 'Add greeting',
        outcome: 'A new greeting function in hello.ts',
        successCriteria: ['Function exists in hello.ts'],
        goalType: goal1Class.goalType,
        phases: goal1Class.phases
      },
      {
        id: uuid(),
        title: 'Add validation',
        outcome: 'Input validation in createTask',
        successCriteria: ['Validation exists in tasks.ts'],
        goalType: goal2Class.goalType,
        phases: goal2Class.phases
      }
    ]

    let goalCompleteCount = 0
    let campaignDone = false

    const onGoalComplete = () => { goalCompleteCount++ }
    const onCampaignComplete = () => { campaignDone = true }
    mpaCampaignService.on('goalComplete', onGoalComplete)
    mpaCampaignService.on('campaignComplete', onCampaignComplete)

    // Setup gate auto-approver
    const { mpaOrchestrationService } = await import('../../mpa-orchestration.service')
    const onApproval = (data: { runId?: string }) => {
      if (data.runId) {
        setTimeout(() => mpaOrchestrationService.respondToGate(data.runId!, true), 500)
      }
    }
    mpaOrchestrationService.on('approvalNeeded', onApproval)

    try {
      transcript.push(statusEntry('campaign_starting'))
      const { campaignId } = mpaCampaignService.start({
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        title: 'E2E Sequential Campaign',
        originalPlanMd: '# E2E Campaign\n\nTwo tiny goals.',
        goals
      })
      transcript.push(statusEntry(`campaign_started: ${campaignId}`))

      // Wait for completion (max 20 min)
      const timeout = 20 * 60 * 1000
      const start = Date.now()
      while (!campaignDone && Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 5000))
      }

      transcript.push(statusEntry(`goal_complete_count: ${goalCompleteCount}`))
      transcript.push(statusEntry(campaignDone ? 'campaign_complete' : 'campaign_timeout'))
    } finally {
      mpaCampaignService.off('goalComplete', onGoalComplete)
      mpaCampaignService.off('campaignComplete', onCampaignComplete)
      mpaOrchestrationService.off('approvalNeeded', onApproval)
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Campaign pause & retry: goal with invalid workspace sub-path forces failure.
 * Heavy — requires LLM.
 */
export async function runMpaCampaignPauseRetry(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { mpaCampaignService } = await import('../../mpa-campaign.service')
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const { v4: uuid } = await import('uuid')

    const goalClass = classifyGoal('Refactor the nonexistent module src/does-not-exist.ts')

    const goals = [
      {
        id: uuid(),
        title: 'Refactor nonexistent',
        outcome: 'Refactored module',
        successCriteria: ['Module refactored'],
        goalType: goalClass.goalType,
        phases: goalClass.phases
      }
    ]

    let paused = false
    const onPause = () => {
      paused = true
      transcript.push(statusEntry('campaign_paused'))
      // Auto-resolve with skip after brief delay
      setTimeout(() => {
        mpaCampaignService.respond(ctx.workspaceId, 'skip')
        transcript.push(statusEntry('campaign_resumed'))
      }, 2000)
    }
    mpaCampaignService.on('campaignPaused', onPause)

    // Auto-approve gates
    const { mpaOrchestrationService } = await import('../../mpa-orchestration.service')
    const onApproval = (data: { runId?: string }) => {
      if (data.runId) {
        setTimeout(() => mpaOrchestrationService.respondToGate(data.runId!, true), 500)
      }
    }
    mpaOrchestrationService.on('approvalNeeded', onApproval)

    try {
      mpaCampaignService.start({
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        title: 'E2E Pause-Retry Campaign',
        originalPlanMd: '# Pause-Retry\n\nWill fail and pause.',
        goals
      })

      // Wait for campaign to complete or timeout
      const timeout = 10 * 60 * 1000
      const start = Date.now()
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 3000))
        if (!mpaCampaignService.isRunningForWorkspace(ctx.workspaceId)) break
      }

      transcript.push(statusEntry(paused ? 'pause_cycle_complete' : 'no_pause_detected'))
    } finally {
      mpaCampaignService.off('campaignPaused', onPause)
      mpaOrchestrationService.off('approvalNeeded', onApproval)
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Campaign skip & stop: pause → resolve stop → assert cancelled status.
 * Heavy — requires LLM.
 */
export async function runMpaCampaignSkip(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { mpaCampaignService } = await import('../../mpa-campaign.service')
    const { classifyGoal } = await import('../../mpa-preflight.service')
    const { v4: uuid } = await import('uuid')

    const goalClass = classifyGoal('Add dark mode toggle to settings page')

    const goals = [
      {
        id: uuid(),
        title: 'Add dark mode',
        outcome: 'Dark mode toggle in settings',
        successCriteria: ['Toggle exists'],
        goalType: goalClass.goalType,
        phases: goalClass.phases
      }
    ]

    const { mpaOrchestrationService } = await import('../../mpa-orchestration.service')
    const onApproval = (data: { runId?: string }) => {
      if (data.runId) {
        setTimeout(() => mpaOrchestrationService.respondToGate(data.runId!, true), 500)
      }
    }
    mpaOrchestrationService.on('approvalNeeded', onApproval)

    // Listen for first phase start, then cancel
    let cancelled = false
    const onPhaseStart = () => {
      mpaOrchestrationService.off('phaseStart', onPhaseStart)
      setTimeout(() => {
        mpaCampaignService.cancel(ctx.workspaceId)
        cancelled = true
        transcript.push(statusEntry('campaign_cancelled'))
      }, 1000)
    }
    mpaOrchestrationService.on('phaseStart', onPhaseStart)

    try {
      mpaCampaignService.start({
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        title: 'E2E Skip-Stop Campaign',
        originalPlanMd: '# Skip-Stop\n\nWill be cancelled.',
        goals
      })

      const timeout = 5 * 60 * 1000
      const start = Date.now()
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 2000))
        if (!mpaCampaignService.isRunningForWorkspace(ctx.workspaceId)) break
      }

      transcript.push(statusEntry(cancelled ? 'skip_stop_ok' : 'skip_stop_no_cancel'))
    } finally {
      mpaOrchestrationService.off('approvalNeeded', onApproval)
      mpaOrchestrationService.off('phaseStart', onPhaseStart)
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Campaign stale reconcile: insert running campaign row → reconcileStale() → assert marked failed.
 * Deterministic — no LLM needed.
 */
export async function runMpaCampaignReconcile(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { mpaCampaignRepository } = await import('../../../db/repositories/mpa-campaign.repository')
    const { mpaCampaignService } = await import('../../mpa-campaign.service')

    // Insert a fake "running" campaign
    const campaign = mpaCampaignRepository.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Stale Campaign (should be reconciled)',
      originalPlanMd: '# Stale\n\nThis simulates a leftover campaign from a crash.'
    })
    transcript.push(statusEntry(`stale_campaign_created: ${campaign.id}`))

    // Call reconcileStale — should mark it as failed
    const reconciled = mpaCampaignService.reconcileStale()
    log.info(`[mpa-campaign-reconcile] Reconciled ${reconciled} stale campaign(s)`)

    // Verify the campaign is now 'failed'
    const updated = mpaCampaignRepository.findById(campaign.id)
    if (updated && updated.status === 'failed') {
      transcript.push(statusEntry('reconcile_ok'))
    } else {
      transcript.push(statusEntry(`reconcile_unexpected: status=${updated?.status}`))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

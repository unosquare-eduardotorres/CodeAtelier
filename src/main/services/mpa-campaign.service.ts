/**
 * MpaCampaignService — in-memory supervisor that runs a set of measurable goals
 * as sequential MPA runs (a "campaign").
 *
 * Phase 2 scope: state is held in memory (no DB persistence — that lands in
 * Phase 3 with the v95 migration). Each goal is executed via the existing
 * MpaOrchestrationService, preserving its per-goal plan-approval gate. On
 * success the campaign auto-advances; on a goal run failure the campaign pauses
 * and waits for a Retry / Skip / Stop decision from the user.
 *
 * Emits: campaignStarted, campaignGoalStart, campaignGoalComplete,
 * campaignPaused, campaignComplete — forwarded to the renderer by the IPC layer.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import { mpaOrchestrationService } from './mpa-orchestration.service'
import { mpaCampaignRepository } from '../db/repositories/mpa-campaign.repository'
import { mpaRunRepository } from '../db/repositories/mpa-run.repository'
import type {
  MeasurableGoal,
  MpaCampaignGoalState,
  MpaCampaignPauseAction,
  MpaCampaignStartParams,
  MpaCampaignStatus,
  MpaOrchestrateParams,
  MpaPipelineCompletePayload
} from '../../shared/mpa-types'

const campaignLog = log.scope('mpa-campaign')

interface CampaignState {
  id: string
  workspaceId: string
  workspacePath: string
  title: string
  originalPlanMd: string
  goals: MpaCampaignGoalState[]
  status: MpaCampaignStatus
  currentIndex: number
  cancelled: boolean
  pendingPauseResolve: ((action: MpaCampaignPauseAction) => void) | null
}

export class MpaCampaignService extends EventEmitter {
  /** One active campaign per workspace. */
  private campaigns = new Map<string, CampaignState>()

  /** Is a campaign currently active for this workspace? */
  isRunningForWorkspace(workspaceId: string): boolean {
    const c = this.campaigns.get(workspaceId)
    return !!c && (c.status === 'running' || c.status === 'paused')
  }

  /**
   * Start a campaign (non-blocking). Returns the campaign id immediately; the
   * goal loop runs in the background and drives events.
   */
  start(params: MpaCampaignStartParams & { workspacePath: string }): { campaignId: string } {
    if (this.isRunningForWorkspace(params.workspaceId)) {
      throw new Error(`A campaign is already running for workspace ${params.workspaceId}`)
    }
    if (params.goals.length === 0) {
      throw new Error('Cannot start a campaign with no goals')
    }

    // Persist the campaign record up-front so it survives restarts and groups
    // its runs in history.
    const campaign = mpaCampaignRepository.create({
      workspaceId: params.workspaceId,
      title: params.title,
      originalPlanMd: params.originalPlanMd
    })

    const state: CampaignState = {
      id: campaign.id,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      title: params.title,
      originalPlanMd: params.originalPlanMd,
      goals: params.goals.map((goal, orderIndex) => ({
        goal,
        orderIndex,
        status: 'pending',
        runId: null
      })),
      status: 'running',
      currentIndex: 0,
      cancelled: false,
      pendingPauseResolve: null
    }
    this.campaigns.set(params.workspaceId, state)

    campaignLog.info(
      `[campaign] Starting campaign ${state.id} "${state.title}" with ${state.goals.length} goal(s)`
    )

    void this.runCampaign(state)

    return { campaignId: state.id }
  }

  /** Mark campaigns left 'running'/'paused' at last quit as failed (startup). */
  reconcileStale(): number {
    return mpaCampaignRepository.markStaleAsFailed()
  }

  /** Resolve a paused campaign with the user's decision. */
  respond(workspaceId: string, action: MpaCampaignPauseAction): void {
    const state = this.campaigns.get(workspaceId)
    if (state?.pendingPauseResolve) {
      const resolve = state.pendingPauseResolve
      state.pendingPauseResolve = null
      resolve(action)
    }
  }

  /** Cancel the active campaign for a workspace and the underlying run. */
  cancel(workspaceId: string): void {
    const state = this.campaigns.get(workspaceId)
    if (!state) return
    state.cancelled = true
    // Unblock a pending pause so the loop can finalize.
    if (state.pendingPauseResolve) {
      const resolve = state.pendingPauseResolve
      state.pendingPauseResolve = null
      resolve('stop')
    }
    mpaOrchestrationService.cancel(workspaceId)
  }

  // ── Internal loop ──

  private async runCampaign(state: CampaignState): Promise<void> {
    this.emit('campaignStarted', {
      campaignId: state.id,
      workspaceId: state.workspaceId,
      title: state.title,
      totalGoals: state.goals.length
    })

    let index = 0
    while (index < state.goals.length) {
      if (state.cancelled) break

      const entry = state.goals[index]
      entry.status = 'running'
      state.currentIndex = index

      this.emit('campaignGoalStart', {
        campaignId: state.id,
        orderIndex: index,
        goalId: entry.goal.id,
        title: entry.goal.title
      })

      const { runId, status } = await this.runGoal(state, entry.goal)
      entry.runId = runId

      if (state.cancelled || status === 'cancelled') {
        entry.status = 'skipped'
        break
      }

      if (status === 'completed') {
        entry.status = 'completed'
        this.emit('campaignGoalComplete', {
          campaignId: state.id,
          orderIndex: index,
          goalId: entry.goal.id,
          status: 'completed',
          runId
        })
        index++
        continue
      }

      // Goal run failed → pause and await user decision.
      entry.status = 'failed'
      this.emit('campaignGoalComplete', {
        campaignId: state.id,
        orderIndex: index,
        goalId: entry.goal.id,
        status: 'failed',
        runId
      })

      state.status = 'paused'
      mpaCampaignRepository.updateStatus(state.id, 'paused')
      this.emit('campaignPaused', {
        campaignId: state.id,
        orderIndex: index,
        goalId: entry.goal.id,
        runId,
        reason: `Goal "${entry.goal.title}" did not complete successfully.`
      })

      const action = await this.waitForPauseResolution(state)
      if (state.cancelled || action === 'stop') {
        state.status = 'cancelled'
        break
      }

      state.status = 'running'
      mpaCampaignRepository.updateStatus(state.id, 'running')
      if (action === 'skip') {
        entry.status = 'skipped'
        index++
        continue
      }
      // 'retry' — re-run the same goal. Supersede the prior failed run for this
      // order index first so campaign history shows one attempt per goal rather
      // than the failed run plus the retry (cascades to its phases/artifacts).
      mpaRunRepository.deleteByCampaignOrder(state.id, index)
      entry.status = 'pending'
      entry.runId = null
    }

    this.finalize(state)
  }

  /** Run a single goal via the orchestration service, resolving with its final status. */
  private runGoal(
    state: CampaignState,
    goal: MeasurableGoal
  ): Promise<{ runId: string | null; status: MpaPipelineCompletePayload['status'] }> {
    return new Promise((resolve) => {
      const onComplete = (payload: MpaPipelineCompletePayload): void => {
        mpaOrchestrationService.off('pipelineComplete', onComplete)
        resolve({ runId: payload.runId, status: payload.status })
      }
      mpaOrchestrationService.on('pipelineComplete', onComplete)

      const orderIndex = state.goals.findIndex((g) => g.goal.id === goal.id)
      const params: MpaOrchestrateParams = {
        workspaceId: state.workspaceId,
        workspacePath: state.workspacePath,
        goal: this.composeGoalText(goal),
        title: goal.title,
        goalType: goal.goalType,
        phases: goal.phases,
        campaignId: state.id,
        orderIndex: orderIndex >= 0 ? orderIndex : undefined,
        successCriteria: goal.successCriteria
      }

      // orchestrate() emits pipelineComplete itself (including on failure); guard
      // only the synchronous-throw path (e.g. a pipeline already running).
      mpaOrchestrationService.orchestrate(params).catch((err) => {
        campaignLog.error('[campaign] orchestrate threw:', err)
        mpaOrchestrationService.off('pipelineComplete', onComplete)
        resolve({ runId: null, status: 'failed' })
      })
    })
  }

  /** Compose the run goal text from the measurable goal + its success criteria. */
  private composeGoalText(goal: MeasurableGoal): string {
    const lines: string[] = [goal.title.trim(), '', goal.outcome.trim()]
    if (goal.successCriteria.length > 0) {
      lines.push('', 'Success criteria:')
      for (const c of goal.successCriteria) lines.push(`- ${c}`)
    }
    return lines.join('\n').trim()
  }

  private waitForPauseResolution(state: CampaignState): Promise<MpaCampaignPauseAction> {
    return new Promise((resolve) => {
      state.pendingPauseResolve = resolve
    })
  }

  private finalize(state: CampaignState): void {
    const completedGoals = state.goals.filter((g) => g.status === 'completed').length
    const finalStatus: MpaCampaignStatus = state.cancelled
      ? 'cancelled'
      : state.status === 'cancelled'
        ? 'cancelled'
        : state.goals.some((g) => g.status === 'failed')
          ? 'failed'
          : 'completed'

    state.status = finalStatus
    mpaCampaignRepository.updateStatus(state.id, finalStatus)
    campaignLog.info(
      `[campaign] Campaign ${state.id} finished: ${finalStatus} (${completedGoals}/${state.goals.length} completed)`
    )

    this.emit('campaignComplete', {
      campaignId: state.id,
      status: finalStatus,
      completedGoals,
      totalGoals: state.goals.length
    })

    this.campaigns.delete(state.workspaceId)
  }
}

export const mpaCampaignService = new MpaCampaignService()

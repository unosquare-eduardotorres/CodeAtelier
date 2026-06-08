/**
 * MPA (Multi-Phased Agent) IPC handlers.
 *
 * Follows the audit.ipc.ts pattern:
 * - ipcMain.handle for request/response (start, cancel, getStatus, getRun, getHistory)
 * - webContents.send for event forwarding (phaseStart, phaseProgress, phaseComplete, etc.)
 */

import { ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { createTimedCleanupMap } from './listener-cleanup'
import { mpaOrchestrationService } from '../services/mpa-orchestration.service'
import { mpaCampaignService } from '../services/mpa-campaign.service'
import { goalDecomposerService } from '../services/goal-decomposer.service'
import { mpaRunRepository } from '../db/repositories/mpa-run.repository'
import { mpaArtifactRepository } from '../db/repositories/mpa-artifact.repository'
import { mpaCampaignRepository } from '../db/repositories/mpa-campaign.repository'
import { workspaceRepository } from '../db/repositories'
import { getSessionEventRouter } from '../services/session-event-router'
import type {
  MpaPhaseType,
  MpaPhaseStartPayload,
  MpaPhaseProgressPayload,
  MpaPhaseCompletePayload,
  MpaFeedbackLoopPayload,
  MpaApprovalNeededPayload,
  MpaPipelineCompletePayload,
  MpaStatus,
  MeasurableGoal,
  MpaCampaignPauseAction,
  MpaCampaignStartedPayload,
  MpaCampaignGoalStartPayload,
  MpaCampaignGoalCompletePayload,
  MpaCampaignPausedPayload,
  MpaCampaignCompletePayload
} from '../../shared/mpa-types'
import type { AgentStatus } from '../../shared/types'

const mpaLog = log.scope('mpa-ipc')

export function registerMpaIpc(_mainWindow: BrowserWindow): void {
  // ── mpa:cancel — Cancel running pipeline ──

  ipcMain.handle(IPC_CHANNELS.MPA_CANCEL, (event, args?: { workspaceId?: string }) => {
    validateSender(event)
    mpaOrchestrationService.cancel(args?.workspaceId)
    return { cancelled: true }
  })

  // ── mpa:getStatus — Get current pipeline status ──

  ipcMain.handle(IPC_CHANNELS.MPA_GET_STATUS, (event, args: { workspaceId: string }) => {
    validateSender(event)

    const { running, runId } = mpaOrchestrationService.getStatus(args.workspaceId)
    if (!running || !runId) {
      return {
        status: 'idle',
        runId: null,
        currentPhase: null,
        phaseIndex: 0,
        totalPhases: 0,
        iteration: 0,
        awaitingApproval: false
      } satisfies MpaStatus
    }

    const run = mpaRunRepository.findById(runId)
    const phases = run ? mpaRunRepository.findPhasesByRun(runId) : []
    const currentPhaseIdx = phases.findIndex((p) => p.status === 'running')
    const currentPhase = phases[currentPhaseIdx]

    return {
      status: run?.status ?? 'running',
      runId,
      currentPhase: (currentPhase?.phaseType ?? run?.currentPhase ?? null) as MpaPhaseType | null,
      phaseIndex: currentPhaseIdx >= 0 ? currentPhaseIdx + 1 : phases.length,
      totalPhases: phases.length || 3,
      iteration: currentPhase?.iteration ?? 1,
      awaitingApproval: run?.status === 'paused'
    } satisfies MpaStatus
  })

  // ── mpa:getRun — Get a specific run with phases and artifacts ──

  ipcMain.handle(IPC_CHANNELS.MPA_GET_RUN, (event, args: { runId: string }) => {
    validateSender(event)

    const run = mpaRunRepository.findById(args.runId)
    if (!run) return null

    const phases = mpaRunRepository.findPhasesByRun(args.runId)
    const artifacts = mpaArtifactRepository.findByRun(args.runId)

    return { run, phases, artifacts }
  })

  // ── mpa:getHistory — Get recent runs for a workspace ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return mpaRunRepository.findByWorkspace(args.workspaceId, args.limit ?? 20)
    }
  )

  // ── mpa:approvalRespond — User gate response ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_APPROVAL_RESPOND,
    (event, args: { runId: string; approved: boolean; feedback?: string }) => {
      validateSender(event)
      mpaOrchestrationService.respondToGate(args.runId, args.approved, args.feedback)
      return { responded: true }
    }
  )

  // ── mpa:resume — Resume a failed/stale run ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_RESUME,
    async (event, args: { runId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireMpaEvents(args.workspaceId)

      // Resume orchestration (non-blocking)
      mpaOrchestrationService.resumeRun(args.runId).catch((err) => {
        mpaLog.error('[mpa:resume] Resume failed:', err)
      })

      return { resumed: true }
    }
  )

  // ── mpa:decomposeGoals — decompose plan/text into measurable goals ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_DECOMPOSE_GOALS,
    async (event, args: { workspaceId: string; input: string }) => {
      validateSender(event)
      if (!args.workspaceId || !args.input?.trim()) {
        throw new Error('workspaceId and input are required')
      }
      return goalDecomposerService.decompose({
        workspaceId: args.workspaceId,
        input: args.input
      })
    }
  )

  // ── mpa:campaignStart — run measurable goals sequentially ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_CAMPAIGN_START,
    (
      event,
      args: { workspaceId: string; title: string; originalPlanMd: string; goals: MeasurableGoal[] }
    ) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }
      if (!Array.isArray(args.goals) || args.goals.length === 0) {
        throw new Error('At least one goal is required')
      }
      // Reject if a standalone MPA pipeline is already running for this workspace
      // — otherwise the campaign's first goal would throw "pipeline already
      // running" inside the loop and immediately pause. (mpaCampaignService.start
      // already guards against a second concurrent campaign.)
      if (mpaOrchestrationService.isRunningForWorkspace(args.workspaceId)) {
        throw new Error(
          'A goal pipeline is already running for this workspace. Wait for it to finish before starting a campaign.'
        )
      }

      // Forward campaign + per-goal MPA events to the renderer. Must be wired
      // BEFORE start() — start() emits campaignStarted/campaignGoalStart
      // synchronously as the loop kicks off.
      wireCampaignEvents(args.workspaceId)

      return mpaCampaignService.start({
        workspaceId: args.workspaceId,
        workspacePath: workspace.repoPath,
        title: args.title,
        originalPlanMd: args.originalPlanMd,
        goals: args.goals
      })
    }
  )

  // ── mpa:campaignRespond — resolve a paused campaign (retry/skip/stop) ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_CAMPAIGN_RESPOND,
    (event, args: { workspaceId: string; action: MpaCampaignPauseAction }) => {
      validateSender(event)
      mpaCampaignService.respond(args.workspaceId, args.action)
      return { responded: true }
    }
  )

  // ── mpa:campaignCancel — cancel the active campaign ──

  ipcMain.handle(IPC_CHANNELS.MPA_CAMPAIGN_CANCEL, (event, args: { workspaceId: string }) => {
    validateSender(event)
    mpaCampaignService.cancel(args.workspaceId)
    return { cancelled: true }
  })

  // ── mpa:campaignGetHistory — persisted campaigns for a workspace ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_CAMPAIGN_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return mpaCampaignRepository.findByWorkspace(args.workspaceId, args.limit ?? 20)
    }
  )

  // ── mpa:campaignGetDetail — a campaign + its runs (grouped history) ──

  ipcMain.handle(IPC_CHANNELS.MPA_CAMPAIGN_GET_DETAIL, (event, args: { campaignId: string }) => {
    validateSender(event)
    const campaign = mpaCampaignRepository.findById(args.campaignId)
    if (!campaign) return null
    const runs = mpaRunRepository.findByCampaign(args.campaignId)
    return { campaign, runs }
  })

  // ── Stale run + campaign detection on registration ──
  // Mark any runs/campaigns that were active when the app last quit as 'failed'
  mpaOrchestrationService.reconcileStaleRuns()
  mpaCampaignService.reconcileStale()
}

// ── Event Forwarding (per-workspace, tagged with workspaceId) ──

const mpaCleanup = createTimedCleanupMap('mpa')

function wireMpaEvents(workspaceId: string): void {
  const cleanups = mpaCleanup.prepareCleanups(workspaceId)
  const router = getSessionEventRouter()

  mpaCleanup.addListener<MpaPhaseStartPayload>(
    cleanups,
    mpaOrchestrationService,
    'phaseStart',
    (payload) => {
      mpaLog.info(`[event] phaseStart: ${payload.phaseType} (iteration ${payload.iteration})`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCleanup.addListener<MpaPhaseProgressPayload>(
    cleanups,
    mpaOrchestrationService,
    'phaseProgress',
    (payload) => {
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters so the usage modal reflects MPA activity.
  mpaCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    mpaOrchestrationService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      router.sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  mpaCleanup.addListener<MpaPhaseCompletePayload>(
    cleanups,
    mpaOrchestrationService,
    'phaseComplete',
    (payload) => {
      mpaLog.info(`[event] phaseComplete: ${payload.phaseType} — ${payload.status}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCleanup.addListener<MpaFeedbackLoopPayload>(
    cleanups,
    mpaOrchestrationService,
    'feedbackLoop',
    (payload) => {
      mpaLog.info(
        `[event] feedbackLoop: ${payload.fromPhase} → ${payload.toPhase} (iteration ${payload.iteration})`
      )
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_FEEDBACK_LOOP,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCleanup.addListener<MpaApprovalNeededPayload>(
    cleanups,
    mpaOrchestrationService,
    'approvalNeeded',
    (payload) => {
      mpaLog.info(`[event] approvalNeeded for run ${payload.runId}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_APPROVAL_NEEDED,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCleanup.addListener<MpaPipelineCompletePayload>(
    cleanups,
    mpaOrchestrationService,
    'pipelineComplete',
    (payload) => {
      mpaLog.info(`[event] pipelineComplete: ${payload.status}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_PIPELINE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
      mpaCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 120 min (3 phases + approval gate + retry)
  mpaCleanup.scheduleAutoCleanup(workspaceId, cleanups, 120 * 60_000)
}

// ── Campaign Event Forwarding (per-workspace) ──

const mpaCampaignCleanup = createTimedCleanupMap('mpa-campaign')

function wireCampaignEvents(workspaceId: string): void {
  const cleanups = mpaCampaignCleanup.prepareCleanups(workspaceId)
  const router = getSessionEventRouter()

  mpaCampaignCleanup.addListener<MpaCampaignStartedPayload>(
    cleanups,
    mpaCampaignService,
    'campaignStarted',
    (payload) => {
      mpaLog.info(`[campaign-event] started: ${payload.campaignId} (${payload.totalGoals} goals)`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_CAMPAIGN_STARTED,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCampaignCleanup.addListener<MpaCampaignGoalStartPayload>(
    cleanups,
    mpaCampaignService,
    'campaignGoalStart',
    (payload) => {
      mpaLog.info(`[campaign-event] goalStart: #${payload.orderIndex} ${payload.title}`)
      // (Re)wire per-goal MPA phase events so the existing plan-gate / timeline /
      // stream UI works for the goal that is about to run.
      wireMpaEvents(workspaceId)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_CAMPAIGN_GOAL_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCampaignCleanup.addListener<MpaCampaignGoalCompletePayload>(
    cleanups,
    mpaCampaignService,
    'campaignGoalComplete',
    (payload) => {
      mpaLog.info(`[campaign-event] goalComplete: #${payload.orderIndex} ${payload.status}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_CAMPAIGN_GOAL_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCampaignCleanup.addListener<MpaCampaignPausedPayload>(
    cleanups,
    mpaCampaignService,
    'campaignPaused',
    (payload) => {
      mpaLog.info(`[campaign-event] paused: #${payload.orderIndex} ${payload.reason}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_CAMPAIGN_PAUSED,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  mpaCampaignCleanup.addListener<MpaCampaignCompletePayload>(
    cleanups,
    mpaCampaignService,
    'campaignComplete',
    (payload) => {
      mpaLog.info(`[campaign-event] complete: ${payload.status}`)
      router.sendWorkspaceEvent(
        IPC_CHANNELS.MPA_CAMPAIGN_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
      mpaCampaignCleanup.runCleanup(workspaceId)
      // Tear down any lingering per-goal phase listeners too.
      mpaCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: campaigns can be long — clean up after 8 hours.
  mpaCampaignCleanup.scheduleAutoCleanup(workspaceId, cleanups, 8 * 60 * 60_000)
}

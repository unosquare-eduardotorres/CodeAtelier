/**
 * MPA (Multi-Phased Agent) IPC handlers.
 *
 * Follows the audit.ipc.ts pattern:
 * - ipcMain.handle for request/response (start, cancel, getStatus, getRun, getHistory, classifyGoal)
 * - webContents.send for event forwarding (phaseStart, phaseProgress, phaseComplete, etc.)
 */

import { ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { createTimedCleanupMap } from './listener-cleanup'
import { mpaOrchestrationService } from '../services/mpa-orchestration.service'
import { classifyGoal } from '../services/mpa-preflight.service'
import { mpaRunRepository } from '../db/repositories/mpa-run.repository'
import { mpaArtifactRepository } from '../db/repositories/mpa-artifact.repository'
import { workspaceRepository } from '../db/repositories'
import { getSessionEventRouter } from '../services/session-event-router'
import type {
  MpaOrchestrateParams,
  MpaGoalType,
  MpaPhaseType,
  MpaPhaseStartPayload,
  MpaPhaseProgressPayload,
  MpaPhaseCompletePayload,
  MpaFeedbackLoopPayload,
  MpaApprovalNeededPayload,
  MpaPipelineCompletePayload,
  MpaStatus
} from '../../shared/mpa-types'

const mpaLog = log.scope('mpa-ipc')

export function registerMpaIpc(_mainWindow: BrowserWindow): void {
  // ── mpa:start — Launch pipeline ──

  ipcMain.handle(
    IPC_CHANNELS.MPA_START,
    async (
      event,
      args: {
        workspaceId: string
        goal: string
        title: string
        goalType: MpaGoalType
        phases: MpaPhaseType[]
        grillSessionId?: string
        grillDecisions?: Array<{ header: string; selectedOption: string; reason: string }>
      }
    ) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding (per-workspace, tagged with workspaceId)
      wireMpaEvents(args.workspaceId)

      const params: MpaOrchestrateParams = {
        workspaceId: args.workspaceId,
        workspacePath: workspace.repoPath,
        goal: args.goal,
        title: args.title,
        goalType: args.goalType,
        phases: args.phases,
        grillSessionId: args.grillSessionId,
        grillDecisions: args.grillDecisions
      }

      // Start orchestration (non-blocking)
      mpaOrchestrationService.orchestrate(params).catch((err) => {
        mpaLog.error('[mpa:start] Pipeline failed:', err)
      })

      return { started: true }
    }
  )

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

  // ── mpa:classifyGoal — Pre-flight goal classification ──

  ipcMain.handle(IPC_CHANNELS.MPA_CLASSIFY_GOAL, (event, args: { goal: string }) => {
    validateSender(event)
    return classifyGoal(args.goal)
  })

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

  // ── Stale run detection on registration ──
  // Mark any runs that were 'running' when the app last quit as 'failed'
  mpaOrchestrationService.reconcileStaleRuns()
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
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_PHASE_START, workspaceId, payload as unknown as Record<string, unknown>)
    }
  )

  mpaCleanup.addListener<MpaPhaseProgressPayload>(
    cleanups,
    mpaOrchestrationService,
    'phaseProgress',
    (payload) => {
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_PHASE_PROGRESS, workspaceId, payload as unknown as Record<string, unknown>)
    }
  )

  mpaCleanup.addListener<MpaPhaseCompletePayload>(
    cleanups,
    mpaOrchestrationService,
    'phaseComplete',
    (payload) => {
      mpaLog.info(`[event] phaseComplete: ${payload.phaseType} — ${payload.status}`)
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_PHASE_COMPLETE, workspaceId, payload as unknown as Record<string, unknown>)
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
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_FEEDBACK_LOOP, workspaceId, payload as unknown as Record<string, unknown>)
    }
  )

  mpaCleanup.addListener<MpaApprovalNeededPayload>(
    cleanups,
    mpaOrchestrationService,
    'approvalNeeded',
    (payload) => {
      mpaLog.info(`[event] approvalNeeded for run ${payload.runId}`)
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_APPROVAL_NEEDED, workspaceId, payload as unknown as Record<string, unknown>)
    }
  )

  mpaCleanup.addListener<MpaPipelineCompletePayload>(
    cleanups,
    mpaOrchestrationService,
    'pipelineComplete',
    (payload) => {
      mpaLog.info(`[event] pipelineComplete: ${payload.status}`)
      router.sendWorkspaceEvent(IPC_CHANNELS.MPA_PIPELINE_COMPLETE, workspaceId, payload as unknown as Record<string, unknown>)
      mpaCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 120 min (3 phases + approval gate + retry)
  mpaCleanup.scheduleAutoCleanup(workspaceId, cleanups, 120 * 60_000)
}

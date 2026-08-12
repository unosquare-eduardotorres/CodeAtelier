/**
 * IPC handlers for LLM Council evaluations.
 *
 * Bridges the renderer ↔ CouncilService and forwards streaming events
 * to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  CouncilInputType,
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict,
  CouncilPhase,
  LLMProvider,
  StructuredPlan,
  AgentStatus
} from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { createTimedCleanupMap } from './listener-cleanup'
import { workspaceRepository } from '../db/repositories'
import { councilService } from '../services/council.service'
import { councilPersistenceController } from '../services/council-persistence.controller'
import { councilSessionRepository } from '../db/repositories/council-session.repository'
import { getSessionEventRouter } from '../services/session-event-router'
import { validateSender } from './validate-sender'
import { notificationService } from '../services/notification.service'
import { resolveWorkspaceName } from './resolve-workspace-name'
import log from 'electron-log'

const councilLog = log.scope('council-ipc')

export function registerCouncilIpc(_mainWindow: BrowserWindow): void {
  // ── council:start — start a council evaluation ────────────────────

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_START,
    async (
      event,
      args: {
        workspaceId: string
        inputType: CouncilInputType
        planContent: string
        structuredPlan?: StructuredPlan | null
        originalUserRequest: string
        workspaceContext?: string
        filesInScope?: string[]
        conversationId?: string
        llmProvider?: LLMProvider
        grillSessionId?: string
      }
    ): Promise<{ sessionId: string }> => {
      validateSender(event)

      councilLog.info('[council:start] Handler invoked', {
        workspaceId: args?.workspaceId,
        inputType: args?.inputType
      })

      const {
        workspaceId,
        inputType,
        planContent,
        structuredPlan,
        originalUserRequest,
        workspaceContext,
        filesInScope,
        conversationId,
        llmProvider: explicitProvider,
        grillSessionId
      } = args

      if (councilService.isRunningForWorkspace(workspaceId)) {
        throw new Error('A council evaluation is already running for this workspace.')
      }

      // Resolve workspace path
      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${workspaceId} has no repo path`)

      // Resolve LLM provider: explicit → workspace setting → 'claude'
      const settings = workspaceRepository.getSettings(workspace.id)
      const llmProvider: LLMProvider = explicitProvider ?? settings.llmProvider ?? 'claude'

      // Create DB session upfront so the renderer gets the real DB UUID
      const dbSession = councilSessionRepository.createSession({
        workspaceId,
        inputType,
        inputContent: planContent,
        grillSessionId,
        structuredPlanJson: structuredPlan ? JSON.stringify(structuredPlan) : undefined,
        conversationId
      })
      const sessionId = dbSession.id

      // Start persistence tracking with the DB session ID
      councilPersistenceController.startTracking(sessionId, workspaceId, workspace.repoPath)

      // Wire event forwarding
      wireCouncilEvents(workspaceId, workspace.repoPath)

      // Start the council evaluation (non-blocking — runs in background)
      councilService
        .evaluate({
          workspaceId,
          workspacePath: workspace.repoPath,
          inputType,
          planContent,
          structuredPlan: structuredPlan ?? null,
          originalUserRequest,
          workspaceContext: workspaceContext ?? '',
          filesInScope: filesInScope ?? [],
          conversationId,
          grillSessionId,
          llmProvider,
          dbSessionId: sessionId
        })
        .catch((err) => {
          councilLog.error('[council:start] evaluate failed:', err)
        })

      return { sessionId }
    }
  )

  // ── council:cancel — abort running council ────────────────────────

  ipcMain.handle(IPC_CHANNELS.COUNCIL_CANCEL, (event, args?: { workspaceId?: string }): void => {
    validateSender(event)
    councilService.cancel(args?.workspaceId)
    councilPersistenceController.clearTracking()
  })

  // ── council:getSession — current council status for a workspace ───

  ipcMain.handle(IPC_CHANNELS.COUNCIL_GET_SESSION, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return councilService.getSessionState(args.workspaceId)
  })

  // ── council:resume — resume a failed/stale session ───

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_RESUME,
    async (event, args: { sessionId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error(`Workspace ${args.workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${args.workspaceId} has no repo path`)

      // Resolve LLM provider
      const settings = workspaceRepository.getSettings(workspace.id)
      const llmProvider = settings.llmProvider ?? 'claude'

      // Wire event forwarding
      wireCouncilEvents(args.workspaceId, workspace.repoPath)

      // Start persistence tracking
      councilPersistenceController.startTracking(
        args.sessionId,
        args.workspaceId,
        workspace.repoPath
      )

      // Resume (non-blocking)
      councilService
        .resumeSession({
          sessionId: args.sessionId,
          workspaceId: args.workspaceId,
          workspacePath: workspace.repoPath,
          llmProvider
        })
        .catch((err) => {
          councilLog.error('[council:resume] Resume failed:', err)
        })

      return { resumed: true }
    }
  )

  // ── council:getHistory — past council sessions for a workspace ───

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return councilSessionRepository.findByWorkspace(args.workspaceId, args.limit ?? 20)
    }
  )

  // ── council:deleteSession — delete a council session by ID ───

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_DELETE_SESSION,
    (event, args: { sessionId: string }): { deleted: boolean } => {
      validateSender(event)
      const deleted = councilSessionRepository.deleteSession(args.sessionId)
      return { deleted }
    }
  )

  // ── Stale session detection on registration ───
  councilService.reconcileStaleRuns()
}

// ── Event forwarding ─────────────────────────────────────────────────────

const councilCleanup = createTimedCleanupMap('council')

/**
 * Wire per-workspace event listeners for council evaluations.
 * Routes all events through SessionEventRouter via the persistence controller.
 */
function wireCouncilEvents(workspaceId: string, workspacePath: string): void {
  const cleanups = councilCleanup.prepareCleanups(workspaceId)
  // Lazy router resolution

  // ── phase-changed — forward to renderer ──
  councilCleanup.addListener<{ workspaceId: string; phase: CouncilPhase }>(
    cleanups,
    councilService,
    'phase-changed',
    (data) => {
      councilPersistenceController.handlePhaseChanged(data, getSessionEventRouter())
    }
  )

  // ── status — forward live token/context counters to the renderer ──
  councilCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    councilService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, {
        ...data.status
      })
    }
  )

  // ── member-stream — transform chunk + forward to renderer ──
  councilCleanup.addListener<{ workspaceId: string; advisorRole: string; chunk: StreamChunk }>(
    cleanups,
    councilService,
    'member-stream',
    (data) => {
      councilPersistenceController.handleMemberStream(data, workspacePath, getSessionEventRouter())
    }
  )

  // ── member-complete — forward parsed review ──
  councilCleanup.addListener<{
    workspaceId: string
    advisorRole: CouncilAdvisorRole
    review: CouncilReview | null
  }>(cleanups, councilService, 'member-complete', (data) => {
    councilPersistenceController.handleMemberComplete(data, getSessionEventRouter())
  })

  // ── peer-review-complete — forward rankings ──
  councilCleanup.addListener<{ workspaceId: string; peerReviews: CouncilPeerReview[] }>(
    cleanups,
    councilService,
    'peer-review-complete',
    (data) => {
      councilPersistenceController.handlePeerReviewComplete(data, getSessionEventRouter())
    }
  )

  // ── verdict — forward chairman verdict ──
  councilCleanup.addListener<{ workspaceId: string; verdict: CouncilVerdict }>(
    cleanups,
    councilService,
    'verdict',
    (data) => {
      councilPersistenceController.handleVerdict(data, getSessionEventRouter())

      notificationService.dispatch({
        workspaceId,
        workspaceName: resolveWorkspaceName(workspaceId),
        service: 'council',
        status: 'completed',
        summary: 'Council verdict delivered — review the recommendation',
        targetPage: 'council'
      })
    }
  )

  // ── session-ended — save transcript + cleanup (no renderer events) ──
  councilCleanup.addListener<{ workspaceId: string }>(
    cleanups,
    councilService,
    'session-ended',
    (data) => {
      councilPersistenceController
        .handleSessionEnded(data, getSessionEventRouter())
        .catch((err) => {
          councilLog.error('[council:session-ended] handleSessionEnded failed:', err)
        })
      councilCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 90 min
  councilCleanup.scheduleAutoCleanup(workspaceId, cleanups, 90 * 60_000)
}

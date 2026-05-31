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
  StructuredPlan
} from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { workspaceRepository } from '../db/repositories'
import { councilService } from '../services/council.service'
import { councilPersistenceController } from '../services/council-persistence.controller'
import { councilSessionRepository } from '../db/repositories/council-session.repository'
import { validateSender } from './validate-sender'
import log from 'electron-log'

const councilLog = log.scope('council-ipc')

export function registerCouncilIpc(mainWindow: BrowserWindow): void {
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
      }
    ): Promise<void> => {
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
        llmProvider: explicitProvider
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

      // Start persistence tracking
      const sessionId = `council-${Date.now()}`
      councilPersistenceController.startTracking(sessionId, workspaceId, workspace.repoPath)

      // Wire event forwarding
      wireCouncilEvents(mainWindow, workspace.repoPath)

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
          llmProvider
        })
        .catch((err) => {
          councilLog.error('[council:start] evaluate failed:', err)
        })
    }
  )

  // ── council:cancel — abort running council ────────────────────────

  ipcMain.handle(IPC_CHANNELS.COUNCIL_CANCEL, (event, args?: { workspaceId?: string }): void => {
    validateSender(event)
    councilService.cancel(args?.workspaceId)
    councilPersistenceController.clearTracking(mainWindow)
  })

  // ── council:getSession — current council status for a workspace ───

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_GET_SESSION,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      return councilService.getSessionState(args.workspaceId)
    }
  )

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
      wireCouncilEvents(mainWindow, workspace.repoPath)

      // Start persistence tracking
      councilPersistenceController.startTracking(args.sessionId, args.workspaceId, workspace.repoPath)

      // Resume (non-blocking)
      councilService.resumeSession({
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        workspacePath: workspace.repoPath,
        llmProvider
      }).catch((err) => {
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

  // ── Stale session detection on registration ───
  councilService.reconcileStaleRuns()
}

// ── Event forwarding ─────────────────────────────────────────────────────

/** Whether global listeners have been wired (only once). */
let councilListenersWired = false

/**
 * Wire persistent event listeners for council evaluations.
 * Called once — listeners persist across evaluations.
 */
function wireCouncilEvents(mainWindow: BrowserWindow, workspacePath: string): void {
  if (councilListenersWired) return
  councilListenersWired = true

  // ── phase-changed — forward to renderer ──
  councilService.on(
    'phase-changed',
    (data: { workspaceId: string; phase: CouncilPhase }) => {
      councilPersistenceController.handlePhaseChanged(data, mainWindow)
    }
  )

  // ── member-stream — transform chunk + forward to renderer ──
  councilService.on(
    'member-stream',
    (data: { workspaceId: string; advisorRole: string; chunk: StreamChunk }) => {
      councilPersistenceController.handleMemberStream(data, mainWindow, workspacePath)
    }
  )

  // ── member-complete — forward parsed review ──
  councilService.on(
    'member-complete',
    (data: { workspaceId: string; advisorRole: CouncilAdvisorRole; review: CouncilReview | null }) => {
      councilPersistenceController.handleMemberComplete(data, mainWindow)
    }
  )

  // ── peer-review-complete — forward rankings ──
  councilService.on(
    'peer-review-complete',
    (data: { workspaceId: string; peerReviews: CouncilPeerReview[] }) => {
      councilPersistenceController.handlePeerReviewComplete(data, mainWindow)
    }
  )

  // ── verdict — forward chairman verdict ──
  councilService.on(
    'verdict',
    (data: { workspaceId: string; verdict: CouncilVerdict }) => {
      councilPersistenceController.handleVerdict(data, mainWindow)
    }
  )

  // ── complete — save transcript ──
  councilService.on('complete', (data: { workspaceId: string }) => {
    councilPersistenceController
      .handleComplete(data, mainWindow)
      .catch((err) => {
        councilLog.error('[council:complete] handleComplete failed:', err)
      })
  })
}

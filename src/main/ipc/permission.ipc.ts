/**
 * Permission IPC — handles cross-workspace permission responses.
 *
 * When a background workspace session needs user input (elicitation, askQuestion,
 * MPA approval), the renderer shows a toast. The user's response flows back here
 * and is routed to the correct session.
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import baseLog from '../logger'
import { chatAgentService } from '../services'
import { mpaOrchestrationService } from '../services/mpa-orchestration.service'
import { validateSender } from './validate-sender'

const log = baseLog.scope('permission-ipc')

export function registerPermissionIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RESPONSE,
    async (
      event,
      args: {
        permissionId: string
        workspaceId: string
        type: 'elicitation' | 'askQuestion' | 'mpaApproval'
        response: unknown
      }
    ) => {
      validateSender(event)

      const { workspaceId, type, response } = args

      log.info(`[permission] Response received — workspace=${workspaceId} type=${type}`)

      switch (type) {
        case 'elicitation': {
          // Route elicitation response to the workspace's session
          const session = chatAgentService.getSessionForWorkspace(workspaceId)
          if (session) {
            session.emit('elicitationResponse', response)
          } else {
            log.warn(`[permission] No session for workspace ${workspaceId} — elicitation response dropped`)
          }
          break
        }

        case 'askQuestion': {
          // Route askQuestion response — extract requestId and answer from response
          const resp = response as { requestId?: string; answer?: string }
          if (resp.requestId && resp.answer) {
            chatAgentService.respondToAskUserForWorkspace(
              workspaceId,
              resp.requestId,
              resp.answer
            )
          } else {
            log.warn(`[permission] askQuestion response missing requestId or answer`)
          }
          break
        }

        case 'mpaApproval': {
          // Route MPA gate response
          const resp = response as { approved: boolean; feedback?: string; runId?: string }
          const runId = resp.runId ?? mpaOrchestrationService.currentRunId
          if (runId) {
            mpaOrchestrationService.respondToGate(runId, resp.approved, resp.feedback)
          } else {
            log.warn(`[permission] MPA approval response has no runId`)
          }
          break
        }

        default:
          log.warn(`[permission] Unknown permission type: ${type}`)
      }
    }
  )
}

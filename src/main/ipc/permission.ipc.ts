/**
 * Permission IPC — handles cross-workspace permission responses.
 *
 * When a background workspace session needs user input (elicitation, askQuestion,
 * MPA approval), the renderer shows a toast. The user's response flows back here
 * and is routed to the correct session.
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import log from 'electron-log/main'
import { chatAgentService } from '../services'
import { mpaOrchestrationService } from '../services/mpa-orchestration.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

const permLog = log.scope('permission-ipc')

export function registerPermissionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.PERMISSION_RESPONSE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PERMISSION_RESPONSE

    try {
      // IPC-02: Runtime validation — matches pattern used by 27+ other handlers
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const type = requireString(args, 'type', ch)

      if (!['elicitation', 'askQuestion', 'mpaApproval', 'toolPermission'].includes(type)) {
        throw new Error(
          `${ch}: type must be one of: elicitation, askQuestion, mpaApproval, toolPermission`
        )
      }

      const response = args.response

      permLog.info(`[permission] Response received — workspace=${workspaceId} type=${type}`)

      switch (type) {
        case 'elicitation': {
          // Route elicitation response to the workspace's session
          const session = chatAgentService.getSessionForWorkspace(workspaceId)
          if (session) {
            session.emit('elicitationResponse', response)
          } else {
            permLog.warn(
              `[permission] No session for workspace ${workspaceId} — elicitation response dropped`
            )
          }
          break
        }

        case 'askQuestion': {
          // Route askQuestion response — extract requestId and answer from response
          const resp = requireObject(response, `${ch}.response`) as {
            requestId?: string
            answer?: string
          }
          if (resp.requestId && resp.answer) {
            chatAgentService.respondToAskUserForWorkspace(
              workspaceId,
              resp.requestId as string,
              resp.answer as string
            )
          } else {
            permLog.warn(`[permission] askQuestion response missing requestId or answer`)
          }
          break
        }

        case 'mpaApproval': {
          // Route MPA gate response
          const resp = requireObject(response, `${ch}.response`) as {
            approved: boolean
            feedback?: string
            runId?: string
          }
          if (typeof resp.approved !== 'boolean') {
            throw new Error(`${ch}: field 'approved' must be a boolean`)
          }
          const runId = resp.runId ?? mpaOrchestrationService.currentRunId
          if (runId) {
            mpaOrchestrationService.respondToGate(runId, resp.approved, resp.feedback)
          } else {
            permLog.warn(`[permission] MPA approval response has no runId`)
          }
          break
        }

        case 'toolPermission': {
          // Route tool permission response — approve/deny from toast UI
          const approved = response === 'approve'
          // Extract requestId from the payload (stashed when the toast was created)
          const payload = (args as Record<string, unknown>).payload as
            { requestId?: string } | undefined
          const requestId = payload?.requestId
          if (requestId) {
            chatAgentService.respondToPermissionForWorkspace(workspaceId, requestId, approved)
          } else {
            permLog.warn(`[permission] toolPermission response missing requestId`)
          }
          break
        }

        default:
          permLog.warn(`[permission] Unknown permission type: ${type}`)
      }
    } catch (err) {
      permLog.error('[permission] Handler error:', err)
      throw err
    }
  })
}

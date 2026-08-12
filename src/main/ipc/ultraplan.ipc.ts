/**
 * UltraPlan IPC — handles teleport-back responses from the renderer.
 *
 * When the user approves a plan in the browser and selects "teleport back",
 * the CLI emits an event. The renderer shows a dialog with three options
 * (implement here, start new session, cancel). The user's choice flows back
 * here and is forwarded to the CLI process via stdin.
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import baseLog from '../logger'
import { chatAgentService } from '../services'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

const log = baseLog.scope('ultraplan-ipc')

export function registerUltraplanIpc(): void {
  ipcMain.handle(IPC_CHANNELS.ULTRAPLAN_RESPOND, async (event, rawArgs: unknown) => {
    validateSender(event)

    const ch = IPC_CHANNELS.ULTRAPLAN_RESPOND
    const args = requireObject(rawArgs, ch)
    const action = requireString(args, 'action', ch)

    log.info(`[ultraplan] Response received — action=${action}`)

    switch (action) {
      case 'implement_here':
        // Tell CLI to implement the plan in the current session
        ;(chatAgentService as any).sendCliSlashCommand('1')
        break

      case 'new_session':
        // Tell CLI to start a new session with the plan
        ;(chatAgentService as any).sendCliSlashCommand('2')
        break

      case 'cancel':
        // Tell CLI to cancel / save to file
        ;(chatAgentService as any).sendCliSlashCommand('3')
        break

      default:
        log.warn(`[ultraplan] Unknown action: ${action}`)
    }
  })
}

/**
 * Background process IPC — the first user-facing control over processes the
 * agent spawned via the process-manager MCP server.
 *
 * Those processes are spawned `detached` and deliberately survive both the
 * agent turn and the app itself.  Until now `stop_process` was agent-only, so
 * a runaway build had no stop button anywhere in the UI.  These three channels
 * back the "Background tasks" popover.
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject } from './validate-args'
import type {
  BackgroundProcessInfo,
  ProcessCancelWatchResult,
  ProcessStopResult
} from '../../shared/types'
import { backgroundTaskWatcherService } from '../services/background-task-watcher.service'

/** Extract a positive integer PID from an IPC payload, or throw. */
function requirePid(rawArgs: unknown, channel: string): number {
  const args = requireObject(rawArgs, channel)
  const pid = args.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${channel}: pid must be a positive integer`)
  }
  return pid
}

export function registerProcessIpc(): void {
  ipcMain.handle(IPC_CHANNELS.PROCESS_LIST, (event): BackgroundProcessInfo[] => {
    validateSender(event)
    return backgroundTaskWatcherService.listProcesses()
  })

  ipcMain.handle(
    IPC_CHANNELS.PROCESS_STOP,
    async (event, rawArgs: unknown): Promise<ProcessStopResult> => {
      validateSender(event)
      const pid = requirePid(rawArgs, IPC_CHANNELS.PROCESS_STOP)
      try {
        return await backgroundTaskWatcherService.stopProcess(pid)
      } catch (err) {
        log.error(`[process] Failed to stop pid ${pid}:`, err)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROCESS_CANCEL_WATCH,
    (event, rawArgs: unknown): ProcessCancelWatchResult => {
      validateSender(event)
      const pid = requirePid(rawArgs, IPC_CHANNELS.PROCESS_CANCEL_WATCH)
      return backgroundTaskWatcherService.cancelWatch(pid)
    }
  )

  log.info('[Process] IPC handlers registered')
}

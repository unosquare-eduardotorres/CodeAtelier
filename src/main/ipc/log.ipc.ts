import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

const rendererLog = log.scope('Renderer')

/** LOG-01: Allowed log levels — prevents prototype pollution via arbitrary method calls */
const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug'] as const)
type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export function registerLogIpc(): void {
  ipcMain.handle(IPC_CHANNELS.LOG_FROM_RENDERER, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.LOG_FROM_RENDERER
    const args = requireObject(rawArgs, ch)
    const level = requireString(args, 'level', ch)
    const message = requireString(args, 'message', ch)

    // LOG-01: Validate level against known set — prevents calling arbitrary methods
    // like rendererLog['constructor']() or rendererLog['__proto__']()
    if (!VALID_LOG_LEVELS.has(level as LogLevel)) {
      throw new Error(`${ch}: field 'level' must be one of: error, warn, info, debug`)
    }

    const data = Array.isArray(args.data) ? args.data : undefined
    if (data?.length) {
      rendererLog[level as LogLevel](message, ...data)
    } else {
      rendererLog[level as LogLevel](message)
    }
  })
}

/**
 * Renderer-side logger that forwards messages to the main process via electron-log.
 *
 * In development: logs to both browser console (for DevTools) AND main process log files.
 * In production: logs to main process log files via IPC (console output is invisible).
 *
 * Usage:
 *   import { rendererLog } from '@renderer/utils/logger'
 *   rendererLog.error('Something failed:', error)
 *   rendererLog.warn('Unexpected state:', data)
 *   rendererLog.info('Operation completed')
 *   rendererLog.debug('Debug detail:', obj)
 */

function createRendererLog(level: 'error' | 'warn' | 'info' | 'debug') {
  return (message: string, ...data: unknown[]): void => {
    // Always log to console in dev for DevTools visibility
    const consoleMethod = level === 'debug' ? 'log' : level
    console[consoleMethod](`[${level.toUpperCase()}]`, message, ...data)

    // Forward to main process for persistent file logging
    try {
      window.api.log({
        level,
        message,
        data: data.length > 0 ? data : undefined
      })
    } catch {
      // Pre-bridge or IPC not ready — console-only fallback is sufficient
    }
  }
}

export const rendererLog = {
  error: createRendererLog('error'),
  warn: createRendererLog('warn'),
  info: createRendererLog('info'),
  debug: createRendererLog('debug')
}

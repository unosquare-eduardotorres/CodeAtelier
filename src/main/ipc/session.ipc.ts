import { ipcMain } from 'electron'
import { execFileSync } from 'node:child_process'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString
} from './validate-args'
import log from 'electron-log/main'

const sessionLog = log.scope('SessionIPC')

/**
 * Execute a Claude CLI command and return parsed JSON output.
 * Uses `claude` in print mode with JSON output for session operations.
 */
function claudeExec(args: string[], cwd?: string): unknown {
  const result = execFileSync('claude', [...args, '--output-format', 'json'], {
    encoding: 'utf-8',
    timeout: 10_000,
    cwd
  })
  return JSON.parse(result.trim())
}

/**
 * Session Management IPC handlers — bridges renderer requests to CLI
 * session management commands.
 *
 * These do NOT require an active session — they operate on persisted sessions.
 *
 * Every handler runs `validateSender` first, then performs field-level runtime
 * validation on its args.
 *
 * Note: Some operations (rename, tag, fork) previously used SDK functions.
 * They now use the `claude` CLI or direct file operations where available.
 */
export function registerSessionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (event, args?: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_LIST
    let parsed: { dir?: string; limit?: number; offset?: number } | undefined
    if (args !== undefined) {
      const obj = requireObject(args, channel)
      parsed = {
        dir: optionalString(obj, 'dir', channel),
        limit: optionalNumber(obj, 'limit', channel),
        offset: optionalNumber(obj, 'offset', channel)
      }
    }
    try {
      const cliArgs = ['-p', 'list sessions', '--print']
      if (parsed?.dir) cliArgs.push('--add-dir', parsed.dir)
      return claudeExec(cliArgs, parsed?.dir)
    } catch (err) {
      sessionLog.warn('[SESSION_LIST] CLI fallback failed, returning empty:', err)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_INFO, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_GET_INFO
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const dir = optionalString(obj, 'dir', channel)
    try {
      return claudeExec(['--resume', sessionId, '-p', '--print', 'session info'], dir)
    } catch (err) {
      sessionLog.warn(`[SESSION_GET_INFO] Failed for ${sessionId}:`, err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_GET_MESSAGES
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const _dir = optionalString(obj, 'dir', channel)
    const _includeSystemMessages = optionalBoolean(obj, 'includeSystemMessages', channel)
    // Not yet implemented — requires CLI support or direct session file reader.
    // Return a typed error so the renderer can surface "Not yet available" to the user.
    sessionLog.warn(`[NOT_IMPLEMENTED] SESSION_GET_MESSAGES called for ${sessionId}`)
    return {
      error: 'not_implemented',
      message: 'Session message inspection requires CLI implementation'
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_RENAME
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const title = requireString(obj, 'title', channel)
    const _dir = optionalString(obj, 'dir', channel)
    try {
      // CLI supports --name flag for naming sessions
      return claudeExec(['--resume', sessionId, '-p', '--name', title, '--print', 'renamed'], _dir)
    } catch (err) {
      sessionLog.warn(`[SESSION_RENAME] Failed for ${sessionId}:`, err)
      return { success: false, error: 'Session rename not available without SDK' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_TAG, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_TAG
    const obj = requireObject(args, channel)
    const _sessionId = requireString(obj, 'sessionId', channel)
    const tagRaw = optionalNullableString(obj, 'tag', channel)
    if (tagRaw === undefined) {
      throw new Error(`${channel}: field 'tag' is required (use null to clear)`)
    }
    const _dir = optionalString(obj, 'dir', channel)
    // Not yet implemented — requires CLI support or direct session file modification.
    sessionLog.warn(`[NOT_IMPLEMENTED] SESSION_TAG called for ${_sessionId}`)
    return {
      success: false,
      error: 'not_implemented',
      message: 'Session tagging not yet available'
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_FORK
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const _upToMessageId = optionalString(obj, 'upToMessageId', channel)
    const _title = optionalString(obj, 'title', channel)
    const dir = optionalString(obj, 'dir', channel)
    try {
      // CLI supports --fork-session with --resume
      const cliArgs = ['--resume', sessionId, '--fork-session', '-p', '--print', 'forked']
      if (_title) cliArgs.push('--name', _title)
      return claudeExec(cliArgs, dir)
    } catch (err) {
      sessionLog.warn(`[SESSION_FORK] Failed for ${sessionId}:`, err)
      return { success: false, error: 'Session fork failed' }
    }
  })
}

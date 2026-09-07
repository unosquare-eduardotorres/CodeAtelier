/**
 * IPC handlers for the Impeccable-powered design audit.
 *
 * Design runs share audit storage: every row this module reads or writes is an
 * `audit_runs` row with `kind = 'design'` (migration 160), so history,
 * retention, results and handoff machinery are reused rather than duplicated.
 *
 * P2 scope — the read paths and validation are real and wired; the execution
 * handlers (DESIGN_START / DESIGN_CANCEL / DESIGN_ROUTE) are registered so the
 * channel surface exists, but deliberately report "not implemented" until
 * DesignAgentService lands in P3. They return a structured failure rather than
 * throwing, so a renderer wired early degrades instead of showing a raw
 * IPC exception.
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { DESIGN_COMMANDS, validateDesignCommandSet } from '../../shared/design-commands'
import type { DesignCommandId, DesignRunConfig, DesignScope } from '../../shared/types'
import { auditRepository } from '../db/repositories'
import { requireObject, requireString } from './validate-args'
import { mainLogger } from '../logger'

const log = mainLogger

/** Cap mirroring the audit history limit. */
const DESIGN_HISTORY_LIMIT = 10

interface NotImplementedResult {
  ok: false
  reason: string
}

function notImplemented(what: string): NotImplementedResult {
  return { ok: false, reason: `${what} is not implemented until P3 (DesignAgentService)` }
}

/**
 * Validate a renderer-supplied run config.
 *
 * Throws on malformed input (the renderer is not trusted to send well-formed
 * ids) and returns a narrowed, known-good config.
 */
export function parseDesignRunConfig(args: unknown, channel: string): DesignRunConfig {
  const obj = requireObject(args, channel)

  const rawIds = obj.commandIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error(`${channel}: commandIds must be a non-empty array`)
  }
  const known = new Set(DESIGN_COMMANDS.map((c) => c.id as string))
  const commandIds: DesignCommandId[] = []
  for (const id of rawIds) {
    if (typeof id !== 'string' || !known.has(id)) {
      throw new Error(`${channel}: unknown design command '${String(id)}'`)
    }
    // De-dupe rather than reject: a double-click in the card grid is a UI
    // artefact, not a user error.
    if (!commandIds.includes(id as DesignCommandId)) commandIds.push(id as DesignCommandId)
  }

  // The incompatibility matrix is enforced here too, not just in the wizard —
  // an out-of-date renderer must not be able to start a contradictory run.
  const validation = validateDesignCommandSet(commandIds)
  if (!validation.valid) {
    const pairs = validation.conflicts.map(([a, b]) => `${a}+${b}`).join(', ')
    throw new Error(`${channel}: incompatible command selection (${pairs})`)
  }

  const scopeRaw = obj.scope
  let scope: DesignScope = { mode: 'project', paths: [] }
  if (scopeRaw !== undefined) {
    const s = requireObject(scopeRaw, `${channel}.scope`)
    const mode = s.mode === 'paths' ? 'paths' : 'project'
    const paths = Array.isArray(s.paths)
      ? s.paths.filter((p): p is string => typeof p === 'string')
      : []
    if (mode === 'paths' && paths.length === 0) {
      throw new Error(`${channel}: scope.mode 'paths' requires at least one path`)
    }
    scope = { mode, paths: mode === 'paths' ? paths : [] }
  }

  const brief = typeof obj.brief === 'string' ? obj.brief : ''
  const llmProvider = typeof obj.llmProvider === 'string' ? obj.llmProvider : undefined

  return { commandIds, scope, brief, llmProvider }
}

export function registerDesignIpc(_mainWindow: BrowserWindow): void {
  // ── Catalogue-driven validation (pure, available now) ─────────────────────

  ipcMain.handle(IPC_CHANNELS.DESIGN_START, async (_e, args: unknown) => {
    // Validate eagerly so a malformed payload fails loudly and identically to
    // how it will once the service exists.
    const config = parseDesignRunConfig(args, IPC_CHANNELS.DESIGN_START)
    log.info(
      `[design] START requested (${config.commandIds.join(', ')}; scope=${config.scope.mode}) — not yet implemented`
    )
    return notImplemented('design:start')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_CANCEL, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_CANCEL)
    requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_CANCEL)
    return notImplemented('design:cancel')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_ROUTE, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_ROUTE)
    requireString(obj, 'brief', IPC_CHANNELS.DESIGN_ROUTE)
    return notImplemented('design:route')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_CONTEXT_STATUS, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_CONTEXT_STATUS)
    requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_CONTEXT_STATUS)
    return notImplemented('design:contextStatus')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_GENERATE_REPORT, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GENERATE_REPORT)
    requireString(obj, 'runId', IPC_CHANNELS.DESIGN_GENERATE_REPORT)
    return notImplemented('design:generateReport')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT)
    requireString(obj, 'runId', IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT)
    return notImplemented('design:handoffToBlueprint')
  })

  // ── Read paths (fully functional — they only need the kind discriminator) ──

  ipcMain.handle(IPC_CHANNELS.DESIGN_GET_LATEST, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GET_LATEST)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_GET_LATEST)
    return auditRepository.getLatestForWorkspace(workspaceId, 'design')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_GET_HISTORY, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GET_HISTORY)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_GET_HISTORY)
    return auditRepository.getHistoryForWorkspace(workspaceId, DESIGN_HISTORY_LIMIT, 'design')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_DELETE_RUN, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_DELETE_RUN)
    const runId = requireString(obj, 'runId', IPC_CHANNELS.DESIGN_DELETE_RUN)

    // Deleting by id alone would let a design-page call remove a Workspace
    // Health run. Confirm the row is actually a design run first.
    const run = auditRepository.findRunById(runId)
    if (!run) return { ok: false, reason: 'run not found' }
    if (run.kind !== 'design') {
      log.warn(`[design] refused to delete non-design run ${runId} (kind=${run.kind})`)
      return { ok: false, reason: 'not a design run' }
    }
    return { ok: auditRepository.deleteRun(runId) }
  })

  log.info('[design] IPC handlers registered')
}

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
 *
 * ── Trust boundary ───────────────────────────────────────────────────────────
 * `parseDesignRunConfig` is the only thing standing between a renderer payload
 * and P3's file enumeration / `impeccable detect <targets>` spawn, both of which
 * run with `cwd = workspacePath`. Every field is bounded and every path is
 * proven workspace-relative HERE, before any consumer exists — validation added
 * after the consumer is validation that arrives too late.
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { isAbsolute, normalize } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import { DESIGN_COMMANDS, validateDesignCommandSet } from '../../shared/design-commands'
import type {
  AuditRun,
  DesignCommandId,
  DesignIpcResult,
  DesignRunConfig,
  DesignScope
} from '../../shared/types'
import { auditRepository } from '../db/repositories'
import { requireObject, requireString } from './validate-args'
import { mainLogger } from '../logger'

const log = mainLogger

/** Cap mirroring the audit history limit. */
const DESIGN_HISTORY_LIMIT = 10

/**
 * Brief cap. The brief flows into the routing prompt and into every command's
 * remediation section, so it is multiplied per round and per command — an
 * unbounded brief is a cost incident, not just a large string.
 */
export const MAX_BRIEF_CHARS = 4_000

/**
 * Scope cap. Well above any realistic hand-picked selection, low enough that a
 * runaway renderer cannot hand P3 an enumeration list that never terminates.
 */
export const MAX_SCOPE_PATHS = 200

// ── Result envelope (A7) ─────────────────────────────────────────────────────

function ok<T>(data: T): DesignIpcResult<T> {
  return { ok: true, data }
}

function fail(reason: string): DesignIpcResult<never> {
  return { ok: false, reason }
}

function notImplemented(what: string): DesignIpcResult<never> {
  return fail(`${what} is not implemented until P3 (DesignAgentService)`)
}

/**
 * Normalise one renderer-supplied scope path to a workspace-relative form,
 * throwing if it could escape the workspace.
 *
 * Rejects absolute POSIX paths, Windows drive/UNC paths, NUL bytes, and any
 * path that still climbs after normalisation (`../x`, `a/../../x`). The result
 * is always POSIX-separated and free of `./` so downstream comparison and
 * de-duplication are string-exact.
 */
export function normalizeScopePath(raw: string, channel: string): string {
  const reject = (why: string): never => {
    throw new Error(`${channel}: scope path ${JSON.stringify(raw)} ${why}`)
  }

  if (raw.includes('\0')) reject('contains a NUL byte')

  const trimmed = raw.trim()
  if (trimmed.length === 0) reject('is empty')

  // `isAbsolute` is platform-dependent, so check both conventions explicitly:
  // a POSIX main process must still reject `C:\` and `\\server\share`.
  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    reject('must be workspace-relative, not absolute')
  }

  // `normalize` resolves interior `..` segments, so anything that still starts
  // with `..` afterwards genuinely escapes the workspace root.
  const normalized = normalize(trimmed).replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '..' || normalized.startsWith('../')) {
    reject('escapes the workspace root')
  }
  if (normalized === '.' || normalized.length === 0) {
    reject('must name a file or directory')
  }

  return normalized.startsWith('./') ? normalized.slice(2) : normalized
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

    let paths: string[] = []
    if (mode === 'paths') {
      const rawPaths = s.paths
      if (!Array.isArray(rawPaths)) {
        throw new Error(`${channel}: scope.paths must be an array`)
      }
      if (rawPaths.length > MAX_SCOPE_PATHS) {
        throw new Error(
          `${channel}: scope.paths has ${rawPaths.length} entries (max ${MAX_SCOPE_PATHS})`
        )
      }
      for (const p of rawPaths) {
        if (typeof p !== 'string') {
          throw new Error(`${channel}: scope.paths entries must be strings`)
        }
        const normalized = normalizeScopePath(p, channel)
        if (!paths.includes(normalized)) paths.push(normalized)
      }
      if (paths.length === 0) {
        throw new Error(`${channel}: scope.mode 'paths' requires at least one path`)
      }
    } else {
      // Silently dropped rather than rejected: 'project' scope ignores paths,
      // and a wizard that toggles back to project-wide may leave stale entries.
      paths = []
    }

    scope = { mode, paths }
  }

  const rawBrief = typeof obj.brief === 'string' ? obj.brief : ''
  if (rawBrief.length > MAX_BRIEF_CHARS) {
    throw new Error(`${channel}: brief is ${rawBrief.length} characters (max ${MAX_BRIEF_CHARS})`)
  }
  const brief = rawBrief.trim()

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
    const brief = requireString(obj, 'brief', IPC_CHANNELS.DESIGN_ROUTE)
    // Routing sends the brief to an LLM, so it is bounded on this path too.
    if (brief.length > MAX_BRIEF_CHARS) {
      throw new Error(
        `${IPC_CHANNELS.DESIGN_ROUTE}: brief is ${brief.length} characters (max ${MAX_BRIEF_CHARS})`
      )
    }
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
    return ok<AuditRun | null>(auditRepository.getLatestForWorkspace(workspaceId, 'design'))
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_GET_HISTORY, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GET_HISTORY)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_GET_HISTORY)
    return ok(auditRepository.getHistoryForWorkspace(workspaceId, DESIGN_HISTORY_LIMIT, 'design'))
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_DELETE_RUN, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_DELETE_RUN)
    const runId = requireString(obj, 'runId', IPC_CHANNELS.DESIGN_DELETE_RUN)

    // Deleting by id alone would let a design-page call remove a Workspace
    // Health run. Confirm the row is actually a design run first.
    const run = auditRepository.findRunById(runId)
    if (!run) return fail('run not found')
    if (run.kind !== 'design') {
      log.warn(`[design] refused to delete non-design run ${runId} (kind=${run.kind})`)
      return fail('not a design run')
    }
    return auditRepository.deleteRun(runId) ? ok(null) : fail('delete failed')
  })

  log.info('[design] IPC handlers registered')
}

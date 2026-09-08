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
import {
  DESIGN_COMMANDS,
  toDesignTrackId,
  validateDesignCommandSet
} from '../../shared/design-commands'
import type {
  AgentStatus,
  AuditRun,
  AuditTrackId,
  DesignCommandId,
  DesignIpcResult,
  DesignRunConfig,
  DesignScope,
  LLMProvider
} from '../../shared/types'
import { auditRepository, workspaceRepository } from '../db/repositories'
import { requireObject, requireString } from './validate-args'
import { mainLogger } from '../logger'
import { detectTechStack } from '../services/tech-stack-detector.service'
import {
  DesignAgentService,
  designAgentService,
  type DesignCompletePayload,
  type DesignIntermediateFindingsPayload,
  type DesignProgressPayload,
  type DesignResultPayload,
  type DesignStreamPayload
} from '../services/design-agent.service'
import { getSessionEventRouter } from '../services/session-event-router'
import { createTimedCleanupMap } from './listener-cleanup'
import { notificationService } from '../services/notification.service'
import { resolveWorkspaceName } from './resolve-workspace-name'

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
  return fail(`${what} is not implemented yet`)
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
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_START)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_START)
    const config = parseDesignRunConfig(args, IPC_CHANNELS.DESIGN_START)

    if (designAgentService.isRunningForWorkspace(workspaceId)) {
      return fail('A design run is already in progress for this workspace.')
    }

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) return fail(`Workspace ${workspaceId} not found`)
    if (!workspace.repoPath) return fail(`Workspace ${workspaceId} has no repo path`)
    const workspacePath = workspace.repoPath

    const settings = workspaceRepository.getSettings(workspaceId)
    const llmProvider: LLMProvider =
      (config.llmProvider as LLMProvider | undefined) ?? settings.llmProvider ?? 'claude'

    const detectedTechs = detectTechStack(workspacePath).detectedTechs

    // The run row records the user's FULL selection (refine cards included) so a
    // later report or blueprint handoff can reproduce their intent. Only the
    // evaluate commands get result rows, because only those execute.
    const selectedTracks: AuditTrackId[] = config.commandIds.map(toDesignTrackId)
    const executable = DesignAgentService.resolveExecutableCommands(config)

    // 'deep' is the only honest mode here: a design run has no light/deep split,
    // and 'deep' is what the multi-round session actually performs.
    const run = auditRepository.createRun(
      workspaceId,
      'deep',
      selectedTracks,
      detectedTechs,
      { commandIds: config.commandIds, scope: config.scope, brief: config.brief },
      'design'
    )
    run.results = auditRepository.createResults(run.id, executable.map(toDesignTrackId))

    log.info(
      `[design:start] workspaceId=${workspaceId} runId=${run.id} ` +
        `commands=${config.commandIds.join(',')} executing=${executable.join(',')} ` +
        `scope=${config.scope.mode} provider=${llmProvider}`
    )

    wireDesignEvents(run.id, workspaceId)

    // Non-blocking: the run streams progress over the event channels.
    designAgentService
      .runDesign({ workspaceId, workspacePath, config, designRunId: run.id, llmProvider })
      .catch((err) => {
        log.error('[design:start] runDesign failed:', err)
      })

    auditRepository.updateRun(run.id, { status: 'running' })
    run.status = 'running'

    return ok(run)
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_CANCEL, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_CANCEL)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_CANCEL)
    designAgentService.cancel(workspaceId)
    log.info(`[design:cancel] workspaceId=${workspaceId}`)
    return ok(null)
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

// ── Event forwarding ───────────────────────────────────────────────────────

/** Per-workspace listener cleanup, mirroring `audit.ipc.ts`. */
const designCleanup = createTimedCleanupMap('design')

/**
 * Bridge `designAgentService` events to the renderer and to the DB.
 *
 * Persisting here rather than inside the service keeps the service free of
 * repository knowledge and testable with stubbed sessions — the same split
 * `audit.ipc.ts` uses.
 *
 * ── Why every listener re-checks `workspaceId` ──
 * `DESIGN_START` guards on `isRunningForWorkspace`, so two workspaces may run
 * design passes concurrently — but `designAgentService` is a singleton emitter,
 * so each of these listeners sees BOTH runs' events. Without the guard,
 * workspace A's listener writes workspace B's findings into A's run row and
 * completes A's run when B finishes. (`audit.ipc.ts` has the same listener
 * shape but is protected by a *global* running guard; fixing it is a separate
 * ticket, tracked in the plan doc.)
 */
function wireDesignEvents(runId: string, workspaceId: string): void {
  const cleanups = designCleanup.prepareCleanups(workspaceId)

  // ── progress ──
  designCleanup.addListener<DesignProgressPayload>(
    cleanups,
    designAgentService,
    'progress',
    (data) => {
      if (data.workspaceId !== workspaceId) return

      if (data.status === 'running' || data.status === 'cancelled') {
        const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
        if (resultRow) {
          auditRepository.updateResult(resultRow.id, {
            status: data.status,
            ...(data.status === 'running' ? { startedAt: new Date().toISOString() } : {})
          })
        }
      }

      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.DESIGN_PROGRESS,
        workspaceId,
        data as unknown as Record<string, unknown>
      )
    }
  )

  // ── result ──
  designCleanup.addListener<DesignResultPayload>(cleanups, designAgentService, 'result', (data) => {
    if (data.workspaceId !== workspaceId) return

    const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
    if (resultRow) {
      auditRepository.updateResult(resultRow.id, {
        status: data.status,
        score: data.score,
        findings: data.findings,
        summary: data.summary,
        skillsUsed: data.skillsUsed,
        completedAt: new Date().toISOString(),
        coverageStats: data.coverageStats,
        coverageSufficient: data.coverageSufficient
      })
    }

    const updated = resultRow ? auditRepository.findResultById(resultRow.id) : null
    if (updated) {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.DESIGN_RESULT,
        workspaceId,
        updated as unknown as Record<string, unknown>
      )
    }
  })

  // ── intermediate findings ── persisted for crash resilience mid-run
  designCleanup.addListener<DesignIntermediateFindingsPayload>(
    cleanups,
    designAgentService,
    'intermediate_findings',
    (data) => {
      if (data.workspaceId !== workspaceId) return

      const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
      if (resultRow) {
        auditRepository.updateResult(resultRow.id, {
          findings: data.findings,
          summary: `Round ${data.roundNumber}: ${data.findings.length} finding(s), ${data.coverageStats.fileCount} file(s) reviewed`,
          coverageStats: data.coverageStats
        })
      }

      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.DESIGN_INTERMEDIATE, workspaceId, {
        trackId: data.trackId,
        findings: data.findings,
        coverageStats: data.coverageStats,
        roundNumber: data.roundNumber,
        totalRounds: data.totalRounds,
        totalFiles: data.totalFiles,
        batchSize: data.batchSize
      })
    }
  )

  // ── complete ──
  designCleanup.addListener<DesignCompletePayload>(
    cleanups,
    designAgentService,
    'complete',
    (data) => {
      if (data.workspaceId !== workspaceId) return

      const results = auditRepository.findResultsByRunId(runId)
      const hasFailed = results.some((r) => r.status === 'failed')
      const hasCancelled = results.some((r) => r.status === 'cancelled')

      let finalStatus: 'completed' | 'partial' | 'cancelled' = 'completed'
      if (hasCancelled && !results.some((r) => r.status === 'completed')) {
        finalStatus = 'cancelled'
      } else if (hasFailed || hasCancelled) {
        finalStatus = 'partial'
      }

      const updatedRun = auditRepository.updateRun(runId, {
        status: finalStatus,
        overallScore: data.overallScore
      })

      if (updatedRun) {
        getSessionEventRouter().sendWorkspaceEvent(
          IPC_CHANNELS.DESIGN_COMPLETE,
          workspaceId,
          updatedRun as unknown as Record<string, unknown>
        )
      }

      if (finalStatus !== 'cancelled') {
        notificationService.dispatch({
          workspaceId,
          workspaceName: resolveWorkspaceName(workspaceId),
          // A design run is not an audit run: announcing 'audit' made a
          // finished design review say "Audit completed" and navigate to the
          // Workspace Health page. `targetPage: 'design'` has no PAGE_NAV_MAP
          // entry until P4.5 lands the Design page — an unmapped page is a
          // no-op click, which beats navigating somewhere wrong.
          service: 'design',
          status: 'completed',
          summary:
            finalStatus === 'partial'
              ? `Design review finished (partial) — score: ${data.overallScore ?? 'N/A'}`
              : `Design review completed — score: ${data.overallScore ?? 'N/A'}`,
          targetPage: 'design'
        })
      }

      log.info(
        `[design:complete] runId=${runId} status=${finalStatus} overallScore=${data.overallScore}`
      )

      designCleanup.runCleanup(workspaceId)
    }
  )

  // ── stream ── raw chunk passthrough for the live run view
  designCleanup.addListener<DesignStreamPayload>(cleanups, designAgentService, 'stream', (data) => {
    if (data.workspaceId !== workspaceId) return

    getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.DESIGN_STREAM_CHUNK, workspaceId, {
      trackId: data.trackId,
      chunk: data.chunk as unknown as Record<string, unknown>
    })
  })

  // ── status ── live token/context counters
  designCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    designAgentService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, {
        ...data.status
      })
    }
  )
}

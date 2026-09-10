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
  DesignRouteResult,
  DesignRunConfig,
  DesignScope,
  DesignScopeTree,
  LLMProvider
} from '../../shared/types'
import {
  auditRepository,
  workspaceRepository,
  auditHandoffRepository,
  handoffRepository
} from '../db/repositories'
import {
  buildDesignBlueprintTitle,
  deriveBlueprintPriority,
  formatDesignRemediationBrief
} from '../../shared/design-blueprint-format'
import { generateReportForRun, getReportPath, displayPath } from '../services/design-report.service'
import { blueprintService } from '../services/blueprint.service'
import { randomUUID } from 'node:crypto'
import type { AuditFinding } from '../../shared/types'
import type { HandoffEnvelope } from '../../shared/handoff-types'
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
import { discoverDesignFiles } from '../services/design-discovery.service'
import { designRouteService } from '../services/design-route.service'
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

/**
 * Cap on directories returned by `design:scopeTree`.
 *
 * The picker is a list a human reads, not a full tree; beyond a couple of
 * hundred rows it is noise, and an unbounded rollup of a monorepo would ship
 * thousands of entries across IPC for no gain.
 */
export const MAX_SCOPE_TREE_DIRS = 200

/**
 * Coverage a child directory must still hold before `suggested` descends into
 * it.
 *
 * Ranking directories by file count alone degenerates: cumulative counts make
 * every ancestor score at least as high as its children, so the answer would
 * always be the top-level directory — i.e. "the whole project", which is the
 * default P3.7.9 measured at 37.8 s and exists to avoid. Descending the densest
 * chain while coverage holds instead lands on the tightest directory that still
 * contains essentially all the design surface.
 */
const SUGGESTED_MIN_COVERAGE = 0.8

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

// ── Scope tree (P4.0) ────────────────────────────────────────────

/** `'a/b/c.tsx'` → `'a/b'`; a workspace-root path has no parent. */
function parentDir(path: string): string | null {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? null : path.slice(0, cut)
}

/**
 * Cumulative design-relevant file counts for every ancestor directory.
 *
 * Cumulative rather than direct-children-only: the picker offers directories as
 * *scopes*, and selecting `src/renderer` reviews everything beneath it, so the
 * number next to it has to be that same everything.
 */
export function rollupScopeDirs(filePaths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const filePath of filePaths) {
    let cursor = parentDir(filePath)
    while (cursor !== null) {
      counts.set(cursor, (counts.get(cursor) ?? 0) + 1)
      cursor = parentDir(cursor)
    }
  }
  return counts
}

/**
 * The directory to preselect: walk down the densest chain from the root for as
 * long as the child still holds `SUGGESTED_MIN_COVERAGE` of the whole workspace.
 *
 * Returns null when there is nothing to suggest — an empty workspace, or one
 * whose design files all sit at the root — in which case the UI falls back to
 * whole-project scope.
 */
export function pickSuggestedDir(
  counts: ReadonlyMap<string, number>,
  totalFiles: number
): string | null {
  if (totalFiles === 0) return null

  const byParent = new Map<string | null, Array<[string, number]>>()
  for (const entry of counts) {
    const key = parentDir(entry[0])
    const bucket = byParent.get(key)
    if (bucket) bucket.push(entry)
    else byParent.set(key, [entry])
  }

  const floor = totalFiles * SUGGESTED_MIN_COVERAGE
  let current: string | null = null
  // Terminates: each step strictly increases path depth.
  for (;;) {
    const children = byParent.get(current)
    if (!children || children.length === 0) return current
    let best = children[0]
    for (const child of children) {
      if (child[1] > best[1]) best = child
    }
    if (best[1] < floor) return current
    current = best[0]
  }
}

/**
 * Reconcile a run the DB still calls `running`/`pending` while nothing executes.
 *
 * Without this a run interrupted by a quit or a crash dead-ends the Design tab
 * for that workspace forever: `loadLatest` derives `isRunning` from the row, the
 * page pins itself to the run view, and Cancel is a no-op because
 * `designAgentService` lost its in-memory state on restart — so nothing ever
 * writes a terminal status back. `audit.ipc.ts` reconciles on `AUDIT_GET_LATEST`
 * for exactly this reason; design mirrored the store but not the recovery.
 *
 * Mutates the returned run in place as well as persisting, because the caller
 * ships this object straight to the renderer.
 */
export function reconcileStaleDesignRun(
  run: AuditRun | null,
  workspaceId: string
): AuditRun | null {
  if (!run) return null
  if (run.status !== 'running' && run.status !== 'pending') return run
  if (designAgentService.isRunningForWorkspace(workspaceId)) return run

  log.warn(`[design] stale ${run.status} run detected (runId=${run.id}) — reconciling`)

  const results = run.results ?? []
  for (const result of results) {
    if (result.status === 'running' || result.status === 'pending') {
      auditRepository.updateResult(result.id, { status: 'cancelled' })
      result.status = 'cancelled'
    }
  }

  // A run that got some passes through is 'partial', not 'cancelled' — the
  // completed findings are still worth reading.
  const finalStatus = results.some((r) => r.status === 'completed') ? 'partial' : 'cancelled'
  const updated = auditRepository.updateRun(run.id, { status: finalStatus })
  if (updated) return updated

  run.status = finalStatus
  return run
}

/**
 * Reduce a model-suggested scope hint to a safe workspace-relative path, or
 * drop it.
 *
 * The hint reaches the renderer as a preselected scope and from there flows
 * back into `scope.paths` on the next `DESIGN_START`. Normalising it here keeps
 * every renderer-visible path under the same rule as a hand-picked one — a
 * model that answers `../../etc` must not be able to seed the picker with it.
 * A bad hint is dropped rather than rejected: routing is an assist, and losing
 * the hint costs the user one dropdown click.
 */
export function sanitizeScopeHint(hint: string | null): string | null {
  if (hint === null) return null
  try {
    return normalizeScopePath(hint, IPC_CHANNELS.DESIGN_ROUTE)
  } catch {
    log.warn(`[design:route] dropping unusable scopeHint ${JSON.stringify(hint)}`)
    return null
  }
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
    // Cancelling a run the service no longer knows about (app restarted mid-run)
    // would otherwise be a silent no-op that leaves the row 'running' forever.
    reconcileStaleDesignRun(
      auditRepository.getLatestForWorkspace(workspaceId, 'design'),
      workspaceId
    )
    log.info(`[design:cancel] workspaceId=${workspaceId}`)
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_ROUTE, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_ROUTE)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_ROUTE)
    const brief = requireString(obj, 'brief', IPC_CHANNELS.DESIGN_ROUTE)
    // Routing sends the brief to an LLM, so it is bounded on this path too.
    if (brief.length > MAX_BRIEF_CHARS) {
      throw new Error(
        `${IPC_CHANNELS.DESIGN_ROUTE}: brief is ${brief.length} characters (max ${MAX_BRIEF_CHARS})`
      )
    }

    // `route` never throws — a model failure is already a keyword fallback.
    const routed = await designRouteService.route({ workspaceId, brief })

    return ok<DesignRouteResult>({ ...routed, scopeHint: sanitizeScopeHint(routed.scopeHint) })
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_CONTEXT_STATUS, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_CONTEXT_STATUS)
    requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_CONTEXT_STATUS)
    return notImplemented('design:contextStatus')
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_SCOPE_TREE, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_SCOPE_TREE)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_SCOPE_TREE)

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) return fail(`Workspace ${workspaceId} not found`)
    if (!workspace.repoPath) return fail(`Workspace ${workspaceId} has no repo path`)

    // Uncapped deliberately: `MAX_DESIGN_FILES` is the budget a *run* can
    // review, and rolling only the first 100 paths up to directories would
    // under-count every directory and preselect the wrong default.
    const discovery = discoverDesignFiles(
      workspace.repoPath,
      { mode: 'project', paths: [] },
      { limit: Number.MAX_SAFE_INTEGER }
    )

    const counts = rollupScopeDirs(discovery.filePaths)
    const suggested = pickSuggestedDir(counts, discovery.totalFiles)

    const ranked = [...counts.entries()]
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path))

    const dirs = ranked.slice(0, MAX_SCOPE_TREE_DIRS)
    // The suggested directory is what the UI preselects, so it must be in the
    // list even in the pathological case where the cap would have cut it.
    if (suggested !== null && !dirs.some((d) => d.path === suggested)) {
      const row = ranked.find((d) => d.path === suggested)
      if (row) dirs.push(row)
    }

    return ok<DesignScopeTree>({
      dirs,
      totalFiles: discovery.totalFiles,
      suggested,
      truncated: ranked.length > MAX_SCOPE_TREE_DIRS
    })
  })

  ipcMain.handle(IPC_CHANNELS.DESIGN_GENERATE_REPORT, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GENERATE_REPORT)
    const runId = requireString(obj, 'runId', IPC_CHANNELS.DESIGN_GENERATE_REPORT)

    const { path, error } = await generateReportForRun(runId)
    if (!path) return fail(error ?? 'report generation failed')

    const run = auditRepository.findRunById(runId)
    const workspace = run ? workspaceRepository.findById(run.workspaceId) : null
    return ok({
      path: workspace?.repoPath ? displayPath(workspace.repoPath, path) : path
    })
  })

  // ── design:handoffToBlueprint — turn selected findings into one blueprint ──
  // Mirrors AUDIT_HANDOFF_TO_BLUEPRINT: findings are resolved from the
  // persisted run (never trusted from the renderer), the description is the
  // prefabricated remediation brief with impeccable command routing, and the
  // lineage rides in settingsJson so design-sourced builds can be detected.
  ipcMain.handle(
    IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT,
    async (
      _e,
      args: unknown
    ): Promise<DesignIpcResult<{ blueprintId: string; title: string; findingCount: number }>> => {
      const ch = IPC_CHANNELS.DESIGN_HANDOFF_TO_BLUEPRINT
      const obj = requireObject(args, ch)
      const workspaceId = requireString(obj, 'workspaceId', ch)
      const runId = requireString(obj, 'runId', ch)
      const findingIds = Array.isArray(obj.findingIds) ? obj.findingIds.map(String) : []

      const run = auditRepository.findRunById(runId)
      if (!run || run.workspaceId !== workspaceId || run.kind !== 'design') {
        return fail(`design run ${runId} not found for workspace ${workspaceId}`)
      }

      const wanted = new Set(findingIds)
      const findings: AuditFinding[] = run.results.flatMap((r) =>
        r.findings.filter((f) => wanted.has(f.id))
      )
      // Empty selection = hand off everything (the run's own verdict), capped.
      const selected = findings.length > 0 ? findings : run.results.flatMap((r) => r.findings)
      if (selected.length === 0) return fail(`run ${runId} has no findings to hand off`)
      if (selected.length > 50) {
        return fail(`too many findings (${selected.length}); select at most 50.`)
      }

      const commandIds = run.designConfig?.commandIds ?? []
      const scope = run.designConfig?.scope
      const scopeLabel =
        scope?.mode === 'paths' && scope.paths.length > 0 ? scope.paths.join(', ') : 'whole project'

      // Best effort: a fresh report travels with the lineage reference.
      await generateReportForRun(runId).catch(() => undefined)
      const reportPath = getReportPath(runId)

      const title = buildDesignBlueprintTitle(commandIds, scopeLabel)
      const blueprint = blueprintService.create({
        workspaceId,
        title,
        description: formatDesignRemediationBrief({
          brief: run.designConfig?.brief ?? '',
          commandIds,
          findings: selected,
          scopeLabel,
          runId
        }),
        priority: deriveBlueprintPriority(selected),
        settingsJson: {
          source: 'design',
          sourceDesignRunId: runId,
          commandIds,
          scope,
          ...(reportPath ? { reportPath } : {})
        }
      })

      auditHandoffRepository.record({
        auditRunId: runId,
        findingIds: selected.map((f) => f.id),
        target: 'blueprint',
        refId: blueprint.id,
        refTitle: title
      })

      const envelope: HandoffEnvelope = {
        id: randomUUID(),
        version: 1,
        source: 'design',
        target: 'blueprint',
        workspaceId,
        intent: `Remediate ${selected.length} design-audit finding(s) through the blueprint pipeline`,
        originalGoal: title,
        contextSummary: `Design audit findings from run ${runId}`,
        completedWork: [],
        remainingWork: selected.map((f) => ({
          title: f.title,
          description: f.description,
          priority:
            f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'high' : 'medium'
        })),
        decisions: [],
        constraints: [],
        risks: [],
        artifacts: [
          { type: 'finding', path: runId, description: `Design run ${runId}` },
          ...(reportPath
            ? [
                {
                  type: 'diff' as const,
                  path: reportPath,
                  description: 'Impeccable critique report'
                }
              ]
            : [])
        ],
        suggestedTools: [],
        suggestedSkills: [],
        filesToReadFirst: selected
          .filter((f) => f.filePath)
          .map((f) => f.filePath!)
          .slice(0, 10),
        commandsToRunFirst: [],
        sourceSessionId: runId,
        confidence: 0.8,
        priority: 'medium',
        createdAt: new Date().toISOString(),
        createdBy: 'user'
      }
      handoffRepository.create(envelope)

      log.info(
        `[design:handoff] Created blueprint ${blueprint.id} from ${selected.length} finding(s) of run ${runId}`
      )

      return ok({ blueprintId: blueprint.id, title, findingCount: selected.length })
    }
  )

  // ── Read paths (fully functional — they only need the kind discriminator) ──

  ipcMain.handle(IPC_CHANNELS.DESIGN_GET_LATEST, async (_e, args: unknown) => {
    const obj = requireObject(args, IPC_CHANNELS.DESIGN_GET_LATEST)
    const workspaceId = requireString(obj, 'workspaceId', IPC_CHANNELS.DESIGN_GET_LATEST)
    const run = auditRepository.getLatestForWorkspace(workspaceId, 'design')
    return ok<AuditRun | null>(reconcileStaleDesignRun(run, workspaceId))
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

  // Safety net, matching audit/council (90 min) and grill (60 min). The
  // `try/finally` around `runDesign` (P3.7.5) means `complete` fires even on a
  // throw, so this should never trigger — but design was the one module without
  // it, and if that guarantee ever breaks five listeners leak per run for the
  // life of the process.
  designCleanup.scheduleAutoCleanup(workspaceId, cleanups, 90 * 60_000)

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

      // P6.2 — auto-write the .impeccable/critique report on completion. Best
      // effort: the report is regenerable via DESIGN_GENERATE_REPORT, so a
      // write failure degrades to a warn, never a failed run.
      if (finalStatus !== 'cancelled') {
        void generateReportForRun(runId).catch((err) =>
          log.warn('[design:complete] report write failed:', err)
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

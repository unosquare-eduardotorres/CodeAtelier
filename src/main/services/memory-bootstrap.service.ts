/**
 * memory-bootstrap.service.ts — orchestrates project knowledge ingestion.
 *
 * Two modes:
 *   1. "Feed Brain" (full/incremental): deterministic pipeline
 *      Preflight → Docs → Stack → Architecture → History → Structure → Finalize
 *   2. "Deep Scan" (deep-scan): the same, with agent-driven exploration
 *      replacing the Structure phase
 *
 * Structurally this is a **plan-then-drain** job, not a linear script:
 *
 *   PLAN   cheap, no LLM calls — discovery writes one durable row per unit of
 *          work, so the item total is known before extraction starts.
 *   DRAIN  a worker pool claims rows, extracts, and records per-chunk progress.
 *          Pausing releases the current row with its chunk offset intact;
 *          resuming (even after an app restart) picks up exactly there.
 *
 * That split is what makes progress honest, pause/resume lossless, and
 * background runs observable. Discovery lives in ./memory-bootstrap/planner,
 * per-kind execution in ./memory-bootstrap/executors, the loop in
 * ./memory-bootstrap/worker.
 *
 * Every fact is tagged ['bootstrap', <phase>]; the write pipeline's
 * cosine-dedup makes re-runs confirm rather than duplicate.
 *
 * Singleton: memoryBootstrapService
 */

import log from 'electron-log'
import type {
  BootstrapItemStatus,
  BootstrapItemView,
  BootstrapMode,
  BootstrapPhaseLabel,
  BootstrapProgress,
  BootstrapRunSummary,
  BootstrapScope
} from '../../shared/types'
import { memoryEngineService } from './memory-engine.service'
import { memoryBootstrapRepository } from '../db/repositories/memory-bootstrap.repository'
import { codeGraphService } from './code-graph.service'
import { localEmbeddingProvider } from './local-embedding.provider'
import { memoryProjectionService } from './memory-projection.service'
import { workspaceRepository } from '../db/repositories'
import {
  DEEP_SCAN_PHASES,
  DEFAULT_BOOTSTRAP_CONCURRENCY,
  FULL_PHASES,
  MAX_BOOTSTRAP_CONCURRENCY,
  MIN_BOOTSTRAP_CONCURRENCY
} from './memory-bootstrap/constants'
import { readHeadSha } from './memory-bootstrap/discovery'
import { planRun } from './memory-bootstrap/planner'
import { drainRun } from './memory-bootstrap/worker'

const bsLog = log.scope('memory-bootstrap')

export type BootstrapProgressCallback = (progress: BootstrapProgress) => void

/** In-memory handle for a run that this process is actively driving. */
interface ActiveRun {
  jobId: string
  runId: string
  workspaceId: string
  workspacePath: string
  mode: BootstrapMode
  scope: BootstrapScope
  controller: AbortController
  paused: boolean
  onProgress?: BootstrapProgressCallback
}

export interface StartBootstrapResult {
  jobId: string
  runId: string
  factsCreated: number
}

class MemoryBootstrapService {
  /** Keyed by workspaceId — one run per workspace, many workspaces at once. */
  private active = new Map<string, ActiveRun>()
  private jobCounter = 0
  /** Last progress event per workspace, so the UI can re-attach after nav. */
  private lastProgress = new Map<string, BootstrapProgress>()

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Start a new ingestion run: preflight → plan → drain → finalize.
   *
   * @param force Legacy flag. `true` is equivalent to `scope: 'full'`.
   * @param scope Which phases ignore the doc-state hash gate.
   */
  async startBootstrap(
    workspaceId: string,
    workspacePath: string,
    mode: BootstrapMode = 'full',
    onProgress?: BootstrapProgressCallback,
    force = false,
    scope?: BootstrapScope
  ): Promise<StartBootstrapResult> {
    if (this.active.has(workspaceId)) {
      throw new Error('A bootstrap job is already running for this workspace')
    }

    const effectiveScope: BootstrapScope = scope ?? (force ? 'full' : 'changed')
    const runId = memoryBootstrapRepository.createRun({
      workspaceId,
      mode,
      scope: effectiveScope
    })

    return this.driveRun({
      runId,
      workspaceId,
      workspacePath,
      mode,
      scope: effectiveScope,
      onProgress,
      plan: true
    })
  }

  /**
   * Resume a paused (or crash-orphaned) run without re-planning.
   *
   * The queue already knows what is left, including how far into the current
   * file the last attempt got, so this is genuinely "continue" rather than
   * "start again and skip the fast bits".
   */
  async resumeRun(
    runId: string,
    workspacePath: string,
    onProgress?: BootstrapProgressCallback
  ): Promise<StartBootstrapResult> {
    const run = memoryBootstrapRepository.getRun(runId)
    if (!run) throw new Error(`Bootstrap run ${runId} not found`)
    if (this.active.has(run.workspaceId)) {
      throw new Error('A bootstrap job is already running for this workspace')
    }

    return this.driveRun({
      runId,
      workspaceId: run.workspaceId,
      workspacePath,
      mode: run.mode,
      scope: run.scope,
      onProgress,
      plan: false
    })
  }

  /**
   * Pause the run for a workspace.
   *
   * Takes effect at the next chunk boundary. Deep Scan's agent step is an
   * external CLI process and cannot be interrupted mid-flight, so a pause
   * requested during agent exploration lands when that step returns.
   */
  pause(workspaceId: string): boolean {
    const run = this.active.get(workspaceId)
    if (!run || run.paused) return false
    run.paused = true
    bsLog.info(`[pause] Run ${run.runId} pausing at next safe boundary`)
    return true
  }

  /** Cancel by jobId (legacy) — returns false when the job is not active. */
  cancel(jobId: string): boolean {
    for (const run of this.active.values()) {
      if (run.jobId === jobId || run.workspaceId === jobId || run.runId === jobId) {
        run.controller.abort()
        bsLog.info(`[cancel] Job ${run.jobId} cancelled`)
        return true
      }
    }
    return false
  }

  cancelAll(): void {
    for (const run of this.active.values()) {
      run.controller.abort()
    }
    if (this.active.size > 0) bsLog.info('[cancelAll] Active jobs cancelled')
  }

  /** True while any workspace has a run in flight. */
  get isRunning(): boolean {
    return this.active.size > 0
  }

  isRunningFor(workspaceId: string): boolean {
    return this.active.has(workspaceId)
  }

  /**
   * Everything the UI needs to render this workspace's ingestion state without
   * having been subscribed while the run started.
   */
  getSnapshot(workspaceId: string): {
    progress: BootstrapProgress | null
    latestRun: BootstrapRunSummary | null
    resumableRunId: string | null
  } {
    const latestRun = memoryBootstrapRepository.getLatestRun(workspaceId) ?? null
    const resumable = memoryBootstrapRepository
      .findResumableRuns(workspaceId)
      .find((r) => memoryBootstrapRepository.countPending(r.id) > 0)

    // `lastProgress` is never pruned, so a finished run's finished event would
    // be replayed on every page visit — keeping the live progress panel on
    // screen and hiding LastRunSummary until the app restarted. Only in-flight
    // state (including `paused`, which is still actionable) belongs here; the
    // run row behind `latestRun` is the record of what already happened.
    const live = this.lastProgress.get(workspaceId) ?? null
    const isTerminal =
      live !== null &&
      (live.jobStatus === 'done' || live.jobStatus === 'cancelled' || live.jobStatus === 'error')

    return {
      progress: isTerminal ? null : live,
      latestRun,
      resumableRunId: resumable?.id ?? null
    }
  }

  listRuns(workspaceId: string, limit = 10): BootstrapRunSummary[] {
    return memoryBootstrapRepository.listRuns(workspaceId, limit)
  }

  listItems(
    runId: string,
    options: {
      status?: BootstrapItemStatus
      phase?: BootstrapPhaseLabel
      limit?: number
      offset?: number
    } = {}
  ): { items: BootstrapItemView[]; total: number } {
    return memoryBootstrapRepository.listItems(runId, options)
  }

  /**
   * Boot-time recovery. Runs marked `running` with no process behind them are
   * demoted to `paused` so the user is offered a resume instead of being
   * blocked by a zombie.
   */
  recoverOrphanedRuns(): number {
    try {
      const n = memoryBootstrapRepository.markOrphanedRunsPaused()
      if (n > 0) bsLog.info(`[recoverOrphanedRuns] Marked ${n} orphaned run(s) paused`)
      return n
    } catch (err) {
      bsLog.warn('[recoverOrphanedRuns] Failed:', err)
      return 0
    }
  }

  // ── Run driver ────────────────────────────────────────────────────────

  private async driveRun(params: {
    runId: string
    workspaceId: string
    workspacePath: string
    mode: BootstrapMode
    scope: BootstrapScope
    onProgress?: BootstrapProgressCallback
    plan: boolean
  }): Promise<StartBootstrapResult> {
    const { runId, workspaceId, workspacePath, mode, scope, plan } = params
    const jobId = `bootstrap-${++this.jobCounter}-${Date.now()}`
    const controller = new AbortController()
    const phases = mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES

    const activeRun: ActiveRun = {
      jobId,
      runId,
      workspaceId,
      workspacePath,
      mode,
      scope,
      controller,
      paused: false,
      onProgress: params.onProgress
    }
    this.active.set(workspaceId, activeRun)

    const emit = (
      phaseLabel: BootstrapPhaseLabel,
      message: string,
      jobStatus: BootstrapProgress['jobStatus']
    ): void => {
      const summary = memoryBootstrapRepository.getRun(runId)
      const progress: BootstrapProgress = {
        jobId,
        runId,
        workspaceId,
        phaseIndex: Math.max(0, phases.indexOf(phaseLabel)),
        phaseCount: phases.length,
        phaseLabel,
        factsCreated: summary?.factsCreated ?? 0,
        message,
        jobStatus,
        mode,
        itemsTotal: summary?.itemsTotal ?? 0,
        itemsDone: summary?.itemsDone ?? 0,
        itemsSkipped: summary?.itemsSkipped ?? 0,
        itemsFailed: summary?.itemsFailed ?? 0,
        currentItem: null,
        perPhase: summary?.perPhase ?? {},
        etaSeconds: null,
        itemsPerMinute: null
      }
      this.publish(progress)
    }

    // Relax the dedup threshold for agent-recorded ('tool') facts for the
    // duration of this job — see MemoryEngineService.setBootstrapActive.
    memoryEngineService.setBootstrapActive(true)

    try {
      // ── Preflight ──
      memoryBootstrapRepository.updateRun(runId, {
        status: 'planning',
        currentPhase: 'preflight',
        error: null,
        finishedAt: null
      })
      emit('preflight', 'Checking prerequisites…', 'planning')
      const preflight = await this.phasePreflight(workspaceId, workspacePath, mode)

      if (controller.signal.aborted) return this.finishCancelled(runId, jobId, emit)

      // ── Plan ──
      if (plan) {
        emit('preflight', 'Planning work…', 'planning')
        const { items, prefiltered } = await planRun({
          workspaceId,
          workspacePath,
          mode,
          scope,
          hasIndex: preflight.hasIndex,
          lastCommit: preflight.lastCommit,
          headSha: preflight.headSha
        })
        memoryBootstrapRepository.planItems(runId, workspaceId, items)
        memoryBootstrapRepository.updateRun(runId, { itemsTotal: items.length })
        emit(
          'preflight',
          `Planned ${items.length} items` +
            (prefiltered.tooSmall + prefiltered.generated + prefiltered.duplicate > 0
              ? ` (skipped ${prefiltered.tooSmall} tiny, ${prefiltered.generated} generated, ${prefiltered.duplicate} duplicate)`
              : ''),
          'planning'
        )
      }

      if (controller.signal.aborted) return this.finishCancelled(runId, jobId, emit)

      // ── Drain ──
      memoryBootstrapRepository.updateRun(runId, { status: 'running' })
      const outcome = await drainRun({
        runId,
        jobId,
        workspaceId,
        workspacePath,
        mode,
        scope,
        concurrency: this.resolveConcurrency(workspaceId),
        signal: controller.signal,
        lastCommit: preflight.lastCommit,
        isPaused: () => activeRun.paused,
        onProgress: (p) => this.publish(p)
      })

      if (outcome === 'cancelled') return this.finishCancelled(runId, jobId, emit)

      // A pause that lands in the same tick the queue drained leaves nothing to
      // resume. Parking the run as `paused` there would skip finalize (no
      // embedding backfill, no incremental commit marker) and getSnapshot would
      // not offer a resume either, because it requires pending items — the run
      // would be stranded and the next incremental run would re-mine everything.
      const remaining = memoryBootstrapRepository.countPending(runId)
      if (outcome === 'paused' && remaining > 0) {
        memoryBootstrapRepository.updateRun(runId, { status: 'paused' })
        const summary = memoryBootstrapRepository.getRun(runId)
        emit(
          summary?.currentPhase ?? 'docs',
          `Paused — ${remaining} items remaining`,
          'paused'
        )
        return { jobId, runId, factsCreated: summary?.factsCreated ?? 0 }
      }

      // ── Finalize ──
      emit('finalize', 'Finalizing…', 'running')
      await this.phaseFinalize(workspaceId, workspacePath)

      memoryBootstrapRepository.updateRun(runId, {
        status: 'completed',
        currentPhase: 'finalize',
        finishedAt: new Date().toISOString()
      })
      const summary = memoryBootstrapRepository.getRun(runId)
      const facts = summary?.factsCreated ?? 0
      emit('finalize', `Complete — ${facts} memories created`, 'done')

      bsLog.info(`[driveRun] Run ${runId} complete: ${facts} facts (mode=${mode})`)
      return { jobId, runId, factsCreated: facts }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      bsLog.error(`[driveRun] Run ${runId} failed:`, err)
      memoryBootstrapRepository.updateRun(runId, {
        status: 'failed',
        error: msg,
        finishedAt: new Date().toISOString()
      })
      emit('finalize', `Error: ${msg}`, 'error')
      const summary = memoryBootstrapRepository.getRun(runId)
      return { jobId, runId, factsCreated: summary?.factsCreated ?? 0 }
    } finally {
      memoryEngineService.setBootstrapActive(false)
      this.active.delete(workspaceId)
    }
  }

  private finishCancelled(
    runId: string,
    jobId: string,
    emit: (
      phaseLabel: BootstrapPhaseLabel,
      message: string,
      jobStatus: BootstrapProgress['jobStatus']
    ) => void
  ): StartBootstrapResult {
    memoryBootstrapRepository.updateRun(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString()
    })
    const summary = memoryBootstrapRepository.getRun(runId)
    const remaining = memoryBootstrapRepository.countPending(runId)
    emit(
      summary?.currentPhase ?? 'preflight',
      `Cancelled — ${remaining} items not processed`,
      'cancelled'
    )
    return { jobId, runId, factsCreated: summary?.factsCreated ?? 0 }
  }

  private publish(progress: BootstrapProgress): void {
    this.lastProgress.set(progress.workspaceId, progress)
    const run = this.active.get(progress.workspaceId)
    run?.onProgress?.(progress)
  }

  /**
   * Documents extracted in parallel. Each one is a Claude CLI spawn, so this
   * is the single biggest throughput lever — and the one most likely to hit an
   * API rate limit, which is why it is user-tunable.
   */
  private resolveConcurrency(workspaceId: string): number {
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      const raw = Number(settings.memoryBootstrapConcurrency)
      if (Number.isFinite(raw) && raw >= MIN_BOOTSTRAP_CONCURRENCY) {
        return Math.min(MAX_BOOTSTRAP_CONCURRENCY, Math.floor(raw))
      }
    } catch { /* fall through to default */ }
    return DEFAULT_BOOTSTRAP_CONCURRENCY
  }

  // ── Preflight / Finalize ──────────────────────────────────────────────

  private async phasePreflight(
    workspaceId: string,
    workspacePath: string,
    mode: BootstrapMode
  ): Promise<{ hasIndex: boolean; lastCommit: string | null; headSha: string | null }> {
    if (!codeGraphService.hasPersistedIndex(workspaceId)) {
      bsLog.info('[preflight] No code-graph index — attempting to build one')
      try {
        await codeGraphService.indexWorkspace(workspaceId, workspacePath)
        bsLog.info('[preflight] Code-graph index built successfully')
      } catch (err) {
        bsLog.warn('[preflight] Code-graph indexing failed — architecture phase will be limited:', err)
      }
    }

    // Kick embedding provider readiness (non-blocking)
    localEmbeddingProvider.ensureEmbeddingReady().catch(() => {
      bsLog.info('[preflight] Embedding provider not ready — facts will be embeddingPending')
    })

    const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
    const lastCommit = (settings.memoryBootstrapLastCommit as string) ?? null
    const headSha = readHeadSha(workspacePath)

    if (mode === 'incremental' && lastCommit && headSha && lastCommit === headSha) {
      bsLog.info('[preflight] HEAD unchanged since last bootstrap — incremental run will be minimal')
    }

    return {
      hasIndex: codeGraphService.hasPersistedIndex(workspaceId),
      lastCommit,
      headSha
    }
  }

  private async phaseFinalize(workspaceId: string, workspacePath: string): Promise<void> {
    try {
      await memoryEngineService.backfillAllPendingEmbeddings()
    } catch (err) {
      bsLog.warn('[phaseFinalize] Embedding backfill failed:', err)
    }

    try {
      const current = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      workspaceRepository.updateSettings(workspaceId, {
        ...current,
        memoryBootstrapLastCommit: readHeadSha(workspacePath),
        memoryBootstrapLastRunAt: new Date().toISOString()
      })
    } catch (err) {
      bsLog.warn('[phaseFinalize] Failed to save incremental markers:', err)
    }

    // Project the database to markdown so the run's output is reviewable in a
    // diff rather than only visible through the app.
    //
    // Opt-in. This writes files into the user's repository, and doing that
    // unasked leaves untracked `.agentstudio/memory/*.md` in their working
    // tree — which also feeds back into `resolveActivePaths` via
    // `git status --porcelain`. Users who want the diff turn it on.
    if (this.isProjectionEnabled(workspaceId)) {
      try {
        const result = memoryProjectionService.project(workspaceId, workspacePath)
        bsLog.info(
          `[phaseFinalize] Projected ${result.factsProjected} fact(s) to ${result.indexPath}`
        )
      } catch (err) {
        bsLog.warn('[phaseFinalize] Memory projection failed:', err)
      }
    }
  }

  /** Whether this workspace has opted in to writing `.agentstudio/memory/`. */
  private isProjectionEnabled(workspaceId: string): boolean {
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      return settings?.memoryProjectionEnabled === true
    } catch {
      return false
    }
  }
}

export const memoryBootstrapService = new MemoryBootstrapService()

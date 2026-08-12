/**
 * Worker — drains a planned run's item queue.
 *
 * Mirrors the pause/resume shape already proven by the code indexer
 * (`vectorSearchService.pauseIndexing` + `while (paused && !cancelled) sleep`),
 * so the two long-running background jobs in the app behave identically.
 *
 * Invariants:
 *  - Every state change lands in SQLite before it is emitted to the UI, so a
 *    crash never leaves the renderer showing progress the database disagrees with.
 *  - Pausing releases the in-flight item back to `pending` with its chunk
 *    offset intact. Nothing already extracted is thrown away.
 */

import log from 'electron-log'
import type {
  BootstrapMode,
  BootstrapPhaseLabel,
  BootstrapProgress,
  BootstrapScope
} from '../../../shared/types'
import { memoryBootstrapRepository } from '../../db/repositories/memory-bootstrap.repository'
import { DEEP_SCAN_PHASES, FULL_PHASES } from './constants'
import { executeItem } from './executors'

const wLog = log.scope('memory-bootstrap:worker')

/** Kinds that must not run alongside anything else. */
const BARRIER_KINDS = new Set(['agent'])

export interface DrainOptions {
  runId: string
  jobId: string
  workspaceId: string
  workspacePath: string
  mode: BootstrapMode
  scope: BootstrapScope
  concurrency: number
  signal: AbortSignal
  lastCommit: string | null
  isPaused: () => boolean
  onProgress: (progress: BootstrapProgress) => void
}

export type DrainOutcome = 'completed' | 'paused' | 'cancelled'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Rolling throughput estimate.
 *
 * Only items that actually did work feed the average — hash-gated skips
 * resolve in microseconds and would otherwise crush the ETA to nonsense.
 *
 * The same distinction has to be carried into both headline numbers, because
 * a re-run is mostly skips: counting them as completions inflates the rate
 * (410 items ÷ the elapsed time of the 10 that really ran), and charging each
 * one a full EMA inflates the ETA. Both are projected through the observed
 * ratio of real work to settled items instead.
 *
 * The rate is measured against wall-clock time, not summed item durations:
 * with a pool of N workers those durations overlap, so dividing by them would
 * under-report the throughput N-fold and contradict the ETA displayed beside it.
 *
 * Exported for tests — nothing outside this module constructs one.
 */
export class Throughput {
  private emaMs: number | null = null
  /** Wall-clock start of this drain session — the rate's only honest denominator. */
  private readonly startedAt: number
  /** Injectable so the wall-clock rate can be asserted without real time passing. */
  private readonly now: () => number
  /** Items that actually did work (not instant hash-gated skips). */
  private worked = 0
  /** Every item that left the queue, worked or skipped. */
  private settled = 0
  /** Active time carried over from an earlier session of this run. */
  private carriedMs = 0
  /** Active time accumulated in this process. */
  private sessionMs = 0

  constructor(now: () => number = Date.now) {
    this.now = now
    this.startedAt = now()
  }

  /** Seed the run's total elapsed time without polluting the rate estimate. */
  carry(ms: number): void {
    this.carriedMs += ms
  }

  record(durationMs: number): void {
    this.settled++
    this.sessionMs += durationMs
    if (durationMs < 100) return
    this.worked++
    this.emaMs = this.emaMs === null ? durationMs : this.emaMs * 0.7 + durationMs * 0.3
  }

  get totalActiveMs(): number {
    return this.carriedMs + this.sessionMs
  }

  etaSeconds(remaining: number, concurrency: number): number | null {
    if (this.emaMs === null || remaining <= 0 || this.settled === 0) return null
    const expectedWork = remaining * (this.worked / this.settled)
    return Math.round((this.emaMs * expectedWork) / Math.max(1, concurrency) / 1000)
  }

  itemsPerMinute(): number | null {
    const wallMs = this.now() - this.startedAt
    if (wallMs < 5000 || this.worked === 0) return null
    return Math.round((this.worked / (wallMs / 60_000)) * 10) / 10
  }
}

export async function drainRun(opts: DrainOptions): Promise<DrainOutcome> {
  const phases: BootstrapPhaseLabel[] = opts.mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES
  const repo = memoryBootstrapRepository
  const throughput = new Throughput()

  const existing = repo.getRun(opts.runId)
  if (existing) throughput.carry(existing.activeMs)

  let currentItemLabel: BootstrapProgress['currentItem'] = null
  let message = 'Starting…'
  let activeWorkers = 0
  let outcome: DrainOutcome = 'completed'

  // Chunk callbacks can fire dozens of times per second on a big markdown
  // file; each emit costs a run read plus a GROUP BY over the item table.
  // Throttle the cosmetic updates and force the ones that change state.
  const EMIT_INTERVAL_MS = 250
  let lastEmitAt = 0

  const emit = (jobStatus: BootstrapProgress['jobStatus'] = 'running', force = true): void => {
    const now = Date.now()
    if (!force && now - lastEmitAt < EMIT_INTERVAL_MS) return
    lastEmitAt = now

    const summary = repo.getRun(opts.runId)
    if (!summary) return

    const phaseLabel = summary.currentPhase ?? 'preflight'
    const remaining =
      summary.itemsTotal - (summary.itemsDone + summary.itemsSkipped + summary.itemsFailed)

    opts.onProgress({
      jobId: opts.jobId,
      runId: opts.runId,
      workspaceId: opts.workspaceId,
      phaseIndex: Math.max(0, phases.indexOf(phaseLabel)),
      phaseCount: phases.length,
      phaseLabel,
      factsCreated: summary.factsCreated,
      message,
      jobStatus,
      mode: opts.mode,
      itemsTotal: summary.itemsTotal,
      itemsDone: summary.itemsDone,
      itemsSkipped: summary.itemsSkipped,
      itemsFailed: summary.itemsFailed,
      currentItem: currentItemLabel,
      perPhase: summary.perPhase,
      etaSeconds: throughput.etaSeconds(remaining, opts.concurrency),
      itemsPerMinute: throughput.itemsPerMinute()
    })
  }

  /** One pool slot: claim → execute → persist, until the queue is empty. */
  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal.aborted) {
        outcome = 'cancelled'
        return
      }
      if (opts.isPaused()) {
        outcome = 'paused'
        return
      }

      // Barrier kinds wait for the pool to quiesce before starting.
      if (activeWorkers > 0 && BARRIER_KINDS.has(repo.peekNextItemKind(opts.runId) ?? '')) {
        await sleep(300)
        continue
      }

      const item = repo.claimNextItem(opts.runId)
      if (!item) return // queue drained

      activeWorkers++
      const startedAt = Date.now()
      repo.updateRun(opts.runId, { currentPhase: item.phase })
      currentItemLabel = {
        sourceRef: item.sourceRef,
        phase: item.phase,
        chunkDone: item.chunkDone,
        chunkTotal: item.chunkTotal,
        factsCreated: item.factsCreated
      }
      message = `${item.sourceRef}`
      emit()

      try {
        const result = await executeItem({
          workspaceId: opts.workspaceId,
          workspacePath: opts.workspacePath,
          scope: opts.scope,
          signal: opts.signal,
          item,
          lastCommit: opts.lastCommit,
          isPaused: opts.isPaused,
          onChunk: (chunkDone, chunkTotal, facts) => {
            repo.updateItem(item.id, { chunkTotal })
            repo.bumpChunkDone(item.id, chunkDone, facts)
            currentItemLabel = {
              sourceRef: item.sourceRef,
              phase: item.phase,
              chunkDone,
              chunkTotal,
              factsCreated: facts
            }
            message = `${item.sourceRef} — chunk ${chunkDone}/${chunkTotal}`
            emit('running', false)
          },
          onHashChanged: (contentHash) => {
            // A stale offset belongs to different text — clear it in the same
            // write that records the hash it was measured against.
            repo.updateItem(item.id, { contentHash, chunkDone: 0 })
          },
          onMessage: (msg) => {
            message = msg
            emit('running', false)
          }
        })

        if (result.status === 'pending') {
          // Stopped at a safe boundary (pause or cancel). Chunk offset and
          // partial fact count are already persisted; put it back in the queue.
          repo.updateItem(item.id, {
            status: 'pending',
            factsCreated: result.facts
          })
        } else {
          repo.updateItem(item.id, {
            status: result.status,
            factsCreated: result.facts,
            error: result.error ?? null
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        wLog.warn(`[drainRun] Item ${item.sourceRef} threw:`, err)
        repo.updateItem(item.id, { status: 'failed', error: msg })
      } finally {
        activeWorkers--
        throughput.record(Date.now() - startedAt)
        repo.syncRunCounters(opts.runId)
        repo.updateRun(opts.runId, { activeMs: throughput.totalActiveMs })
        currentItemLabel = null
        emit()
      }
    }
  }

  const pool = Array.from({ length: Math.max(1, opts.concurrency) }, () => runWorker())
  await Promise.all(pool)

  if (opts.signal.aborted) outcome = 'cancelled'
  else if (opts.isPaused()) outcome = 'paused'

  return outcome
}

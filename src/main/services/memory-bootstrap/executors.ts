/**
 * Phase executors — one per item kind.
 *
 * Every executor takes a single queued item and returns how many facts it
 * produced plus a terminal status. None of them know about the queue, pausing
 * or progress reporting; that is the worker's job.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative } from 'node:path'
import log from 'electron-log'
import type { BootstrapItemStatus, BootstrapItemView, BootstrapScope } from '../../../shared/types'
import { memoryExtractionService } from '../memory-extraction.service'
import type { ExtractContentOptions } from '../memory-extraction.service'
import { memoryEngineService } from '../memory-engine.service'
import { memoryFactRepository } from '../../db/repositories/memory-fact.repository'
import { codeGraphService } from '../code-graph.service'
import { readDocument } from '../document-reader'
import { chunkDocument, detectStrategy } from '../document-chunker'
import { runAgenticClaude } from '../agentic-claude-runner'
import { classifyInstructionPath, instructionScopePaths } from '../instruction-sources.service'
import { MCP_TOOLS } from '../../../shared/constants'
import {
  MAX_CHUNKS_PER_FILE,
  MAX_COCHANGE_RESULTS,
  MAX_COMMIT_SUBJECTS,
  MAX_HOTSPOT_FACTS
} from './constants'
import { collectManifests, estimateProjectComplexity } from './discovery'
import { buildDeepScanPrompt, computeAgentBudget } from './prompt'
import { shouldHonourHashGate } from './planner'

const exLog = log.scope('memory-bootstrap:exec')

export interface ExecContext {
  workspaceId: string
  workspacePath: string
  scope: BootstrapScope
  signal: AbortSignal
  item: BootstrapItemView
  lastCommit: string | null
  /** True while the run is paused — executors stop at the next safe boundary. */
  isPaused: () => boolean
  /**
   * Called after each chunk so the queue records partial progress. A pause or
   * a crash then resumes inside the file rather than re-reading it.
   */
  onChunk: (chunkDone: number, chunkTotal: number, facts: number) => void
  /**
   * Called once, before any chunk runs, with the hash of the content this
   * attempt is about to process — but only when it differs from what the item
   * already recorded. The queue persists it and drops any stale chunk offset,
   * because an offset recorded against different text points at the wrong
   * chunk. Without this the item's hash stays null forever and the resume
   * guard below can never fire.
   */
  onHashChanged: (contentHash: string) => void
  onMessage: (msg: string) => void
}

export interface ExecResult {
  facts: number
  status: BootstrapItemStatus
  error?: string
}

/**
 * Every bootstrap extraction runs under the run's cancel signal and reports the
 * extractor's own status. Centralised because a call site that forgets the
 * signal keeps retrying — and keeps spending the user's tokens — for ~14s after
 * they hit Cancel, and a call site that forgets onProgress makes a rate-limit
 * backoff look like a freeze.
 */
function runExtraction(
  ctx: ExecContext,
  sourceRef: string,
  content: string,
  opts: Omit<ExtractContentOptions, 'signal'>
): Promise<number> {
  return memoryExtractionService.extractFromContent(
    ctx.workspaceId,
    ctx.workspacePath,
    sourceRef,
    content,
    (p) => ctx.onMessage(p.message),
    { ...opts, signal: ctx.signal }
  )
}

// ── Docs / architecture files ───────────────────────────────────────────────

/**
 * Extract facts from a single file, chunk by chunk, resuming from
 * `item.chunkDone`.
 *
 * The doc-state hash is written only when every chunk of the file completed
 * cleanly. Writing it after a partial run would permanently lock the file out
 * of future scans, because the hash would match and the next run would return
 * early.
 */
async function executeFile(ctx: ExecContext, tag: string): Promise<ExecResult> {
  const { item, workspaceId, workspacePath } = ctx
  const absPath = join(workspacePath, item.sourceRef)

  const readResult = await readDocument(absPath)
  if (!readResult.ok || readResult.isImage) {
    return { facts: 0, status: 'skipped', error: 'unreadable or binary' }
  }

  const contentHash = createHash('sha256').update(readResult.content).digest('hex')

  // Hash gate — honoured unless this run's scope explicitly re-ingests the phase.
  if (shouldHonourHashGate(ctx.scope, item.phase)) {
    const existing = memoryFactRepository.getDocState(workspaceId, absPath)
    if (existing && existing.contentHash === contentHash) {
      return { facts: 0, status: 'skipped' }
    }
  }

  const strategy = detectStrategy(absPath)
  const relPath = relative(workspacePath, absPath)
  const chunks = chunkDocument(readResult.content, strategy, relPath).slice(0, MAX_CHUNKS_PER_FILE)
  if (chunks.length === 0) return { facts: 0, status: 'skipped' }

  // Agent rule files (AGENTS.md, .cursor/rules/*.mdc, copilot-instructions.md,
  // .clinerules, .windsurfrules) were written to tell an agent how this project
  // works, so they are recorded as instructions rather than generic prose — and
  // their frontmatter already declares which paths they govern, which is a far
  // better scope than the file's own path.
  const instructionFormat = classifyInstructionPath(relPath)

  // A document states what was true when it was last written, which on a
  // 15-year-old repository is very often not today. Recency scoring reads this.
  const observedAt = fileObservedAt(absPath)

  const extractOpts: Omit<ExtractContentOptions, 'signal'> = instructionFormat
    ? {
        sourceType: 'claude-md',
        tags: ['bootstrap', 'instructions', instructionFormat],
        scopePaths: instructionScopePaths(workspacePath, absPath, readResult.content),
        observedAt
      }
    : {
        sourceType: 'bootstrap',
        tags: ['bootstrap', tag],
        observedAt
      }

  // Resume mid-file only when the content is byte-identical to what produced
  // the recorded chunk offset. If the file changed under us, the old offset
  // points at different text — start over.
  const resumable = item.chunkDone > 0 && item.contentHash === contentHash
  const startChunk = resumable ? Math.min(item.chunkDone, chunks.length) : 0
  let facts = resumable ? item.factsCreated : 0

  // First attempt at this item, or the file changed since the offset was
  // recorded. Either way the queue needs the current hash so a later resume
  // has something truthful to compare against.
  if (item.contentHash !== contentHash) {
    ctx.onHashChanged(contentHash)
  }
  let chunkErrors = 0
  let stopped = false

  for (let i = startChunk; i < chunks.length; i++) {
    if (ctx.signal.aborted || ctx.isPaused()) {
      stopped = true
      break
    }

    const chunk = chunks[i]
    try {
      const contentWithContext = chunk.breadcrumb
        ? `[Context: ${chunk.breadcrumb}]\n\n${chunk.content}`
        : chunk.content

      // A rate-limit backoff can hold a chunk for ~14s. runExtraction forwards
      // the extractor's own status, so the panel says why rather than freezing
      // on "chunk 3/12". The file name is already on the item line.
      facts += await runExtraction(ctx, relPath, contentWithContext, extractOpts)
    } catch (err) {
      chunkErrors++
      exLog.warn(`[executeFile] Chunk ${i} failed for ${relPath}:`, err)
    }

    ctx.onChunk(i + 1, chunks.length, facts)
  }

  if (stopped) {
    // Not a failure — the item goes back to the queue with its chunk offset
    // intact. The worker decides whether that means paused or cancelled.
    return { facts, status: 'pending' }
  }

  if (chunkErrors === 0) {
    memoryFactRepository.upsertDocState(workspaceId, absPath, contentHash)
    return { facts, status: 'done' }
  }

  return {
    facts,
    status: 'failed',
    error: `${chunkErrors}/${chunks.length} chunks failed`
  }
}

// ── Stack ───────────────────────────────────────────────────────────────────

async function executeManifests(ctx: ExecContext): Promise<ExecResult> {
  const content = collectManifests(ctx.workspacePath)
  if (!content || content.length < 20) {
    return { facts: 0, status: 'skipped', error: 'no manifest files found' }
  }

  const facts = await runExtraction(ctx, 'project-manifests', content, {
    sourceType: 'bootstrap',
    tags: ['bootstrap', 'stack']
  })
  return { facts, status: 'done' }
}

// ── History ─────────────────────────────────────────────────────────────────

async function executeHotspots(ctx: ExecContext): Promise<ExecResult> {
  const hotspots = codeGraphService.findHotspots(ctx.workspaceId, ctx.workspacePath, {
    maxResults: MAX_HOTSPOT_FACTS
  })
  if (hotspots.length === 0) return { facts: 0, status: 'skipped' }

  const hotspotList = hotspots
    .map(
      (h) => `${h.file} (refs=${h.referenceCount}, churn=${h.gitChurn}, score=${h.hotspotScore})`
    )
    .join('\n  ')

  const written = await memoryEngineService.writeFact({
    workspaceId: ctx.workspaceId,
    category: 'reference',
    title: 'High-risk hotspots (churn × coupling)',
    content: `These files have the highest combined reference count and git churn, making them risky to modify:\n  ${hotspotList}`,
    tags: ['bootstrap', 'history', 'hotspots'],
    scopePaths: hotspots.map((h) => h.file),
    sourceType: 'bootstrap',
    sourceRef: 'bootstrap:history',
    workspacePath: ctx.workspacePath
  })
  return { facts: written ? 1 : 0, status: 'done' }
}

async function executeCoChange(ctx: ExecContext): Promise<ExecResult> {
  const pairs = codeGraphService.findCoChangePairs(ctx.workspacePath, {
    maxCommits: 200,
    minCoChanges: 3,
    maxResults: MAX_COCHANGE_RESULTS
  })
  if (pairs.length === 0) return { facts: 0, status: 'skipped' }

  const pairList = pairs
    .map((p) => `${p.fileA} ↔ ${p.fileB} (${p.coChangeCount} co-changes)`)
    .join('\n  ')

  const written = await memoryEngineService.writeFact({
    workspaceId: ctx.workspaceId,
    category: 'reference',
    title: 'Implicit coupling — files that change together',
    content: `These file pairs are frequently committed together, suggesting logical coupling beyond imports:\n  ${pairList}`,
    tags: ['bootstrap', 'history', 'coupling'],
    scopePaths: pairs.flatMap((p) => [p.fileA, p.fileB]).slice(0, 20),
    sourceType: 'bootstrap',
    sourceRef: 'bootstrap:history',
    workspacePath: ctx.workspacePath
  })
  return { facts: written ? 1 : 0, status: 'done' }
}

async function executeCommits(ctx: ExecContext): Promise<ExecResult> {
  const sinceArg = ctx.lastCommit ? `${ctx.lastCommit}..HEAD` : `-n ${MAX_COMMIT_SUBJECTS}`
  let commitLog = ''
  try {
    commitLog = execSync(`git log ${sinceArg} --format="%s%n%b" --no-merges`, {
      cwd: ctx.workspacePath,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }).trim()
  } catch {
    return { facts: 0, status: 'skipped', error: 'not a git repo' }
  }

  if (commitLog.length < 50) return { facts: 0, status: 'skipped' }

  const facts = await runExtraction(
    ctx,
    'recent-commits',
    `## Recent git commit messages and bodies:\n\n${commitLog.substring(0, 30000)}`,
    {
      sourceType: 'commit',
      tags: ['bootstrap', 'history'],
      // Date the batch by its newest commit rather than by the scan time.
      observedAt: latestCommitDate(ctx.workspacePath)
    }
  )
  return { facts, status: 'done' }
}

/** Last-modified time of a file as an ISO string, or null if unavailable. */
function fileObservedAt(absPath: string): string | null {
  try {
    return statSync(absPath).mtime.toISOString()
  } catch {
    return null
  }
}

/** Author date of HEAD, or null when this is not a git working tree. */
function latestCommitDate(workspacePath: string): string | null {
  try {
    const out = execSync('git log -1 --format=%aI', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    }).trim()
    return out || null
  } catch {
    return null
  }
}

// ── Structure ───────────────────────────────────────────────────────────────

async function executeCycles(ctx: ExecContext): Promise<ExecResult> {
  const cycles = codeGraphService.findCircularDependencies(ctx.workspaceId, { maxCycles: 10 })
  if (cycles.length === 0) return { facts: 0, status: 'skipped' }

  const cycleList = cycles
    .slice(0, 5)
    .map((c) => c.join(' → '))
    .join('\n  ')

  const written = await memoryEngineService.writeFact({
    workspaceId: ctx.workspaceId,
    category: 'gotcha',
    title: `Circular dependencies detected (${cycles.length} cycles)`,
    content: `The following circular import chains exist:\n  ${cycleList}${cycles.length > 5 ? `\n  …and ${cycles.length - 5} more` : ''}`,
    tags: ['bootstrap', 'structure', 'circular-deps'],
    scopePaths: [...new Set(cycles.flat())].slice(0, 20),
    sourceType: 'bootstrap',
    sourceRef: 'bootstrap:structure',
    workspacePath: ctx.workspacePath
  })
  return { facts: written ? 1 : 0, status: 'done' }
}

// ── Deep Scan agent ─────────────────────────────────────────────────────────

/**
 * Delegates to an external Claude CLI process. Pause cannot interrupt this —
 * the agent is a black box once spawned, so pause only takes effect after it
 * returns. The UI states this explicitly.
 */
async function executeAgent(ctx: ExecContext): Promise<ExecResult> {
  const { workspaceId, workspacePath } = ctx

  const metrics = estimateProjectComplexity(workspacePath)
  const budget = computeAgentBudget(metrics)
  ctx.onMessage(
    `Project: ${metrics.fileCount} files, ${metrics.docCount} docs (${metrics.codebaseSize}) → ` +
      `budget ${budget.maxFacts} facts, ${budget.maxTurns} turns`
  )

  let topFilesContext = ''
  try {
    const topFiles = await codeGraphService.getTopRankedFiles(workspaceId, [], 40, workspacePath)
    if (topFiles.length > 0) {
      topFilesContext = `\n\nTop 40 files by PageRank (most central/coupled):\n${topFiles
        .map((f, i) => `  ${i + 1}. ${f}`)
        .join('\n')}`
    }
  } catch {
    exLog.warn('[executeAgent] Failed to get top-ranked files')
  }

  let existingFactsSummary = ''
  try {
    const existing = memoryFactRepository.findByWorkspace(workspaceId)
    if (existing.length > 0) {
      const titles = existing
        .slice(0, 30)
        .map((f) => `- ${f.title}`)
        .join('\n')
      existingFactsSummary =
        `\n\nFacts already recorded (avoid duplicates):\n${titles}` +
        (existing.length > 30 ? `\n…and ${existing.length - 30} more` : '')
    }
  } catch {
    /* ok */
  }

  const prompt = buildDeepScanPrompt(topFilesContext, existingFactsSummary, budget)
  const factsBefore = memoryFactRepository.countByWorkspace(workspaceId).active

  // Circuit breaker: the agent writes facts through MCP, so a flat fact count
  // AND a stale last-mutation timestamp together mean it has genuinely stalled.
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  ctx.signal.addEventListener('abort', forwardAbort, { once: true })

  let stalledChecks = 0
  let lastFactCount = factsBefore
  let lastMutationAt = memoryFactRepository.getLastMutationAt(workspaceId)
  const STALL_CHECK_INTERVAL_MS = 30_000
  const MAX_STALLED_CHECKS = 6
  const stallWindowSec = (MAX_STALLED_CHECKS * STALL_CHECK_INTERVAL_MS) / 1000

  const stallTimer = setInterval(() => {
    if (controller.signal.aborted) return
    const currentFacts = memoryFactRepository.countByWorkspace(workspaceId).active
    const currentMutationAt = memoryFactRepository.getLastMutationAt(workspaceId)
    if (currentFacts > lastFactCount || currentMutationAt > lastMutationAt) {
      stalledChecks = 0
      lastFactCount = currentFacts
      lastMutationAt = currentMutationAt
      return
    }
    stalledChecks++
    if (stalledChecks >= MAX_STALLED_CHECKS) {
      ctx.onMessage(`Circuit breaker: no memory activity for ${stallWindowSec}s — aborting agent`)
      controller.abort()
    }
  }, STALL_CHECK_INTERVAL_MS)

  let agentError: string | undefined
  try {
    const result = await runAgenticClaude({
      workspaceId,
      workspacePath,
      prompt,
      allowedTools: [
        'Read',
        'Grep',
        'Glob',
        ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES,
        ...MCP_TOOLS.MEMORY._ALL_NAMES
      ],
      model: 'claude-sonnet-4-6',
      maxTurns: budget.maxTurns,
      timeoutMs: budget.timeoutMs,
      signal: controller.signal,
      onLine: (line) => {
        if (line.length > 10) ctx.onMessage(`Agent: ${line.substring(0, 120)}…`)
      }
    })
    if (result.exitCode !== 0 && result.exitCode !== null) {
      agentError = `Claude CLI exited with code ${result.exitCode}`
    }
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err)
  } finally {
    clearInterval(stallTimer)
    ctx.signal.removeEventListener('abort', forwardAbort)
  }

  const created = Math.max(
    0,
    memoryFactRepository.countByWorkspace(workspaceId).active - factsBefore
  )

  if (ctx.signal.aborted) return { facts: created, status: 'pending' }
  // A stalled or erroring agent that still recorded facts did useful work —
  // don't paint the whole item red over a non-zero exit code.
  if (agentError && created === 0) return { facts: 0, status: 'failed', error: agentError }
  return { facts: created, status: 'done' }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function executeItem(ctx: ExecContext): Promise<ExecResult> {
  switch (ctx.item.kind) {
    case 'doc':
      return executeFile(ctx, 'docs')
    case 'arch-file':
      return executeFile(ctx, 'architecture')
    case 'manifests':
      return executeManifests(ctx)
    case 'hotspots':
      return executeHotspots(ctx)
    case 'cochange':
      return executeCoChange(ctx)
    case 'commits':
      return executeCommits(ctx)
    case 'cycles':
      return executeCycles(ctx)
    case 'agent':
      return executeAgent(ctx)
    default:
      return { facts: 0, status: 'skipped', error: `unknown kind: ${ctx.item.kind}` }
  }
}

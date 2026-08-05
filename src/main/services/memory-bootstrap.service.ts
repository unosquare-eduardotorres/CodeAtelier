/**
 * memory-bootstrap.service.ts — Orchestrates project knowledge bootstrapping.
 *
 * Two modes:
 *   1. "Feed Brain" (full/incremental): deterministic 6-phase pipeline
 *      Preflight → Docs → Stack → Architecture → History → Structure → Finalize
 *   2. "Deep Scan" (deep-scan): Phases 0–2 + agent-driven exploration via Claude CLI
 *
 * Every fact tagged ['bootstrap', <phase>]; the write pipeline's cosine-dedup
 * makes re-runs confirm (not duplicate).
 *
 * Singleton: memoryBootstrapService
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative, basename } from 'node:path'
import { createHash } from 'node:crypto'
import log from 'electron-log'
import type { BootstrapProgress, BootstrapMode, BootstrapPhaseLabel } from '../../shared/types'
import { memoryExtractionService } from './memory-extraction.service'
import { memoryEngineService } from './memory-engine.service'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { codeGraphService } from './code-graph.service'
import { localEmbeddingProvider } from './local-embedding.provider'
import { workspaceRepository } from '../db/repositories'
import { readDocument } from './document-reader'
import { chunkDocument, detectStrategy } from './document-chunker'
import { runAgenticClaude } from './agentic-claude-runner'
import { MCP_TOOLS } from '../../shared/constants'

const bsLog = log.scope('memory-bootstrap')

// ── Configuration ────────────────────────────────────────────────────────────

/** Directories to skip during discovery */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.tox', '.venv',
  'vendor', 'target', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '.vs'
])

/** Max files to read per phase for safety */
const MAX_ARCHITECTURE_FILES = 40
const MAX_CHUNKS_PER_FILE = 25
const MAX_HOTSPOT_FACTS = 15
const MAX_COCHANGE_RESULTS = 15
const MAX_COMMIT_SUBJECTS = 50

/** Discovery caps for scattered documentation in deep legacy trees */
const MAX_SCATTERED_DOCS = 500
const MAX_SCATTERED_DOC_DEPTH = 4

/** Doc patterns for Phase 1 */
const DOC_PATTERNS = [
  'README.md', 'README.txt', 'README.rst', 'README',
  'CLAUDE.md', 'AGENTS.md',
  'ARCHITECTURE.md', 'ARCHITECTURE.txt',
  'CONTRIBUTING.md', 'CONTRIBUTING.txt',
  'CHANGELOG.md', 'CHANGELOG.txt',
  'SECURITY.md', 'LICENSE.md'
]

/** Globs for doc directories */
const DOC_DIRS = [
  'docs', 'doc', 'documentation', '.github',
  // Common documentation locations beyond the basics
  'wiki', 'guides', 'specs', 'design',
  'api-docs', 'api', 'reference',
  'architecture', 'decisions', 'adr',
  'manuals', 'handbooks', 'howto',
  'notes', 'knowledge-base'
]

/** Manifest files for Phase 2 */
const MANIFEST_FILES = [
  'package.json', 'tsconfig.json', 'tsconfig.base.json',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum',
  'Cargo.toml',
  'Gemfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'electron-builder.yml', 'electron-builder.json5',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.github/workflows/*.yml', '.github/workflows/*.yaml',
  'Makefile', 'justfile'
]

// ── Phase definitions ────────────────────────────────────────────────────────

const FULL_PHASES: BootstrapPhaseLabel[] = [
  'preflight', 'docs', 'stack', 'architecture', 'history', 'structure', 'finalize'
]

const DEEP_SCAN_PHASES: BootstrapPhaseLabel[] = [
  'preflight', 'docs', 'stack', 'architecture', 'history', 'agent-exploration', 'finalize'
]

// ── Types ────────────────────────────────────────────────────────────────────

export type BootstrapProgressCallback = (progress: BootstrapProgress) => void

/**
 * Outcome of a single-file extraction.
 * - `extracted`  — processed cleanly, doc-state hash written
 * - `unchanged`  — hash matched a prior clean run, nothing to do
 * - `skipped`    — unreadable / image / no chunks
 * - `failed`     — aborted or a chunk threw; doc-state deliberately NOT written
 */
interface ExtractFileOutcome {
  facts: number
  status: 'extracted' | 'unchanged' | 'skipped' | 'failed'
}

interface BootstrapJob {
  controller: AbortController
  jobId: string
}

// ── Service ──────────────────────────────────────────────────────────────────

class MemoryBootstrapService {
  private activeJob: BootstrapJob | null = null
  private jobCounter = 0

  /**
   * Start the project knowledge bootstrap pipeline.
   *
   * @param workspaceId - Workspace to associate facts with
   * @param workspacePath - Absolute path to workspace root
   * @param mode - 'full' (first run), 'incremental' (re-run), or 'deep-scan' (agent-driven)
   * @param onProgress - Progress callback for UI streaming
   */
  async startBootstrap(
    workspaceId: string,
    workspacePath: string,
    mode: BootstrapMode = 'full',
    onProgress?: BootstrapProgressCallback,
    force = false
  ): Promise<{ jobId: string; factsCreated: number }> {
    if (this.activeJob) {
      throw new Error('A bootstrap job is already running')
    }

    if (force) {
      try {
        const cleared = memoryFactRepository.clearDocStates(workspaceId)
        bsLog.info(`[startBootstrap] Force re-scan — cleared ${cleared} doc-state hashes`)
      } catch (err) {
        bsLog.warn('[startBootstrap] Failed to clear doc states:', err)
      }
    }

    const jobId = `bootstrap-${++this.jobCounter}-${Date.now()}`
    const controller = new AbortController()
    this.activeJob = { controller, jobId }

    const phases = mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES
    let totalFacts = 0

    const emit = (
      phaseIndex: number,
      phaseLabel: BootstrapPhaseLabel,
      message: string,
      jobStatus: BootstrapProgress['jobStatus'] = 'running'
    ): void => {
      onProgress?.({
        jobId,
        phaseIndex,
        phaseCount: phases.length,
        phaseLabel,
        factsCreated: totalFacts,
        message,
        jobStatus,
        mode
      })
    }

    // Relax the dedup threshold for agent-recorded ('tool') facts for the
    // duration of this job — see MemoryEngineService.setBootstrapActive.
    memoryEngineService.setBootstrapActive(true)

    try {
      const signal = controller.signal

      // ── Phase 0: Preflight ──
      emit(0, 'preflight', 'Checking prerequisites…')
      const preflight = await this.phasePreflight(workspaceId, workspacePath, mode, signal)
      if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

      // ── Phase 1: Docs ──
      emit(1, 'docs', 'Discovering documentation…')
      const docFacts = await this.phaseDocs(workspaceId, workspacePath, signal, (msg) =>
        emit(1, 'docs', msg)
      )
      totalFacts += docFacts
      if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

      // ── Phase 2: Stack ──
      emit(2, 'stack', 'Analyzing tech stack…')
      const stackFacts = await this.phaseStack(workspaceId, workspacePath, signal, (msg) =>
        emit(2, 'stack', msg)
      )
      totalFacts += stackFacts
      if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

      if (mode === 'deep-scan') {
        // ── Phase 3-DS: Architecture ──
        // Runs before agent-exploration so the agent sees these facts in its
        // "already recorded" list and spends its budget on genuinely new ground.
        emit(3, 'architecture', 'Analyzing architectural backbone…')
        const dsArchFacts = await this.phaseArchitecture(
          workspaceId,
          workspacePath,
          preflight,
          signal,
          (msg) => emit(3, 'architecture', msg)
        )
        totalFacts += dsArchFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 4-DS: History ──
        emit(4, 'history', 'Mining git history…')
        const dsHistFacts = await this.phaseHistory(
          workspaceId,
          workspacePath,
          preflight,
          signal,
          (msg) => emit(4, 'history', msg)
        )
        totalFacts += dsHistFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 5-DS: Agent Exploration ──
        emit(5, 'agent-exploration', 'Spawning exploration agent…')
        const agentFacts = await this.phaseDeepScan(
          workspaceId,
          workspacePath,
          preflight,
          signal,
          (msg) => emit(5, 'agent-exploration', msg)
        )
        totalFacts += agentFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 6-DS: Finalize ──
        emit(6, 'finalize', 'Finalizing…')
        await this.phaseFinalize(workspaceId, workspacePath, (msg) => emit(6, 'finalize', msg))
      } else {
        // ── Phase 3: Architecture ──
        emit(3, 'architecture', 'Analyzing architectural backbone…')
        const archFacts = await this.phaseArchitecture(
          workspaceId,
          workspacePath,
          preflight,
          signal,
          (msg) => emit(3, 'architecture', msg)
        )
        totalFacts += archFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 4: History ──
        emit(4, 'history', 'Mining git history…')
        const histFacts = await this.phaseHistory(
          workspaceId,
          workspacePath,
          preflight,
          signal,
          (msg) => emit(4, 'history', msg)
        )
        totalFacts += histFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 5: Structure ──
        emit(5, 'structure', 'Detecting structural patterns…')
        const structFacts = await this.phaseStructure(workspaceId, workspacePath, (msg) =>
          emit(5, 'structure', msg)
        )
        totalFacts += structFacts
        if (signal.aborted) return this.finishCancelled(jobId, totalFacts, emit, phases)

        // ── Phase 6: Finalize ──
        emit(6, 'finalize', 'Finalizing…')
        await this.phaseFinalize(workspaceId, workspacePath, (msg) => emit(6, 'finalize', msg))
      }

      const finalIdx = phases.length - 1
      emit(
        finalIdx,
        'finalize',
        `Bootstrap complete — ${totalFacts} facts created`,
        'done'
      )

      bsLog.info(`[startBootstrap] Job ${jobId} complete: ${totalFacts} facts (mode=${mode})`)
      return { jobId, factsCreated: totalFacts }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      bsLog.error(`[startBootstrap] Job ${jobId} failed:`, err)
      const finalIdx = phases.length - 1
      emit(finalIdx, phases[finalIdx], `Error: ${msg}`, 'error')
      return { jobId, factsCreated: totalFacts }
    } finally {
      memoryEngineService.setBootstrapActive(false)
      this.activeJob = null
    }
  }

  /**
   * Cancel the active bootstrap job.
   */
  cancel(jobId: string): boolean {
    if (this.activeJob && this.activeJob.jobId === jobId) {
      this.activeJob.controller.abort()
      bsLog.info(`[cancel] Job ${jobId} cancelled`)
      return true
    }
    return false
  }

  /**
   * Cancel any active bootstrap job.
   */
  cancelAll(): void {
    if (this.activeJob) {
      this.activeJob.controller.abort()
      bsLog.info('[cancelAll] Active job cancelled')
    }
  }

  get isRunning(): boolean {
    return this.activeJob !== null
  }

  // ── Phase 0: Preflight ───────────────────────────────────────────────────

  private async phasePreflight(
    workspaceId: string,
    workspacePath: string,
    mode: BootstrapMode,
    _signal: AbortSignal
  ): Promise<{ hasIndex: boolean; lastCommit: string | null; headSha: string | null }> {
    // Check code-graph index
    const hasIndex = codeGraphService.hasPersistedIndex(workspaceId)

    // Deep Scan now runs the architecture phase too, so it needs the index as well.
    if (!hasIndex) {
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

    // Read incremental markers from workspace settings
    const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
    const lastCommit = (settings.memoryBootstrapLastCommit as string) ?? null

    // Get current HEAD SHA
    let headSha: string | null = null
    try {
      headSha = execSync('git rev-parse HEAD', {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim()
    } catch {
      bsLog.info('[preflight] Not a git repo or git unavailable')
    }

    // On incremental mode, check if anything changed
    if (mode === 'incremental' && lastCommit && headSha && lastCommit === headSha) {
      bsLog.info('[preflight] HEAD unchanged since last bootstrap — incremental run will be minimal')
    }

    return {
      hasIndex: codeGraphService.hasPersistedIndex(workspaceId),
      lastCommit,
      headSha
    }
  }

  // ── Phase 1: Documentation ────────────────────────────────────────────────

  private async phaseDocs(
    workspaceId: string,
    workspacePath: string,
    signal: AbortSignal,
    onMsg: (msg: string) => void
  ): Promise<number> {
    const docFiles = this.discoverDocs(workspacePath)
    if (docFiles.length === 0) {
      onMsg('No documentation files found')
      return 0
    }

    onMsg(`Found ${docFiles.length} documentation files`)
    let totalFacts = 0
    let scanned = 0
    let failed = 0
    let skipped = 0

    for (const filePath of docFiles) {
      if (signal.aborted) break

      const relPath = relative(workspacePath, filePath)
      scanned++

      try {
        const outcome = await this.extractFromFile(
          workspaceId, workspacePath, filePath, signal,
          { sourceType: 'bootstrap', tags: ['bootstrap', 'docs'] }
        )
        totalFacts += outcome.facts
        if (outcome.status === 'failed') failed++
        if (outcome.status === 'unchanged') skipped++
      } catch (err) {
        failed++
        bsLog.warn(`[phaseDocs] Error on ${relPath}:`, err)
      }

      onMsg(
        `[${scanned}/${docFiles.length}] ${relPath} — ` +
        `${totalFacts} facts, ${skipped} unchanged, ${failed} failed`
      )
    }

    onMsg(
      `Documentation phase complete — ${totalFacts} facts from ${scanned} files ` +
      `(${skipped} unchanged, ${failed} failed)`
    )
    return totalFacts
  }

  // ── Phase 2: Stack / Manifests ────────────────────────────────────────────

  private async phaseStack(
    workspaceId: string,
    workspacePath: string,
    _signal: AbortSignal,
    onMsg: (msg: string) => void
  ): Promise<number> {
    const manifestContent = this.collectManifests(workspacePath)
    if (!manifestContent || manifestContent.length < 20) {
      onMsg('No manifest files found')
      return 0
    }

    onMsg('Extracting tech stack facts…')

    try {
      const facts = await memoryExtractionService.extractFromContent(
        workspaceId,
        workspacePath,
        'project-manifests',
        manifestContent,
        undefined,
        { sourceType: 'bootstrap', tags: ['bootstrap', 'stack'] }
      )
      onMsg(`Stack phase complete — ${facts} facts`)
      return facts
    } catch (err) {
      bsLog.warn('[phaseStack] Extraction failed:', err)
      onMsg('Stack extraction failed')
      return 0
    }
  }

  // ── Phase 3: Architecture ─────────────────────────────────────────────────

  private async phaseArchitecture(
    workspaceId: string,
    workspacePath: string,
    preflight: { hasIndex: boolean; lastCommit: string | null; headSha: string | null },
    signal: AbortSignal,
    onMsg: (msg: string) => void
  ): Promise<number> {
    if (!preflight.hasIndex) {
      onMsg('Skipped — no code-graph index available')
      return 0
    }

    // Get top-ranked files by PageRank
    let topFiles = await codeGraphService.getTopRankedFiles(
      workspaceId,
      [],
      MAX_ARCHITECTURE_FILES
    )

    // On incremental runs, filter to changed files only
    if (preflight.lastCommit && preflight.headSha && preflight.lastCommit !== preflight.headSha) {
      const changedFiles = this.getChangedFilesSinceCommit(workspacePath, preflight.lastCommit)
      if (changedFiles.size > 0) {
        const before = topFiles.length
        topFiles = topFiles.filter((f) => changedFiles.has(f))
        onMsg(`Incremental: ${topFiles.length}/${before} central files changed`)
      }
    }

    if (topFiles.length === 0) {
      onMsg('No central files to analyze')
      return 0
    }

    onMsg(`Analyzing ${topFiles.length} central files by PageRank…`)
    let totalFacts = 0
    let failed = 0

    for (let i = 0; i < topFiles.length; i++) {
      if (signal.aborted) break

      const relFile = topFiles[i]
      const absFile = join(workspacePath, relFile)
      onMsg(`[${i + 1}/${topFiles.length}] ${relFile}`)

      try {
        const outcome = await this.extractFromFile(
          workspaceId, workspacePath, absFile, signal,
          { sourceType: 'bootstrap', tags: ['bootstrap', 'architecture'] }
        )
        totalFacts += outcome.facts
        if (outcome.status === 'failed') failed++
      } catch (err) {
        failed++
        bsLog.warn(`[phaseArchitecture] Error on ${relFile}:`, err)
      }
    }

    onMsg(`Architecture phase complete — ${totalFacts} facts (${failed} files failed)`)
    return totalFacts
  }

  // ── Phase 4: History ──────────────────────────────────────────────────────

  private async phaseHistory(
    workspaceId: string,
    workspacePath: string,
    preflight: { hasIndex: boolean; lastCommit: string | null; headSha: string | null },
    signal: AbortSignal,
    onMsg: (msg: string) => void
  ): Promise<number> {
    let totalFacts = 0

    // 4a. Hotspots — aggregate into 1–2 facts
    if (preflight.hasIndex) {
      onMsg('Analyzing hotspots (churn × coupling)…')
      try {
        const hotspots = codeGraphService.findHotspots(workspaceId, workspacePath, {
          maxResults: MAX_HOTSPOT_FACTS
        })

        if (hotspots.length > 0) {
          const hotspotList = hotspots
            .map((h) => `${h.file} (refs=${h.referenceCount}, churn=${h.gitChurn}, score=${h.hotspotScore})`)
            .join('\n  ')

          const written = await memoryEngineService.writeFact({
            workspaceId,
            category: 'reference',
            title: 'High-risk hotspots (churn × coupling)',
            content: `These files have the highest combined reference count and git churn, making them risky to modify:\n  ${hotspotList}`,
            tags: ['bootstrap', 'history', 'hotspots'],
            scopePaths: hotspots.map((h) => h.file),
            sourceType: 'bootstrap',
            sourceRef: 'bootstrap:history',
            workspacePath
          })
          if (written) totalFacts++
        }
      } catch (err) {
        bsLog.warn('[phaseHistory] Hotspot analysis failed:', err)
      }
    }

    if (signal.aborted) return totalFacts

    // 4b. Co-change pairs
    onMsg('Mining co-change patterns…')
    try {
      const pairs = codeGraphService.findCoChangePairs(workspacePath, {
        maxCommits: 200,
        minCoChanges: 3,
        maxResults: MAX_COCHANGE_RESULTS
      })

      if (pairs.length > 0) {
        const pairList = pairs
          .map((p) => `${p.fileA} ↔ ${p.fileB} (${p.coChangeCount} co-changes)`)
          .join('\n  ')

        const written = await memoryEngineService.writeFact({
          workspaceId,
          category: 'reference',
          title: 'Implicit coupling — files that change together',
          content: `These file pairs are frequently committed together, suggesting logical coupling beyond imports:\n  ${pairList}`,
          tags: ['bootstrap', 'history', 'coupling'],
          scopePaths: pairs.flatMap((p) => [p.fileA, p.fileB]).slice(0, 20),
          sourceType: 'bootstrap',
          sourceRef: 'bootstrap:history',
          workspacePath
        })
        if (written) totalFacts++
      }
    } catch (err) {
      bsLog.warn('[phaseHistory] Co-change analysis failed:', err)
    }

    if (signal.aborted) return totalFacts

    // 4c. Recent commits → extract conventions/decisions
    onMsg('Extracting facts from recent commits…')
    try {
      const sinceArg = preflight.lastCommit ? `${preflight.lastCommit}..HEAD` : `-n ${MAX_COMMIT_SUBJECTS}`
      const commitLog = execSync(
        `git log ${sinceArg} --format="%s%n%b" --no-merges`,
        { cwd: workspacePath, encoding: 'utf-8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
      ).trim()

      if (commitLog.length >= 50) {
        const commitFacts = await memoryExtractionService.extractFromContent(
          workspaceId,
          workspacePath,
          'recent-commits',
          `## Recent git commit messages and bodies:\n\n${commitLog.substring(0, 30000)}`,
          undefined,
          { sourceType: 'commit', tags: ['bootstrap', 'history'] }
        )
        totalFacts += commitFacts
      }
    } catch (err) {
      bsLog.warn('[phaseHistory] Commit log extraction failed:', err)
    }

    onMsg(`History phase complete — ${totalFacts} facts`)
    return totalFacts
  }

  // ── Phase 5: Structural gotchas ───────────────────────────────────────────

  private async phaseStructure(
    workspaceId: string,
    workspacePath: string,
    onMsg: (msg: string) => void
  ): Promise<number> {
    let totalFacts = 0

    // Circular dependencies
    onMsg('Checking for circular dependencies…')
    try {
      const cycles = codeGraphService.findCircularDependencies(workspaceId, { maxCycles: 10 })

      if (cycles.length > 0) {
        const cycleList = cycles
          .slice(0, 5)
          .map((c) => c.join(' → '))
          .join('\n  ')

        const written = await memoryEngineService.writeFact({
          workspaceId,
          category: 'gotcha',
          title: `Circular dependencies detected (${cycles.length} cycles)`,
          content: `The following circular import chains exist:\n  ${cycleList}${cycles.length > 5 ? `\n  …and ${cycles.length - 5} more` : ''}`,
          tags: ['bootstrap', 'structure', 'circular-deps'],
          scopePaths: [...new Set(cycles.flat())].slice(0, 20),
          sourceType: 'bootstrap',
          sourceRef: 'bootstrap:structure',
          workspacePath
        })
        if (written) totalFacts++
      }
    } catch (err) {
      bsLog.warn('[phaseStructure] Circular dependency check failed:', err)
    }

    onMsg(`Structure phase complete — ${totalFacts} facts`)
    return totalFacts
  }

  // ── Phase 6: Finalize ─────────────────────────────────────────────────────

  private async phaseFinalize(
    workspaceId: string,
    workspacePath: string,
    onMsg: (msg: string) => void
  ): Promise<void> {
    // Backfill pending embeddings
    onMsg('Backfilling pending embeddings…')
    try {
      const backfilled = await memoryEngineService.backfillAllPendingEmbeddings()
      if (backfilled > 0) {
        onMsg(`Backfilled ${backfilled} embeddings`)
      }
    } catch (err) {
      bsLog.warn('[phaseFinalize] Embedding backfill failed:', err)
    }

    // Write incremental markers
    let headSha: string | null = null
    try {
      headSha = execSync('git rev-parse HEAD', {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim()
    } catch {
      // not a git repo
    }

    try {
      const current = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      workspaceRepository.updateSettings(workspaceId, {
        ...current,
        memoryBootstrapLastCommit: headSha,
        memoryBootstrapLastRunAt: new Date().toISOString()
      })
      onMsg('Incremental markers saved')
    } catch (err) {
      bsLog.warn('[phaseFinalize] Failed to save incremental markers:', err)
    }
  }

  // ── Deep Scan: Agent-driven exploration ───────────────────────────────────

  private estimateProjectComplexity(
    workspacePath: string,
    _preflight: { hasIndex: boolean }
  ): { fileCount: number; docCount: number; hasDeepDocs: boolean; codebaseSize: 'small' | 'medium' | 'large' } {
    let fileCount = 0
    let docCount = 0
    let hasDeepDocs = false

    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || fileCount > 5000) return
      try {
        for (const entry of readdirSync(dir)) {
          if (IGNORE_DIRS.has(entry.toLowerCase())) continue
          const full = join(dir, entry)
          try {
            const stat = statSync(full)
            if (stat.isDirectory()) {
              walk(full, depth + 1)
            } else if (stat.isFile()) {
              fileCount++
              if (/\.(md|mdx|txt|rst|adoc)$/i.test(entry)) {
                docCount++
                if (stat.size > 10_000) hasDeepDocs = true
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    walk(workspacePath, 0)

    const codebaseSize = fileCount > 2000 ? 'large' : fileCount > 500 ? 'medium' : 'small'
    return { fileCount, docCount, hasDeepDocs, codebaseSize }
  }

  private computeAgentBudget(metrics: {
    fileCount: number; docCount: number; hasDeepDocs: boolean; codebaseSize: 'small' | 'medium' | 'large'
  }): { maxTurns: number; maxFacts: number; timeoutMs: number } {
    if (metrics.codebaseSize === 'large' || metrics.docCount > 50) {
      return { maxTurns: 80, maxFacts: 40, timeoutMs: 20 * 60 * 1000 }
    }
    if (metrics.codebaseSize === 'medium' || metrics.docCount > 20
        || (metrics.hasDeepDocs && metrics.docCount > 10)) {
      return { maxTurns: 50, maxFacts: 25, timeoutMs: 15 * 60 * 1000 }
    }
    return { maxTurns: 30, maxFacts: 15, timeoutMs: 10 * 60 * 1000 }
  }

  private async phaseDeepScan(
    workspaceId: string,
    workspacePath: string,
    preflight: { hasIndex: boolean; lastCommit: string | null; headSha: string | null },
    signal: AbortSignal,
    onMsg: (msg: string) => void
  ): Promise<number> {
    onMsg('Preparing agent exploration prompt…')

    // Estimate project complexity for adaptive budget
    const projectMetrics = this.estimateProjectComplexity(workspacePath, preflight)
    const agentBudget = this.computeAgentBudget(projectMetrics)
    onMsg(`Project metrics: ${projectMetrics.fileCount} files, ${projectMetrics.docCount} docs (${projectMetrics.codebaseSize}) → budget ${agentBudget.maxFacts} facts, ${agentBudget.maxTurns} turns`)

    // Build context for the agent
    let topFilesContext = ''
    if (preflight.hasIndex) {
      try {
        const topFiles = await codeGraphService.getTopRankedFiles(workspaceId, [], 40)
        topFilesContext = `\n\nTop 40 files by PageRank (most central/coupled):\n${topFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`
      } catch {
        bsLog.warn('[phaseDeepScan] Failed to get top-ranked files')
      }
    }

    // Gather existing facts to avoid duplication
    let existingFactsSummary = ''
    try {
      const existing = memoryFactRepository.findByWorkspace(workspaceId)
      if (existing.length > 0) {
        const titles = existing.slice(0, 30).map((f) => `- ${f.title}`).join('\n')
        existingFactsSummary = `\n\nFacts already recorded (avoid duplicates):\n${titles}${existing.length > 30 ? `\n…and ${existing.length - 30} more` : ''}`
      }
    } catch {
      // ok
    }

    const explorationPrompt = buildDeepScanPrompt(topFilesContext, existingFactsSummary, agentBudget)

    onMsg('Spawning Claude exploration agent…')

    // Spawn Claude CLI with read-only permissions, memory tools available
    const factsBefore = memoryFactRepository.countByWorkspace(workspaceId).active

    // ── Circuit breaker: abort if agent stalls ──────────────────────
    const controller = new AbortController()
    // Combine external signal with our circuit breaker
    const combinedAbort = (): void => controller.abort()
    signal.addEventListener('abort', combinedAbort, { once: true })

    let stalledChecks = 0
    let lastFactCount = factsBefore
    // A dedupe-merge confirms an existing fact instead of inserting a new one,
    // so the active count stays flat while real work is happening. Track the
    // most recent fact mutation as a second liveness signal.
    let lastMutationAt = memoryFactRepository.getLastMutationAt(workspaceId)
    const STALL_CHECK_INTERVAL_MS = 30_000   // check every 30s
    const MAX_STALLED_CHECKS = 6             // abort after 3 min of no progress
    const stallWindowSec = (MAX_STALLED_CHECKS * STALL_CHECK_INTERVAL_MS) / 1000

    const stallTimer = setInterval(() => {
      if (controller.signal.aborted) return
      const currentFacts = memoryFactRepository.countByWorkspace(workspaceId).active
      const currentMutationAt = memoryFactRepository.getLastMutationAt(workspaceId)
      const madeProgress = currentFacts > lastFactCount || currentMutationAt > lastMutationAt

      if (madeProgress) {
        stalledChecks = 0  // reset on progress
        lastFactCount = currentFacts
        lastMutationAt = currentMutationAt
        return
      }

      stalledChecks++
      if (stalledChecks >= MAX_STALLED_CHECKS) {
        onMsg(`Circuit breaker: no memory activity for ${stallWindowSec}s — aborting agent`)
        controller.abort()
      }
    }, STALL_CHECK_INTERVAL_MS)

    try {
      await this.spawnDeepScanAgent(
        workspaceId, workspacePath, explorationPrompt,
        controller.signal,    // use combined signal
        onMsg, agentBudget
      )
    } catch (err) {
      if (signal.aborted) {
        onMsg('Agent exploration cancelled')
        return 0
      }
      if (controller.signal.aborted && !signal.aborted) {
        bsLog.warn(`[phaseDeepScan] Circuit breaker triggered — no memory activity for ${stallWindowSec}s`)
        onMsg('Agent exploration stopped — stall detected')
      } else {
        bsLog.warn('[phaseDeepScan] Agent exploration failed:', err)
        onMsg('Agent exploration completed with errors')
      }
    } finally {
      clearInterval(stallTimer)
      signal.removeEventListener('abort', combinedAbort)
    }

    const factsAfter = memoryFactRepository.countByWorkspace(workspaceId).active
    const created = Math.max(0, factsAfter - factsBefore)

    onMsg(`Agent exploration complete — ${created} new facts`)
    return created
  }

  private async spawnDeepScanAgent(
    workspaceId: string,
    workspacePath: string,
    prompt: string,
    signal: AbortSignal,
    onMsg: (msg: string) => void,
    budget: { maxTurns: number; timeoutMs: number }
  ): Promise<void> {
    const allowedTools = [
      'Read', 'Grep', 'Glob',
      ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES,
      ...MCP_TOOLS.MEMORY._ALL_NAMES
    ]

    const result = await runAgenticClaude({
      workspaceId,
      workspacePath,
      prompt,
      allowedTools,
      model: 'claude-sonnet-4-6',
      maxTurns: budget.maxTurns,
      timeoutMs: budget.timeoutMs,
      signal,
      onLine: (line) => {
        if (line.length > 10) {
          onMsg(`Agent: ${line.substring(0, 120)}…`)
        }
      }
    })

    if (result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error(`Claude CLI exited with code ${result.exitCode}`)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Discover documentation files in the workspace.
   */
  private discoverDocs(workspacePath: string): string[] {
    const found: string[] = []

    // Root-level doc files
    for (const pattern of DOC_PATTERNS) {
      const fullPath = join(workspacePath, pattern)
      if (existsSync(fullPath)) {
        found.push(fullPath)
      }
    }

    // Root-level *.md (excluding already found)
    try {
      const rootEntries = readdirSync(workspacePath)
      for (const entry of rootEntries) {
        if (entry.endsWith('.md') && !found.some((f) => basename(f) === entry)) {
          const fullPath = join(workspacePath, entry)
          try {
            if (statSync(fullPath).isFile()) found.push(fullPath)
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    // Doc directories
    for (const dir of DOC_DIRS) {
      const dirPath = join(workspacePath, dir)
      this.walkForMd(dirPath, found, 0)
    }

    // ADR directories
    try {
      this.findAdrDirs(workspacePath, found, 0)
    } catch { /* skip */ }

    // Scattered docs: find .md files outside standard doc dirs
    this.discoverScatteredDocs(workspacePath, found, MAX_SCATTERED_DOCS)

    return [...new Set(found)] // deduplicate
  }

  private walkForMd(dirPath: string, files: string[], depth: number, maxFiles: number = MAX_SCATTERED_DOCS): void {
    if (depth > 5 || files.length >= maxFiles) return
    if (!existsSync(dirPath)) return

    try {
      const entries = readdirSync(dirPath)
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.toLowerCase())) continue
        const fullPath = join(dirPath, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            this.walkForMd(fullPath, files, depth + 1, maxFiles)
          } else if (stat.isFile() && /\.(md|txt|rst|adoc)$/i.test(entry)) {
            files.push(fullPath)
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  private findAdrDirs(dirPath: string, files: string[], depth: number): void {
    if (depth > 3) return

    try {
      const entries = readdirSync(dirPath)
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.toLowerCase())) continue
        const fullPath = join(dirPath, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            if (/adr/i.test(entry)) {
              this.walkForMd(fullPath, files, 0)
            } else if (depth < 2) {
              this.findAdrDirs(fullPath, files, depth + 1)
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  /** Find .md files outside standard doc dirs (e.g. feature/README.md) */
  private discoverScatteredDocs(
    rootPath: string,
    files: string[],
    maxFiles: number
  ): void {
    if (files.length >= maxFiles) return

    const seen = new Set(files) // O(1) lookups instead of O(n) includes()

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_SCATTERED_DOC_DEPTH || files.length >= maxFiles) return
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (IGNORE_DIRS.has(entry.toLowerCase())) continue
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              walk(fullPath, depth + 1)
            } else if (
              stat.isFile() &&
              /\.(md|mdx)$/i.test(entry) &&
              stat.size > 500 && // skip tiny stubs
              !seen.has(fullPath)
            ) {
              files.push(fullPath)
              seen.add(fullPath)
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    walk(rootPath, 0)
  }

  /**
   * Collect and concatenate manifest file contents for stack analysis.
   */
  private collectManifests(workspacePath: string): string {
    const parts: string[] = []

    for (const pattern of MANIFEST_FILES) {
      if (pattern.includes('*')) {
        // Glob-like: expand manually for workflow files
        const dir = join(workspacePath, pattern.replace(/\/\*.*/, ''))
        const ext = pattern.split('*.').pop() ?? ''
        try {
          if (existsSync(dir)) {
            for (const entry of readdirSync(dir)) {
              if (entry.endsWith(`.${ext}`)) {
                const content = this.readCapped(join(dir, entry))
                if (content) parts.push(`## ${pattern.replace('*', entry)}\n${content}`)
              }
            }
          }
        } catch { /* skip */ }
      } else {
        const fullPath = join(workspacePath, pattern)
        const content = this.readCapped(fullPath)
        if (content) parts.push(`## ${pattern}\n${content}`)
      }
    }

    // Also detect schema file
    const schemaPatterns = [
      'src/main/db/schema.sql', 'schema.sql', 'db/schema.sql',
      'prisma/schema.prisma', 'drizzle/schema.ts'
    ]
    for (const sp of schemaPatterns) {
      const content = this.readCapped(join(workspacePath, sp), 10000)
      if (content) {
        parts.push(`## ${sp}\n${content}`)
        break
      }
    }

    // Migration directory listing
    const migrationDirs = [
      'src/main/db/migrations', 'migrations', 'db/migrations',
      'prisma/migrations', 'drizzle/migrations'
    ]
    for (const md of migrationDirs) {
      const dirPath = join(workspacePath, md)
      try {
        if (existsSync(dirPath)) {
          const entries = readdirSync(dirPath).sort().slice(-20) // last 20 migrations
          parts.push(`## ${md} (last 20 entries)\n${entries.join('\n')}`)
          break
        }
      } catch { /* skip */ }
    }

    return parts.join('\n\n').substring(0, 50000)
  }

  /**
   * Read a file with a size cap, returning null if missing or too large.
   */
  private readCapped(filePath: string, maxBytes: number = 15000): string | null {
    try {
      if (!existsSync(filePath)) return null
      const stat = statSync(filePath)
      if (!stat.isFile() || stat.size > maxBytes * 3) return null
      const content = readFileSync(filePath, 'utf-8')
      return content.substring(0, maxBytes)
    } catch {
      return null
    }
  }

  /**
   * Extract facts from a single file with hash-gating and chunking.
   *
   * The doc-state hash is only written when the file was processed cleanly.
   * Writing it after a partial run would permanently lock the file out of
   * every future scan (the hash matches, so the next run returns early).
   */
  private async extractFromFile(
    workspaceId: string,
    workspacePath: string,
    filePath: string,
    signal: AbortSignal,
    opts: { sourceType: 'document' | 'commit' | 'bootstrap'; tags: string[] }
  ): Promise<ExtractFileOutcome> {
    // Read the file
    const readResult = await readDocument(filePath)
    if (!readResult.ok || readResult.isImage) return { facts: 0, status: 'skipped' }

    // Hash-gate: skip unchanged files
    const contentHash = createHash('sha256').update(readResult.content).digest('hex')
    const existingState = memoryFactRepository.getDocState(workspaceId, filePath)
    if (existingState && existingState.contentHash === contentHash) {
      return { facts: 0, status: 'unchanged' }
    }

    // Chunk and extract
    const strategy = detectStrategy(filePath)
    const relPath = relative(workspacePath, filePath)
    const chunks = chunkDocument(readResult.content, strategy, relPath)
    if (chunks.length === 0) return { facts: 0, status: 'skipped' }

    let factsFromFile = 0
    let chunkErrors = 0
    let aborted = false
    const cappedChunks = chunks.slice(0, MAX_CHUNKS_PER_FILE)

    for (const chunk of cappedChunks) {
      if (signal.aborted) {
        aborted = true
        break
      }

      try {
        const contentWithContext = chunk.breadcrumb
          ? `[Context: ${chunk.breadcrumb}]\n\n${chunk.content}`
          : chunk.content

        const created = await memoryExtractionService.extractFromContent(
          workspaceId,
          workspacePath,
          relPath,
          contentWithContext,
          undefined,
          { sourceType: opts.sourceType, tags: opts.tags }
        )
        factsFromFile += created
      } catch (err) {
        chunkErrors++
        bsLog.warn(`[extractFromFile] Chunk extraction failed for ${relPath}:`, err)
      }
    }

    // Only gate future runs when this run actually completed cleanly.
    if (!aborted && chunkErrors === 0) {
      memoryFactRepository.upsertDocState(workspaceId, filePath, contentHash)
      return { facts: factsFromFile, status: 'extracted' }
    }

    bsLog.warn(
      `[extractFromFile] Skipping doc-state update for ${relPath} — ` +
      `aborted=${aborted} chunkErrors=${chunkErrors}/${cappedChunks.length}`
    )
    return { facts: factsFromFile, status: 'failed' }
  }

  /**
   * Get files changed since a specific commit.
   */
  private getChangedFilesSinceCommit(workspacePath: string, sinceCommit: string): Set<string> {
    try {
      const output = execSync(`git diff --name-only ${sinceCommit}..HEAD`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024
      }).trim()

      return new Set(output.split('\n').filter(Boolean))
    } catch {
      return new Set()
    }
  }

  private finishCancelled(
    jobId: string,
    totalFacts: number,
    emit: (
      phaseIndex: number,
      phaseLabel: BootstrapPhaseLabel,
      message: string,
      jobStatus: BootstrapProgress['jobStatus']
    ) => void,
    phases: BootstrapPhaseLabel[]
  ): { jobId: string; factsCreated: number } {
    emit(phases.length - 1, phases[phases.length - 1], 'Bootstrap cancelled', 'cancelled')
    return { jobId, factsCreated: totalFacts }
  }
}

// ── Deep Scan Prompt Builder ────────────────────────────────────────────────

function buildDeepScanPrompt(
  topFilesContext: string,
  existingFactsSummary: string,
  budget: { maxFacts: number }
): string {
  return `You are a codebase exploration agent. Your job is to systematically explore this project and record non-obvious architectural facts using the mcp__memory__memory_record tool.

## Instructions

1. Start by reading the project's main entry points, configuration files, and README.
2. Use the code-graph tools (mcp__code-graph__graph_map, mcp__code-graph__file_outline, mcp__code-graph__find_callers, mcp__code-graph__find_references) to understand the architecture.
3. For each important discovery, call mcp__memory__memory_record with:
   - A clear, concise title (5-15 words)
   - Actionable content (1-3 sentences)
   - Appropriate category: "decision", "convention", "gotcha", "preference", or "reference"
   - Relevant tags and scope paths

## Focus Areas
- Service boundaries and responsibilities
- Data flow patterns (IPC, events, stores)
- Configuration and environment conventions
- Error handling patterns
- Database schema and migration conventions
- Testing patterns and infrastructure
- Build and deployment pipeline
- Shared utilities and helper patterns
- Security conventions (validation, auth, input sanitization)
- Naming conventions and code organization

## Rules
- Record up to ${budget.maxFacts} facts — be thorough for large projects
- Prioritize depth on rich documentation files (CLAUDE.md, ARCHITECTURE.md, etc.)
- For each documentation file, extract ALL non-obvious conventions and decisions
- Only skip facts that are trivially discoverable from a single file read
- Each fact must be self-contained and actionable
- Use mcp__memory__memory_search before recording to avoid duplicates
- Focus on decisions, constraints, and gotchas — not descriptions
${topFilesContext}
${existingFactsSummary}

Begin by reading the project root files, then explore the most central modules.`
}

export const memoryBootstrapService = new MemoryBootstrapService()

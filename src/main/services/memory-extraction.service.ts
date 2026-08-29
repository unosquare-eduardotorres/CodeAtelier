/**
 * MemoryExtractionService — Extracts structured facts from transcripts,
 * commits, and documents via Haiku.
 *
 * Replaces `memory-feed.service.ts`. Uses the proven `spawnSummarizer` pattern
 * with model from `modelConfigService.getModel(path, 'memoryFeed')`.
 * `enqueue` serializes the jobs that go through it, but Feed Brain calls
 * `extractFromContent` directly from a concurrent drain pool, so several
 * summarizer children can be alive at once — per-spawn state must stay local
 * to the spawn (see `liveAbortControllers`).
 *
 * Retained: `regenerateClaudeMd` for CLAUDE.md generation.
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { buildEnvWithPath } from './env-utils'
import { dbLogger } from '../logger'
import { memoryEngineService } from './memory-engine.service'
import { modelConfigService, resolveAssignment, buildResolveOpts } from './model-config.service'
import { runOneShotLocal, buildMemoryFeedFallbackArgs } from './one-shot-local'
import { DEFAULT_MODEL_CONFIG, MCP_TOOLS } from '../../shared/constants'
import { runAgenticClaude, parseSentinelBlock, SENTINELS } from './agentic-claude-runner'
import type {
  MemoryFactCategory,
  MemoryFeedProgress,
  MemorySourceType,
  DiscoveredAgent,
  DiscoveredSkill
} from '../../shared/types'

const log = dbLogger

/** Minimum transcript length to bother extracting from. */
const MIN_TRANSCRIPT_CHARS = 200

/** Backoff schedule for transient upstream failures. 2s → 4s → 8s. */
const EXTRACTION_MAX_RETRIES = 3
const EXTRACTION_RETRY_BASE_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Backoff that gives up the moment the run is cancelled. Sleeping through a
 * cancel would spend Claude spawns — and the user's tokens — on a run they have
 * already stopped, and would delay a pause by the full retry schedule.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Failure shapes already logged — a storm must not repeat the same line 400 times. */
const loggedFailureShapes = new Set<string>()
const MAX_LOGGED_FAILURE_SHAPES = 5

/**
 * Collapse the volatile parts of a failure message (exit codes, pids, timings)
 * so that retries of the same fault dedupe onto one slot. A single one-shot
 * boolean was spent by whatever failed first — on a machine without the CLI on
 * PATH that is `command not found`, and the real 429 then logged nothing.
 */
function failureShape(msg: string): string {
  return msg.replace(/\d+/g, '#').slice(0, 120)
}

/**
 * Rate limits and upstream overloads are transient — the same prompt succeeds
 * a few seconds later. Everything else (missing CLI, bad prompt, timeout) is
 * not worth retrying.
 *
 * Exported for tests: the patterns below are an assumption about what the
 * Claude CLI prints, and an assumption worth pinning.
 */
export function isRetryableExtractionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b(429|503|529)\b|rate.?limit|overloaded|too many requests/i.test(msg)
}

/** Options accepted by `extractFromContent`. */
export interface ExtractContentOptions {
  sourceType?: MemorySourceType
  tags?: string[]
  /**
   * Scope paths applied to facts the model did not scope itself. Rule files
   * declare the part of the tree they govern in their own frontmatter, so that
   * is far better than guessing from the source ref.
   */
  scopePaths?: string[]
  /**
   * When the source stated this — a commit date, a file mtime. Drives recency,
   * so history-mined facts are not all dated "today".
   */
  observedAt?: string | null
  /**
   * The caller's cancel signal. Only the retry backoff observes it: an
   * already-spawned summarizer runs to completion, but a cancelled run stops
   * paying for further attempts.
   */
  signal?: AbortSignal
}

/** Structured fact from Haiku extraction. */
interface ExtractedFact {
  category: MemoryFactCategory
  title: string
  content: string
  tags?: string[]
  scopePaths?: string[]
}

type ProgressCallback = (event: MemoryFeedProgress) => void

class MemoryExtractionService {
  /**
   * Every summarizer child currently in flight. A single field cannot work
   * here: the bootstrap drain runs 3-6 extractions at once, so one spawn's
   * timeout would abort a different spawn's process, and shutdown would kill
   * only the most recently started child.
   */
  private liveAbortControllers = new Set<AbortController>()
  private isBusy = false
  private queue: Array<() => Promise<void>> = []
  private processing = false

  // ── Queue ───────────────────────────────────────────────────────────────

  /** Enqueue an extraction job. Only one runs at a time. */
  enqueue(job: () => Promise<void>): void {
    this.queue.push(job)
    this.processQueue()
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      try {
        await job()
      } catch (err) {
        log.warn('[MemoryExtraction] Queued job failed:', err)
      }
    }

    this.processing = false
  }

  // ── Session-end extraction ──────────────────────────────────────────────

  /**
   * Extract facts from a completed session transcript + git changes.
   * Called at stream finalization.
   */
  enqueueSessionExtraction(params: {
    workspaceId: string
    workspacePath: string | null
    transcript: string
    startSha?: string | null
    conversationId: string
  }): void {
    if (params.transcript.length < MIN_TRANSCRIPT_CHARS) {
      log.debug('[MemoryExtraction] Transcript too short, skipping extraction')
      return
    }

    this.enqueue(async () => {
      await this.extractFromSession(params)
    })
  }

  private async extractFromSession(params: {
    workspaceId: string
    workspacePath: string | null
    transcript: string
    startSha?: string | null
    conversationId: string
  }): Promise<void> {
    const { workspaceId, workspacePath, transcript, startSha, conversationId } = params

    // Build context: transcript tail + git changes
    const parts: string[] = []

    // Transcript (tail — last 8000 chars to stay within Haiku budget)
    const tail = transcript.length > 8000 ? transcript.slice(-8000) : transcript
    parts.push(`## Session Transcript (tail)\n${tail}`)

    // Git changes since session start
    if (workspacePath && startSha) {
      try {
        const gitLog = execSync(`git log --stat ${startSha}..HEAD 2>/dev/null || true`, {
          cwd: workspacePath,
          timeout: 5000,
          encoding: 'utf-8',
          maxBuffer: 10_000,
          windowsHide: true
        }).trim()
        if (gitLog) {
          parts.push(`## Git Changes Since Session Start\n${gitLog.slice(0, 3000)}`)
        }
      } catch {
        // No git or no commits — fine
      }
    }

    const combined = parts.join('\n\n')
    const prompt = buildExtractionPrompt(combined)

    try {
      const result = await this.spawnSummarizer(prompt, workspacePath ?? undefined, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        try {
          await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: fact.tags,
            scopePaths: fact.scopePaths,
            sourceType: 'session',
            sourceRef: conversationId,
            workspacePath
          })
          created++
        } catch (err) {
          log.warn('[MemoryExtraction] Failed to write session fact:', err)
        }
      }

      if (created > 0) {
        log.info(
          `[MemoryExtraction] Session extraction: ${created} facts from conversation ${conversationId}`
        )
      }
    } catch (err) {
      log.warn('[MemoryExtraction] Session extraction failed:', err)
    }
  }

  // ── Document extraction ─────────────────────────────────────────────────

  /**
   * Core content-based extraction — works with any text, no file on disk needed.
   * Used by extractFromDocument (file wrapper) and direct content extraction
   * (e.g. URL reference docs, blueprint artifacts).
   */
  async extractFromContent(
    workspaceId: string,
    workspacePath: string,
    sourceRef: string,
    content: string,
    onProgress?: ProgressCallback,
    opts?: ExtractContentOptions
  ): Promise<number> {
    const sourceType = opts?.sourceType ?? 'document'
    const emit = (msg: string, status: MemoryFeedProgress['status'] = 'running'): void => {
      onProgress?.({ status, message: msg, source: sourceType, timestamp: Date.now() })
    }

    if (content.length < 20) {
      emit('Content too short for extraction', 'error')
      return 0
    }

    emit(`Extracting facts from ${sourceRef}...`)

    const budget = estimateExtractionBudget(content, sourceRef)
    const prompt = buildExtractionPrompt(
      `## Document: ${sourceRef}\n${content.substring(0, 50000)}`,
      budget
    )

    let created = 0
    let writeErrors = 0
    let factCount = 0
    let lastWriteError: unknown = null

    try {
      const result = await this.spawnSummarizerWithRetry(
        prompt,
        workspacePath,
        workspaceId,
        emit,
        opts?.signal
      )
      const facts = parseExtractedFacts(result, budget)
      factCount = facts.length

      for (const fact of facts) {
        try {
          const written = await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: [...(fact.tags ?? []), ...(opts?.tags ?? [])],
            scopePaths: resolveScopePaths(fact.scopePaths, opts?.scopePaths, sourceRef),
            sourceType,
            sourceRef,
            observedAt: opts?.observedAt ?? null,
            workspacePath
          })
          if (written) created++
        } catch (err) {
          writeErrors++
          lastWriteError = err
          log.warn('[MemoryExtraction] Failed to write content fact:', err)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emit(`Extraction failed: ${msg}`, 'error')
      // The model never answered, so "0 facts" is not a result — it is an
      // absence of one. Returning 0 is indistinguishable from a clean empty
      // extraction and would let the bootstrap executor record a doc-state
      // hash for a file it never actually read, gating it out of every future
      // scan. Throw so callers can tell a refusal from an empty document.
      throw err instanceof Error ? err : new Error(msg)
    }

    // Every write threw — that is a systemic fault (schema CHECK violation,
    // locked DB, embedding provider crash), not "the model found nothing".
    // Returning 0 here would look identical to a clean empty result and would
    // let MemoryBootstrapService record a doc-state hash for a file that in
    // fact produced nothing, permanently gating it out of future scans.
    // Throw so the caller can tell the two apart.
    if (writeErrors > 0 && created === 0) {
      const msg = lastWriteError instanceof Error ? lastWriteError.message : String(lastWriteError)
      emit(`All ${writeErrors} fact writes failed: ${msg}`, 'error')
      throw new Error(
        `[MemoryExtraction] All ${writeErrors} fact write(s) failed for ${sourceRef}: ${msg}`
      )
    }

    if (writeErrors > 0) {
      log.warn(
        `[MemoryExtraction] ${writeErrors}/${factCount} fact write(s) failed for ${sourceRef} — ${created} succeeded`
      )
    }

    emit(`Created ${created} facts from ${sourceRef}`, 'done')
    return created
  }

  /**
   * Extract facts from a document file (used by doc watcher and manual feed).
   * Thin wrapper over extractFromContent that reads the file from disk.
   */
  async extractFromDocument(
    workspaceId: string,
    workspacePath: string,
    filePath: string,
    onProgress?: ProgressCallback
  ): Promise<number> {
    if (!existsSync(filePath)) {
      onProgress?.({
        status: 'error',
        message: 'File not found',
        source: 'document',
        timestamp: Date.now()
      })
      return 0
    }

    const content = readFileSync(filePath, 'utf-8')
    return this.extractFromContent(workspaceId, workspacePath, filePath, content, onProgress)
  }

  // ── Commit extraction ───────────────────────────────────────────────────

  /**
   * Extract facts from a commit diff. Stores touched paths in scopePaths.
   */
  enqueueCommitExtraction(params: {
    workspaceId: string
    workspacePath: string
    startSha: string
    endSha: string
  }): void {
    this.enqueue(async () => {
      await this.extractFromCommit(params)
    })
  }

  private async extractFromCommit(params: {
    workspaceId: string
    workspacePath: string
    startSha: string
    endSha: string
  }): Promise<void> {
    const { workspaceId, workspacePath, startSha, endSha } = params

    try {
      const diffStat = execSync(`git diff --stat ${startSha}..${endSha} 2>/dev/null || true`, {
        cwd: workspacePath,
        timeout: 5000,
        encoding: 'utf-8',
        maxBuffer: 20_000,
        windowsHide: true
      }).trim()

      if (!diffStat || diffStat.length < 20) return

      const logOutput = execSync(`git log --oneline ${startSha}..${endSha} 2>/dev/null || true`, {
        cwd: workspacePath,
        timeout: 5000,
        encoding: 'utf-8',
        maxBuffer: 10_000,
        windowsHide: true
      }).trim()

      // Extract touched file paths from diff stat
      const touchedPaths = diffStat
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(
          (p) => p && !p.includes('changed') && !p.includes('insertion') && !p.includes('deletion')
        )

      const prompt = buildExtractionPrompt(
        `## Commit Changes (${startSha.slice(0, 7)}..${endSha.slice(0, 7)})\n\n### Commits\n${logOutput.slice(0, 2000)}\n\n### Files Changed\n${diffStat.slice(0, 3000)}`
      )

      const result = await this.spawnSummarizer(prompt, workspacePath, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        try {
          await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: fact.tags,
            scopePaths: fact.scopePaths ?? touchedPaths.slice(0, 10),
            sourceType: 'commit',
            sourceRef: endSha,
            workspacePath
          })
          created++
        } catch (err) {
          log.warn('[MemoryExtraction] Failed to write commit fact:', err)
        }
      }

      if (created > 0) {
        log.info(
          `[MemoryExtraction] Commit extraction: ${created} facts from ${startSha.slice(0, 7)}..${endSha.slice(0, 7)}`
        )
      }
    } catch (err) {
      log.warn('[MemoryExtraction] Commit extraction failed:', err)
    }
  }

  // ── Blueprint completion extraction ──────────────────────────────────────

  /**
   * Extract facts from a completed/failed blueprint. Assembles a context block
   * from spec+plan artifacts, clarify Q&A, and task outcomes, then runs LLM
   * extraction. Enqueued (non-blocking).
   *
   * MEM-BP-COMPLETE-01: Deliberately NOT per-task or per-phase hooks — per-task
   * facts would flood memory. Task outcomes are summarized at completion where
   * failures become 'gotcha' facts.
   */
  enqueueBlueprintExtraction(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    title: string
    status: 'complete' | 'failed'
    phases: Array<{
      phase: string
      artifacts?: Array<{ type: string; contentMd?: string; contentJson?: any }>
    }>
    tasks: Array<{ taskId: string; description: string; status: string }>
    clarifyQA?: Array<{ question: string; answer: string }>
  }): void {
    this.enqueue(async () => {
      await this.extractFromBlueprint(params)
    })
  }

  private async extractFromBlueprint(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    title: string
    status: 'complete' | 'failed'
    phases: Array<{
      phase: string
      artifacts?: Array<{ type: string; contentMd?: string; contentJson?: any }>
    }>
    tasks: Array<{ taskId: string; description: string; status: string }>
    clarifyQA?: Array<{ question: string; answer: string }>
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath, title, status, phases, tasks, clarifyQA } =
      params

    const parts: string[] = []
    parts.push(`## Blueprint: ${title}\nFinal status: ${status}\n`)

    // Spec artifact
    const specPhase = phases.find((p) => p.phase === 'specify')
    const specArtifact = specPhase?.artifacts?.find((a) => a.type === 'spec')
    if (specArtifact?.contentMd) {
      parts.push(`### Specification\n${specArtifact.contentMd.substring(0, 5000)}`)
    }

    // Plan artifact (decisions, risks, constraints)
    const planPhase = phases.find((p) => p.phase === 'plan')
    const planArtifact = planPhase?.artifacts?.find((a) => a.type === 'plan')
    if (planArtifact?.contentMd) {
      parts.push(`### Plan\n${planArtifact.contentMd.substring(0, 5000)}`)
    }

    // Clarify Q&A
    if (clarifyQA && clarifyQA.length > 0) {
      const qaLines = clarifyQA.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n')
      parts.push(`### Clarification Q&A\n${qaLines.substring(0, 3000)}`)
    }

    // Task outcomes summary
    const completed = tasks.filter((t) => t.status === 'complete')
    const failed = tasks.filter((t) => t.status === 'failed')
    const skipped = tasks.filter((t) => t.status === 'skipped')
    parts.push(
      `### Task Outcomes\nCompleted: ${completed.length}, Failed: ${failed.length}, Skipped: ${skipped.length}`
    )
    if (failed.length > 0) {
      parts.push('#### Failed Tasks')
      for (const t of failed.slice(0, 10)) {
        parts.push(`- ${t.taskId}: ${t.description.substring(0, 200)}`)
      }
    }

    const combined = parts.join('\n\n')
    const prompt = buildExtractionPrompt(combined)

    try {
      const result = await this.spawnSummarizer(prompt, workspacePath, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        try {
          await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: [...(fact.tags ?? []), 'blueprint', `blueprint:${blueprintId}`],
            scopePaths: fact.scopePaths,
            sourceType: 'blueprint',
            sourceRef: blueprintId,
            workspacePath
          })
          created++
        } catch (err) {
          log.warn('[MemoryExtraction] Failed to write blueprint fact:', err)
        }
      }

      if (created > 0) {
        log.info(
          `[MemoryExtraction] Blueprint extraction: ${created} facts from "${title}" (${status})`
        )
      }
    } catch (err) {
      log.warn('[MemoryExtraction] Blueprint extraction failed:', err)
    }
  }

  // ── Plan execution completion extraction ────────────────────────────────

  /**
   * Extract facts from a completed chat plan execution. Assembles a context
   * block from phases, tasks, touched files, and timing, then runs LLM
   * extraction. Enqueued (non-blocking).
   *
   * Follows MEM-BP-COMPLETE-01 philosophy: one extraction per completion,
   * not per-task — task outcomes are summarized holistically.
   */
  enqueuePlanExecutionExtraction(params: {
    workspaceId: string
    workspacePath: string
    conversationId: string
    planTitle: string
    planGoal?: string
    status: 'completed' | 'partial' | 'failed'
    phases: Array<{
      phaseTitle: string
      status: string
      touchedFiles: string[]
      tasks: Array<{ title: string; status: string }>
    }>
    durationMs: number
  }): void {
    this.enqueue(async () => {
      await this.extractFromPlanExecution(params)
    })
  }

  private async extractFromPlanExecution(params: {
    workspaceId: string
    workspacePath: string
    conversationId: string
    planTitle: string
    planGoal?: string
    status: 'completed' | 'partial' | 'failed'
    phases: Array<{
      phaseTitle: string
      status: string
      touchedFiles: string[]
      tasks: Array<{ title: string; status: string }>
    }>
    durationMs: number
  }): Promise<void> {
    const {
      workspaceId,
      workspacePath,
      conversationId,
      planTitle,
      planGoal,
      status,
      phases,
      durationMs
    } = params

    const parts: string[] = []
    parts.push(
      `## Chat Plan Execution: ${planTitle}\nFinal status: ${status}\nDuration: ${Math.round(durationMs / 1000)}s\n`
    )

    if (planGoal) {
      parts.push(`### Goal\n${planGoal}`)
    }

    // Phase summary
    parts.push('### Phases')
    for (const phase of phases) {
      const taskSummary =
        phase.tasks.length > 0
          ? phase.tasks.map((t) => `  - [${t.status}] ${t.title}`).join('\n')
          : '  (no tasks)'
      const filesSummary =
        phase.touchedFiles.length > 0 ? `  Files: ${phase.touchedFiles.join(', ')}` : ''
      parts.push(
        `- **${phase.phaseTitle}** (${phase.status})\n${taskSummary}${filesSummary ? '\n' + filesSummary : ''}`
      )
    }

    // All touched files (deduped)
    const allFiles = [...new Set(phases.flatMap((p) => p.touchedFiles))]
    if (allFiles.length > 0) {
      parts.push(`### Files Modified\n${allFiles.slice(0, 30).join('\n')}`)
    }

    // Failed phases/tasks for gotcha extraction
    const failedPhases = phases.filter((p) => p.status === 'failed')
    const failedTasks = phases.flatMap((p) => p.tasks.filter((t) => t.status === 'failed'))
    if (failedPhases.length > 0 || failedTasks.length > 0) {
      parts.push('### Failures')
      for (const fp of failedPhases) {
        parts.push(`- Phase "${fp.phaseTitle}" failed`)
      }
      for (const ft of failedTasks.slice(0, 10)) {
        parts.push(`- Task "${ft.title}" failed`)
      }
    }

    const combined = parts.join('\n\n')
    const prompt = buildExtractionPrompt(combined)

    try {
      const result = await this.spawnSummarizer(prompt, workspacePath, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        try {
          await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: [...(fact.tags ?? []), 'plan-execution', `plan:${conversationId}`],
            scopePaths: fact.scopePaths ?? allFiles.slice(0, 10),
            sourceType: 'session',
            sourceRef: conversationId,
            workspacePath
          })
          created++
        } catch (err) {
          log.warn('[MemoryExtraction] Failed to write plan execution fact:', err)
        }
      }

      if (created > 0) {
        log.info(
          `[MemoryExtraction] Plan execution extraction: ${created} facts from "${planTitle}" (${status})`
        )
      }
    } catch (err) {
      log.warn('[MemoryExtraction] Plan execution extraction failed:', err)
    }
  }

  // ── Single-message extraction (for "Save to memory" hover action) ──────

  /**
   * Extract facts from a single message (deterministic fallback: creates
   * one fact verbatim if Haiku is unavailable).
   */
  async extractFromMessage(
    workspaceId: string,
    messageContent: string,
    workspacePath?: string | null
  ): Promise<number> {
    if (messageContent.length < 20) return 0

    // Try Haiku extraction first
    try {
      const prompt = buildExtractionPrompt(`## Chat Message\n${messageContent.substring(0, 8000)}`)
      const result = await this.spawnSummarizer(prompt, workspacePath ?? undefined, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        await memoryEngineService.writeFact({
          workspaceId,
          category: fact.category,
          title: fact.title,
          content: fact.content,
          tags: fact.tags,
          scopePaths: fact.scopePaths,
          sourceType: 'manual',
          sourceRef: null,
          workspacePath
        })
        created++
      }
      return created
    } catch {
      // Deterministic fallback: save as-is
      const title = messageContent.slice(0, 100).replace(/\n/g, ' ').trim()
      await memoryEngineService.writeFact({
        workspaceId,
        category: 'reference',
        title,
        content: messageContent.slice(0, 2000),
        sourceType: 'manual',
        sourceRef: null,
        workspacePath
      })
      return 1
    }
  }

  // ── CLAUDE.md regeneration (retained from memory-feed.service.ts) ──────

  async regenerateClaudeMd(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<{ success: boolean; content: string; error?: string }> {
    if (this.isBusy) {
      return { success: false, content: '', error: 'An extraction is already in progress' }
    }

    this.isBusy = true
    try {
      onProgress?.({
        source: 'document',
        status: 'running',
        message: 'Gathering project sources...'
      })

      const keyFiles = this.readKeyFiles(workspacePath)
      const treeListing = this.getTreeListing(workspacePath)

      let agents: DiscoveredAgent[] = []
      let skills: DiscoveredSkill[] = []
      try {
        const { workspaceDeployService } = await import('./workspace-deploy.service')
        agents = workspaceDeployService.scanWorkspaceAgents(workspacePath)
        skills = workspaceDeployService.scanWorkspaceSkills(workspacePath)
      } catch (err) {
        log.warn('Failed to scan agents/skills for CLAUDE.md:', err)
      }

      let existingClaudeMd: string | null = null
      try {
        existingClaudeMd = readFileSync(join(workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch {
        /* none */
      }

      let schemaContent: string | null = null
      try {
        schemaContent = readFileSync(
          join(workspacePath, 'src/main/db/schema.sql'),
          'utf-8'
        )?.substring(0, 5000)
      } catch {
        /* none */
      }

      onProgress?.({ source: 'document', status: 'running', message: 'Generating CLAUDE.md...' })

      const prompt = buildRegeneratePrompt({
        keyFiles,
        treeListing,
        agents,
        skills,
        existingClaudeMd,
        schemaContent
      })
      // B2: Intentionally passes only workspacePath (no workspaceId) — regenerateClaudeMd
      // always uses the Claude CLI path because CLAUDE.md generation is a large-context task
      // ill-suited to the 10s local one-shot timeout.
      const content = await this.spawnSummarizer(prompt, workspacePath)

      onProgress?.({ source: 'document', status: 'done', message: 'CLAUDE.md generated' })
      return { success: true, content }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('Failed to regenerate CLAUDE.md:', msg)
      onProgress?.({ source: 'document', status: 'error', message: msg })
      return { success: false, content: '', error: msg }
    } finally {
      this.isBusy = false
    }
  }

  // ── CLAUDE.md agentic regeneration ─────────────────────────────────────

  /**
   * Regenerate CLAUDE.md using an agentic Claude session that explores
   * the project with read-only tools + code-graph MCP.
   *
   * The agent reads the existing CLAUDE.md (if any), explores the codebase,
   * and emits the complete CLAUDE.md between sentinel markers.
   */
  async regenerateClaudeMdAgentic(
    workspacePath: string,
    workspaceId: string,
    onProgress?: ProgressCallback
  ): Promise<{ success: boolean; content: string; error?: string }> {
    if (this.isBusy) {
      return { success: false, content: '', error: 'An extraction is already in progress' }
    }

    this.isBusy = true
    try {
      onProgress?.({
        source: 'document',
        status: 'running',
        message: 'Starting agentic CLAUDE.md generation...'
      })

      // Read existing CLAUDE.md for context
      let existingClaudeMd = ''
      try {
        existingClaudeMd = readFileSync(join(workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch {
        /* none */
      }

      const prompt = buildAgenticClaudeMdPrompt(existingClaudeMd)

      onProgress?.({ source: 'document', status: 'running', message: 'Agent exploring project...' })

      const allowedTools = ['Read', 'Grep', 'Glob', ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES]

      const result = await runAgenticClaude({
        workspaceId,
        workspacePath,
        prompt,
        allowedTools,
        model: 'claude-sonnet-4-6',
        maxTurns: 25,
        timeoutMs: 8 * 60 * 1000, // 8 minutes
        mcpServers: ['code-graph'], // No memory tools for CLAUDE.md gen
        onLine: (line) => {
          // Surface progress to the UI
          if (
            line.length > 10 &&
            !line.startsWith(SENTINELS.BEGIN) &&
            !line.startsWith(SENTINELS.END)
          ) {
            onProgress?.({
              source: 'document',
              status: 'running',
              message: `Agent: ${line.substring(0, 100)}`
            })
          }
        }
      })

      // Parse sentinel block
      const sentinelContent = parseSentinelBlock(result.stdout)
      if (sentinelContent && sentinelContent.length > 50) {
        onProgress?.({ source: 'document', status: 'done', message: 'CLAUDE.md generated' })
        return { success: true, content: sentinelContent }
      }

      // Fallback: use trimmed stdout if sentinels are missing
      const trimmed = result.stdout.trim()
      if (trimmed.length > 50) {
        log.warn('[regenerateClaudeMdAgentic] Sentinels missing — falling back to full stdout')
        onProgress?.({
          source: 'document',
          status: 'done',
          message: 'CLAUDE.md generated (no sentinels)'
        })
        return { success: true, content: trimmed }
      }

      // Empty output
      const errorMsg =
        result.exitCode !== 0
          ? `Claude CLI exited with code ${result.exitCode}`
          : 'Agent produced no output'
      log.error(`[regenerateClaudeMdAgentic] Failed: ${errorMsg}`)
      onProgress?.({ source: 'document', status: 'error', message: errorMsg })
      return { success: false, content: '', error: errorMsg }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[regenerateClaudeMdAgentic] Error:', msg)
      onProgress?.({ source: 'document', status: 'error', message: msg })
      return { success: false, content: '', error: msg }
    } finally {
      this.isBusy = false
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Feed Brain runs several summarizers concurrently, so a 429 is an expected
   * event rather than an exception. Backing off absorbs the burst; without it
   * the file fails, its doc-state hash is not written, and the next run redoes
   * the whole thing at the same concurrency — amplifying the storm instead of
   * damping it.
   *
   * `signal` is the run's cancel/pause signal: retrying (or sleeping) after the
   * user stopped the run spends tokens on work that will be thrown away.
   */
  private async spawnSummarizerWithRetry(
    prompt: string,
    workspacePath: string | undefined,
    workspaceId: string | undefined,
    emit: (msg: string, status?: MemoryFeedProgress['status']) => void,
    signal?: AbortSignal
  ): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= EXTRACTION_MAX_RETRIES; attempt++) {
      try {
        return await this.spawnSummarizer(prompt, workspacePath, workspaceId)
      } catch (err) {
        lastErr = err
        const retryable = isRetryableExtractionError(err)

        // The classifier matches text the Claude CLI is *assumed* to write on a
        // 429. Log the raw failure so that assumption can be checked against a
        // real rate limit instead of trusted blind — if the backoff never fires
        // during a storm, this line says why. One line per distinct failure
        // shape, capped, so each *kind* of fault gets recorded exactly once.
        if (!retryable) {
          const rawMsg = err instanceof Error ? err.message : String(err)
          const shape = failureShape(rawMsg)
          if (
            !loggedFailureShapes.has(shape) &&
            loggedFailureShapes.size < MAX_LOGGED_FAILURE_SHAPES
          ) {
            loggedFailureShapes.add(shape)
            log.warn(
              '[MemoryExtraction] Non-retryable extraction failure — raw text the retry ' +
                `classifier was matched against (first occurrence of this shape): ${rawMsg.slice(0, 1000)}`
            )
          }
        }

        if (!retryable || attempt === EXTRACTION_MAX_RETRIES || signal?.aborted) break
        const delayMs = EXTRACTION_RETRY_BASE_MS * 2 ** attempt
        log.warn(
          `[MemoryExtraction] Transient extraction failure (attempt ${attempt + 1}/${
            EXTRACTION_MAX_RETRIES + 1
          }), retrying in ${delayMs}ms:`,
          err
        )
        emit(`Rate limited — retrying in ${Math.round(delayMs / 1000)}s…`)
        await abortableSleep(delayMs, signal)
        if (signal?.aborted) break
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async spawnSummarizer(
    prompt: string,
    workspacePath?: string,
    workspaceId?: string
  ): Promise<string> {
    // G5: Gate memoryFeed through resolveAssignment — route to local LLM when assigned
    // A2: Guard workspacePath — null paths fall through to the Claude CLI path below
    if (workspaceId && workspacePath) {
      const assignment = resolveAssignment({
        action: 'memoryFeed',
        ...buildResolveOpts(workspaceId)
      })
      if (assignment.provider === 'local-llm') {
        // A3: Local path does not wire an abort controller — bounded by
        // runOneShotLocal's internal 10s timeout (LOCAL_REQUEST_TIMEOUT_MS).
        const localCfg = modelConfigService.getLocalLLMConfig(workspacePath)
        const result = await runOneShotLocal({
          systemPrompt: 'You are a knowledge extraction engine. Follow the instructions exactly.',
          userMessage: prompt,
          baseUrl: modelConfigService.getLocalBaseUrl(localCfg),
          model: assignment.modelId,
          apiKey: localCfg.localApiKey,
          feature: 'memory_feed',
          workspaceId,
          maxTokens: 4096,
          claudeFallbackArgs: buildMemoryFeedFallbackArgs(prompt),
          claudeFallbackModel: DEFAULT_MODEL_CONFIG.memoryFeed
        })
        return result.text
      }
      if (assignment.provider === 'glm') {
        // GLM workspaces must not fall through to the Claude CLI spawn below —
        // that burned Claude-plan quota (weekly-limit api_errors) for what is
        // housekeeping extraction. Route through the same OpenAI-compatible
        // one-shot path as local LLMs, with NO Claude fallback (a GLM failure
        // should surface, not silently spend Anthropic credits).
        const glm = modelConfigService.getGlmConfig(workspacePath)
        const result = await runOneShotLocal({
          systemPrompt: 'You are a knowledge extraction engine. Follow the instructions exactly.',
          userMessage: prompt,
          baseUrl: glm.baseUrl.replace(/\/$/, ''),
          model: glm.smallModelId || glm.modelId,
          apiKey: glm.apiKey,
          feature: 'memory_feed',
          workspaceId,
          maxTokens: 4096,
          timeoutMs: 60_000,
          chatCompletionsPath: '/chat/completions'
        })
        if (!result.text.trim()) {
          // Surface GLM failures — the caller warns per-doc; silently persisting
          // an empty extraction would hide a broken key/endpoint.
          throw new Error('GLM extraction returned empty text')
        }
        return result.text
      }
    }

    return new Promise((resolve, reject) => {
      // Scoped to this spawn, not to the service: concurrent extractions each
      // need to time out (and be killed) independently.
      const controller = new AbortController()
      const { signal } = controller
      this.liveAbortControllers.add(controller)

      const TIMEOUT_MS = 5 * 60 * 1000
      const timer = setTimeout(() => {
        log.warn('Extraction summarizer timed out after 5 minutes')
        controller.abort()
      }, TIMEOUT_MS)

      const env = buildEnvWithPath()

      const model = modelConfigService.getModel(workspacePath ?? undefined, 'memoryFeed')

      const child = spawn(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'text', '--permission-mode', 'plan'],
        { stdio: ['ignore', 'pipe', 'pipe'], env, signal, windowsHide: true }
      )

      log.info(`Extraction summarizer spawned (prompt length: ${prompt.length} chars)`)

      let stdout = ''
      let stderr = ''
      const MAX_OUTPUT = 2 * 1024 * 1024

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT)
          stdout += data.toString().slice(0, MAX_OUTPUT - stdout.length)
      })
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length)
        log.debug(`Extraction stderr: ${chunk.slice(0, 200)}`)
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        this.liveAbortControllers.delete(controller)
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          const details =
            stderr.trim() || (stdout.trim() ? `Unexpected: ${stdout.slice(0, 200)}` : 'No output')
          reject(new Error(`Extraction failed (exit ${code}): ${details}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        this.liveAbortControllers.delete(controller)
        reject(new Error(`Failed to spawn extraction summarizer: ${err.message}`))
      })
    })
  }

  private readKeyFiles(workspacePath: string): string {
    const keyFileNames = ['package.json', 'tsconfig.json', 'electron-builder.yml', 'CLAUDE.md']
    const sections: string[] = []
    for (const name of keyFileNames) {
      const filePath = join(workspacePath, name)
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8')
          sections.push(`### ${name}\n\`\`\`\n${content.substring(0, 5000)}\n\`\`\``)
        }
      } catch {
        /* skip */
      }
    }
    return sections.join('\n\n')
  }

  private getTreeListing(workspacePath: string, depth = 3): string {
    const lines: string[] = []
    const ignored = new Set([
      'node_modules',
      '.git',
      'dist',
      'out',
      'build',
      '.next',
      '.cache',
      'coverage',
      '.idea',
      '.vscode',
      '__pycache__',
      '.DS_Store'
    ])

    const walk = (dir: string, prefix: string, currentDepth: number): void => {
      if (currentDepth > depth) return
      try {
        const entries = readdirSync(dir)
          .filter((e) => !ignored.has(e))
          .sort()
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              lines.push(`${prefix}${entry}/`)
              walk(fullPath, prefix + '  ', currentDepth + 1)
            } else {
              lines.push(`${prefix}${entry}`)
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }

    walk(workspacePath, '', 0)
    return lines.slice(0, 200).join('\n')
  }

  shutdown(): void {
    for (const controller of this.liveAbortControllers) controller.abort()
    this.liveAbortControllers.clear()
    this.isBusy = false
  }
}

// ── Scope resolution ──────────────────────────────────────────────────────────

/**
 * Pick the scope paths for an extracted fact.
 *
 * `parseExtractedFacts` always returns an array, empty when the model omitted
 * the field — so a plain `??` fallback never fired and unscoped facts were
 * being written with no scope at all. Path-based activation depends on this
 * column being populated, so an empty array now falls through to the caller's
 * declared scope and finally to the source reference.
 */
function resolveScopePaths(
  factScopePaths: string[] | undefined,
  declared: string[] | undefined,
  sourceRef: string
): string[] {
  if (factScopePaths && factScopePaths.length > 0) return factScopePaths
  if (declared && declared.length > 0) return declared.slice(0, 10)
  return [sourceRef]
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

const VALID_CATEGORIES: MemoryFactCategory[] = [
  'decision',
  'convention',
  'gotcha',
  'preference',
  'reference'
]

/** Score content richness to determine extraction budget per chunk. */
function estimateExtractionBudget(content: string, sourceRef: string): number {
  let score = 0

  // Heading density (more structure = more facts worth capturing)
  const headingCount = (content.match(/^#{1,4}\s+/gm) || []).length
  score += Math.min(headingCount, 10)

  // Decision language signals
  const decisionSignals = [
    /\bwe chose\b/gi,
    /\bdecision\b/gi,
    /\bconvention\b/gi,
    /\bmust\b/gi,
    /\bnever\b/gi,
    /\balways\b/gi,
    /\barchitecture\b/gi,
    /\bpattern\b/gi,
    /\brequired?\b/gi,
    /\bIMPORTANT\b/g,
    /\bWARNING\b/g,
    /\bNOTE\b/g,
    /\bdo not\b/gi,
    /\bdon't\b/gi,
    /\bavoid\b/gi
  ]
  for (const signal of decisionSignals) {
    score += Math.min((content.match(signal) || []).length, 3)
  }

  // Code blocks (examples = richer context)
  const codeBlocks = (content.match(/```/g) || []).length / 2
  score += Math.min(codeBlocks, 5)

  // Length factor
  if (content.length > 20_000) score += 3
  else if (content.length > 5_000) score += 1

  // File name signals — rich documentation files get a higher budget
  const richFilePatterns = /CLAUDE|ARCHITECTURE|CONTRIBUTING|DESIGN|CONVENTIONS|ADR|DECISIONS/i
  if (richFilePatterns.test(sourceRef)) score += 5

  // Map score to budget: min 2, max 10
  if (score >= 20) return 10
  if (score >= 12) return 7
  if (score >= 6) return 5
  if (score >= 3) return 3
  return 2
}

function buildExtractionPrompt(source: string, maxFacts: number = 3): string {
  return `You are a knowledge extraction engine. Analyze the following source material and extract ONLY the most durable, high-value facts.

For each fact, output a JSON object on its own line:
- "category": one of "decision", "convention", "gotcha", "preference", "reference"
  - decision: architectural choices, tech stack selections, design patterns chosen
  - convention: coding style rules, naming patterns, file organization rules
  - gotcha: surprising behaviors, known bugs, non-obvious constraints
  - preference: user preferences, workflow choices, tool configurations
  - reference: documentation links, API endpoints, configuration values
- "title": short descriptive title (5-15 words)
- "content": the extracted knowledge (1-3 sentences, precise and actionable)
- "tags": array of relevant tags
- "scopePaths": array of file/directory paths this fact relates to (optional)

Strictness rules:
- Output ONLY valid JSON objects, one per line. No markdown, no explanation.
- Extract UP TO ${maxFacts} facts from this content.
- If the content has fewer than ${maxFacts} worthwhile facts, extract fewer.
- Skip version numbers, schema versions, dependency versions — these change frequently.
- Skip things trivially discoverable from a single file read (imports, file structure).
- Skip facts that restate what the code already says ("X uses Y" when X imports Y).
- Focus on WHY decisions were made, non-obvious constraints, and cross-cutting patterns.
- Each fact must be self-contained — useful without reading the source material.
- Prefer conventions that span multiple files over single-file observations.

Source material:
${source}`
}

/** Parse Haiku output: one JSON fact per line. */
function parseExtractedFacts(text: string, maxFacts: number = 3): ExtractedFact[] {
  const facts: ExtractedFact[] = []
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'))

  for (const line of lines) {
    try {
      const data = JSON.parse(line.trim())
      if (!data.category || !data.title || !data.content) continue
      if (!VALID_CATEGORIES.includes(data.category)) continue

      facts.push({
        category: data.category,
        title: String(data.title).slice(0, 200),
        content: String(data.content).slice(0, 4000),
        tags: Array.isArray(data.tags) ? data.tags.map(String).slice(0, 10) : [],
        scopePaths: Array.isArray(data.scopePaths) ? data.scopePaths.map(String).slice(0, 10) : []
      })
    } catch {
      // Skip malformed lines
    }
  }

  // Enforce cap: take only up to the dynamic budget
  return facts.slice(0, maxFacts)
}

// ── CLAUDE.md regeneration prompt (retained from memory-feed.service.ts) ──

interface RegenerateSources {
  keyFiles: string
  treeListing: string
  agents: DiscoveredAgent[]
  skills: DiscoveredSkill[]
  existingClaudeMd: string | null
  schemaContent: string | null
}

function buildRegeneratePrompt(sources: RegenerateSources): string {
  const agentLines =
    sources.agents.length > 0
      ? sources.agents
          .map(
            (a) =>
              `- ${a.parsed.name}: ${a.parsed.description || 'no description'} (model: ${a.parsed.model}, skills: ${a.parsed.skills.join(', ') || 'none'})`
          )
          .join('\n')
      : '(none deployed)'

  const skillLines =
    sources.skills.length > 0
      ? sources.skills
          .map((s) => `- ${s.name}: ${s.frontmatter?.description || 'no description'}`)
          .join('\n')
      : '(none deployed)'

  const existingSection = sources.existingClaudeMd
    ? `### Existing CLAUDE.md (for reference)\n${sources.existingClaudeMd.substring(0, 10000)}`
    : '### No existing CLAUDE.md'

  const schemaSection = sources.schemaContent ? `### Database Schema\n${sources.schemaContent}` : ''

  return `You are an expert CLAUDE.md generator for Claude Code projects. Produce a high-quality CLAUDE.md based ONLY on the actual project sources provided.

## Output Format
Generate a complete CLAUDE.md with: Project name, Overview, Tech stack, Conventions, Project structure, Key commands, What NOT to do, Error handling patterns, Agents, Skills.

## Critical Rules:
- ONLY include technologies in package.json
- ONLY include commands in package.json scripts
- NEVER invent conventions you can't verify
- Keep concise: 100-300 lines

## Sources

### Package + Config
${sources.keyFiles}

### Project Tree
${sources.treeListing}

${schemaSection}

### Agents (${sources.agents.length})
${agentLines}

### Skills (${sources.skills.length})
${skillLines}

${existingSection}

Output ONLY the CLAUDE.md content.`
}

// ── Agentic CLAUDE.md prompt ─────────────────────────────────────────────────

function buildAgenticClaudeMdPrompt(existingClaudeMd: string): string {
  const existingSection = existingClaudeMd
    ? `## Existing CLAUDE.md
The project already has a CLAUDE.md. Reuse anything that is still accurate, but update or remove anything outdated. Here it is:

${existingClaudeMd.substring(0, 12000)}`
    : `## No existing CLAUDE.md
This project does not have a CLAUDE.md yet. Create one from scratch.`

  return `You are a senior engineer creating a CLAUDE.md file for this project. CLAUDE.md is a configuration file that gives Claude Code context about the project.

## Your task

Explore this project thoroughly using the available tools (Read, Grep, Glob, code-graph tools), then produce a comprehensive CLAUDE.md.

## Exploration strategy

1. Start with root files: package.json, tsconfig.json, README.md, Makefile, Dockerfile, etc.
2. Use Glob to understand the project structure and key directories.
3. Read key entry points, config files, and service files.
4. Use code-graph tools (graph_map, file_outline, find_callers) to understand architecture.
5. Look for test infrastructure, build scripts, and CI configuration.
6. Check for conventions in coding style, naming, error handling.

## CLAUDE.md sections to cover

1. **Project overview** — What the project does, its purpose, and high-level architecture.
2. **Tech stack** — Languages, frameworks, key dependencies (only what's actually used).
3. **Project structure** — Key directories and what they contain.
4. **Build & run commands** — How to build, test, lint, and run the project (only real commands from package.json/Makefile).
5. **Key services & modules** — The main components and their responsibilities.
6. **Conventions** — Coding style, naming patterns, file organization, error handling patterns.
7. **What NOT to do** — Anti-patterns, known gotchas, things to avoid.
8. **Testing** — Test infrastructure, how to run tests, test patterns.

## Critical rules

- ONLY include technologies and commands you've verified exist in the project.
- NEVER invent conventions you can't verify from the code.
- Keep it concise: 100–300 lines.
- Be specific and actionable — not generic advice.

${existingSection}

## Output format

After exploring, emit the complete CLAUDE.md content between these exact sentinel markers:

${SENTINELS.BEGIN}
(your complete CLAUDE.md here)
${SENTINELS.END}

Begin exploring the project now.`
}

export const memoryExtractionService = new MemoryExtractionService()

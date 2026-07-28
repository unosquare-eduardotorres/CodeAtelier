/**
 * MemoryExtractionService — Extracts structured facts from transcripts,
 * commits, and documents via Haiku.
 *
 * Replaces `memory-feed.service.ts`. Uses the proven `spawnSummarizer` pattern
 * with model from `modelConfigService.getModel(path, 'memoryFeed')`.
 * Serialized single-in-flight queue prevents concurrent Haiku calls.
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
  DiscoveredAgent,
  DiscoveredSkill
} from '../../shared/types'

const log = dbLogger

/** Minimum transcript length to bother extracting from. */
const MIN_TRANSCRIPT_CHARS = 200

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
  private currentAbortController: AbortController | null = null
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
        const gitLog = execSync(
          `git log --stat ${startSha}..HEAD 2>/dev/null || true`,
          { cwd: workspacePath, timeout: 5000, encoding: 'utf-8', maxBuffer: 10_000 }
        ).trim()
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
        log.info(`[MemoryExtraction] Session extraction: ${created} facts from conversation ${conversationId}`)
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
    opts?: { sourceType?: import('../../shared/types').MemorySourceType; tags?: string[] }
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

    const prompt = buildExtractionPrompt(
      `## Document: ${sourceRef}\n${content.substring(0, 50000)}`
    )

    try {
      const result = await this.spawnSummarizer(prompt, workspacePath, workspaceId)
      const facts = parseExtractedFacts(result)

      let created = 0
      for (const fact of facts) {
        try {
          const written = await memoryEngineService.writeFact({
            workspaceId,
            category: fact.category,
            title: fact.title,
            content: fact.content,
            tags: [...(fact.tags ?? []), ...(opts?.tags ?? [])],
            scopePaths: fact.scopePaths ?? [sourceRef],
            sourceType,
            sourceRef,
            workspacePath
          })
          if (written) created++
        } catch (err) {
          log.warn('[MemoryExtraction] Failed to write content fact:', err)
        }
      }

      emit(`Created ${created} facts from ${sourceRef}`, 'done')
      return created
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emit(`Extraction failed: ${msg}`, 'error')
      return 0
    }
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
      onProgress?.({ status: 'error', message: 'File not found', source: 'document', timestamp: Date.now() })
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
      const diffStat = execSync(
        `git diff --stat ${startSha}..${endSha} 2>/dev/null || true`,
        { cwd: workspacePath, timeout: 5000, encoding: 'utf-8', maxBuffer: 20_000 }
      ).trim()

      if (!diffStat || diffStat.length < 20) return

      const logOutput = execSync(
        `git log --oneline ${startSha}..${endSha} 2>/dev/null || true`,
        { cwd: workspacePath, timeout: 5000, encoding: 'utf-8', maxBuffer: 10_000 }
      ).trim()

      // Extract touched file paths from diff stat
      const touchedPaths = diffStat
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((p) => p && !p.includes('changed') && !p.includes('insertion') && !p.includes('deletion'))

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
        log.info(`[MemoryExtraction] Commit extraction: ${created} facts from ${startSha.slice(0, 7)}..${endSha.slice(0, 7)}`)
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
    phases: Array<{ phase: string; artifacts?: Array<{ type: string; contentMd?: string; contentJson?: any }> }>
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
    phases: Array<{ phase: string; artifacts?: Array<{ type: string; contentMd?: string; contentJson?: any }> }>
    tasks: Array<{ taskId: string; description: string; status: string }>
    clarifyQA?: Array<{ question: string; answer: string }>
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath, title, status, phases, tasks, clarifyQA } = params

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
    parts.push(`### Task Outcomes\nCompleted: ${completed.length}, Failed: ${failed.length}, Skipped: ${skipped.length}`)
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
        log.info(`[MemoryExtraction] Blueprint extraction: ${created} facts from "${title}" (${status})`)
      }
    } catch (err) {
      log.warn('[MemoryExtraction] Blueprint extraction failed:', err)
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
      const prompt = buildExtractionPrompt(
        `## Chat Message\n${messageContent.substring(0, 8000)}`
      )
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
      onProgress?.({ source: 'document', status: 'running', message: 'Gathering project sources...' })

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
      } catch { /* none */ }

      let schemaContent: string | null = null
      try {
        schemaContent = readFileSync(join(workspacePath, 'src/main/db/schema.sql'), 'utf-8')?.substring(0, 5000)
      } catch { /* none */ }

      onProgress?.({ source: 'document', status: 'running', message: 'Generating CLAUDE.md...' })

      const prompt = buildRegeneratePrompt({ keyFiles, treeListing, agents, skills, existingClaudeMd, schemaContent })
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
      onProgress?.({ source: 'document', status: 'running', message: 'Starting agentic CLAUDE.md generation...' })

      // Read existing CLAUDE.md for context
      let existingClaudeMd = ''
      try {
        existingClaudeMd = readFileSync(join(workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch { /* none */ }

      const prompt = buildAgenticClaudeMdPrompt(existingClaudeMd)

      onProgress?.({ source: 'document', status: 'running', message: 'Agent exploring project...' })

      const allowedTools = [
        'Read', 'Grep', 'Glob',
        ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES
      ]

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
          if (line.length > 10 && !line.startsWith(SENTINELS.BEGIN) && !line.startsWith(SENTINELS.END)) {
            onProgress?.({ source: 'document', status: 'running', message: `Agent: ${line.substring(0, 100)}` })
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
        onProgress?.({ source: 'document', status: 'done', message: 'CLAUDE.md generated (no sentinels)' })
        return { success: true, content: trimmed }
      }

      // Empty output
      const errorMsg = result.exitCode !== 0
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

  private async spawnSummarizer(prompt: string, workspacePath?: string, workspaceId?: string): Promise<string> {
    // G5: Gate memoryFeed through resolveAssignment — route to local LLM when assigned
    // A2: Guard workspacePath — null paths fall through to the Claude CLI path below
    if (workspaceId && workspacePath) {
      const assignment = resolveAssignment({ action: 'memoryFeed', ...buildResolveOpts(workspaceId) })
      if (assignment.provider === 'local-llm') {
        // A3: Local path does not wire this.currentAbortController — bounded by
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
    }

    return new Promise((resolve, reject) => {
      this.currentAbortController = new AbortController()
      const { signal } = this.currentAbortController

      const TIMEOUT_MS = 5 * 60 * 1000
      const timer = setTimeout(() => {
        log.warn('Extraction summarizer timed out after 5 minutes')
        this.currentAbortController?.abort()
      }, TIMEOUT_MS)

      const env = buildEnvWithPath()

      const model = modelConfigService.getModel(workspacePath ?? undefined, 'memoryFeed')

      const child = spawn(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'text', '--permission-mode', 'plan'],
        { stdio: ['ignore', 'pipe', 'pipe'], env, signal }
      )

      log.info(`Extraction summarizer spawned (prompt length: ${prompt.length} chars)`)

      let stdout = ''
      let stderr = ''
      const MAX_OUTPUT = 2 * 1024 * 1024

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += data.toString().slice(0, MAX_OUTPUT - stdout.length)
      })
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length)
        log.debug(`Extraction stderr: ${chunk.slice(0, 200)}`)
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        this.currentAbortController = null
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          const details = stderr.trim() || (stdout.trim() ? `Unexpected: ${stdout.slice(0, 200)}` : 'No output')
          reject(new Error(`Extraction failed (exit ${code}): ${details}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        this.currentAbortController = null
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
      } catch { /* skip */ }
    }
    return sections.join('\n\n')
  }

  private getTreeListing(workspacePath: string, depth = 3): string {
    const lines: string[] = []
    const ignored = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', 'coverage', '.idea', '.vscode', '__pycache__', '.DS_Store'])

    const walk = (dir: string, prefix: string, currentDepth: number): void => {
      if (currentDepth > depth) return
      try {
        const entries = readdirSync(dir).filter((e) => !ignored.has(e)).sort()
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
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    walk(workspacePath, '', 0)
    return lines.slice(0, 200).join('\n')
  }

  shutdown(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.isBusy = false
  }
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

const VALID_CATEGORIES: MemoryFactCategory[] = ['decision', 'convention', 'gotcha', 'preference', 'reference']

/** Max facts to accept from a single extraction call. */
const MAX_EXTRACTED_FACTS = 3

function buildExtractionPrompt(source: string): string {
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
- MAXIMUM 3 facts. Fewer is better — only extract what’s genuinely durable.
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
function parseExtractedFacts(text: string): ExtractedFact[] {
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
        content: String(data.content).slice(0, 2000),
        tags: Array.isArray(data.tags) ? data.tags.map(String).slice(0, 10) : [],
        scopePaths: Array.isArray(data.scopePaths) ? data.scopePaths.map(String).slice(0, 10) : []
      })
    } catch {
      // Skip malformed lines
    }
  }

  // Enforce cap: take only the first MAX_EXTRACTED_FACTS
  return facts.slice(0, MAX_EXTRACTED_FACTS)
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
  const agentLines = sources.agents.length > 0
    ? sources.agents.map((a) => `- ${a.parsed.name}: ${a.parsed.description || 'no description'} (model: ${a.parsed.model}, skills: ${a.parsed.skills.join(', ') || 'none'})`).join('\n')
    : '(none deployed)'

  const skillLines = sources.skills.length > 0
    ? sources.skills.map((s) => `- ${s.name}: ${s.frontmatter?.description || 'no description'}`).join('\n')
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

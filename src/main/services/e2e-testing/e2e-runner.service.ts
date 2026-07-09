/**
 * E2E Test Runner Service — sequential FIFO execution of E2E test scenarios.
 *
 * Per scenario: reset fixture → create conversation → stream prompts →
 * capture transcript → run assertions → persist result → emit progress.
 *
 * The runner calls the exact same services the IPC handlers delegate to
 * (chatStreamService.stream), so we test the full production pipeline.
 */

import type { BrowserWindow } from 'electron'
import type {
  E2EPreflightResult,
  E2EProgressEvent,
  E2EResultStatus,
  E2ETranscriptEntry
} from '../../../shared/types'
import { IPC_CHANNELS, OMLX_DEFAULT_PORT } from '../../../shared/constants'
import { e2eTestRunRepository, e2eTestResultRepository } from '../../db/repositories'
import { conversationRepository, workspaceRepository, conversationSpecialistRepository } from '../../db/repositories'
import { join } from 'path'
import { chatStreamService } from '../chat-stream.service'
import { chatAgentService } from '../chat-agent.service'
import { registerChunkTap, unregisterChunkTap } from '../../ipc/chat-shared'
import { modelConfigService, buildConversationModelSnapshot } from '../model-config.service'
import { omlxManager } from '../omlx-manager.service'
import { fixtureManager } from './fixture-manager'
import { getScenarioById, getImplementedScenarios, SCENARIO_CATALOG, stepText, stepAttachments, stepModeSwitch, stepAbortAfterMs, stepCompactAfter, stepSetEffort, stepSetTone, scenarioRequiresTools } from './scenario-catalog'
import { runAssertions } from './e2e-assertions'
import type { E2EScenario } from './scenario-catalog'
import type { StreamChunk } from '../index'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2ERunner')

const CHUNK_TAP_KEY = 'e2e-runner'

// ── Preflight ──

/** Preferred chat model for E2E testing — selected first when available in oMLX */
const PREFERRED_MODEL = 'qwen3.6:35b-a3b-coding-nvfp4'

/** Name-based heuristic for filtering out embedding models from /v1/models list */
const EMBEDDING_PATTERN = /\b(bge|e5[-_]|gte[-_]|ember|embedding|nomic[-_]embed|mxbai[-_]embed|snowflake|modernbert)/i

/**
 * Resolve the decrypted API key for the local LLM backend.
 * Uses a fallback chain:
 *   1. Explicit workspaceId → its settings
 *   2. Fixture workspace settings (key may have been copied on a prior run)
 *   3. Scan all workspaces for one with llmProvider=local-llm + localApiKey set (MRU first)
 */
function resolveApiKey(workspaceId?: string): string | undefined {
  // (1) Explicit workspace
  if (workspaceId) {
    const ws = workspaceRepository.findById(workspaceId)
    if (!ws) {
      log.warn('[preflight] workspaceId provided but workspace not found:', workspaceId)
    } else {
      try {
        const cfg = modelConfigService.getLocalLLMConfig(ws.repoPath)
        if (cfg.localApiKey) {
          log.info('[preflight] API key resolved from explicit workspace:', workspaceId)
          return cfg.localApiKey
        }
        log.info('[preflight] Explicit workspace has no localApiKey — trying fallback chain')
      } catch {
        log.warn('[preflight] getLocalLLMConfig failed for workspace:', workspaceId)
      }
    }
  } else {
    log.info('[preflight] No workspaceId provided — trying fallback chain')
  }

  // (2) Fixture workspace settings
  try {
    const fixturePath = fixtureManager.getFixturePath()
    const fixtureWs = workspaceRepository.findByPath(fixturePath)
    if (fixtureWs) {
      const fixtureSettings = workspaceRepository.getSettings(fixtureWs.id)
      if (fixtureSettings.localApiKey) {
        log.info('[preflight] API key resolved from fixture workspace')
        return fixtureSettings.localApiKey as string
      }
    }
  } catch {
    // Fixture path requires Electron app — skip in test environments
  }

  // (3) Scan workspaces (ordered by last_opened_at DESC)
  try {
    const allWorkspaces = workspaceRepository.findAll()
    for (const ws of allWorkspaces) {
      const settings = workspaceRepository.getSettings(ws.id)
      if (settings.llmProvider === 'local-llm' && settings.localApiKey) {
        log.info('[preflight] API key resolved from workspace scan:', ws.id, ws.name)
        return settings.localApiKey as string
      }
    }
  } catch {
    // DB may not be available in test environments
  }

  log.warn('[preflight] No API key found in any workspace — proceeding without key')
  return undefined
}

/**
 * Select a chat model from the oMLX status, filtering out embedding models.
 * Uses `modelType` from allModels (admin API) when available,
 * falls back to EMBEDDING_PATTERN name heuristic on the flat models list.
 */
function pickChatModel(status: { models: string[]; allModels?: { id: string; modelType: string; loaded: boolean }[] }): string | undefined {
  // 1. Check for preferred model first
  if (status.allModels?.length) {
    const preferred = status.allModels.find((m) => m.id === PREFERRED_MODEL)
    if (preferred) {
      log.info(`[pickChatModel] Using preferred model: ${PREFERRED_MODEL}`)
      return preferred.id
    }
  } else if (status.models.includes(PREFERRED_MODEL)) {
    log.info(`[pickChatModel] Using preferred model: ${PREFERRED_MODEL}`)
    return PREFERRED_MODEL
  }

  // 2. Prefer allModels (has modelType from admin API)
  if (status.allModels?.length) {
    const chatModels = status.allModels.filter(
      (m) => m.modelType !== 'embedding' && m.loaded
    )
    if (chatModels.length > 0) return chatModels[0].id
    // All loaded models are embeddings — check unloaded LLMs
    const unloadedChat = status.allModels.filter((m) => m.modelType !== 'embedding')
    if (unloadedChat.length > 0) return unloadedChat[0].id
  }

  // 3. Fallback: filter by name heuristic on flat models list
  const nonEmbedding = status.models.filter((id) => !EMBEDDING_PATTERN.test(id))
  return nonEmbedding.length > 0 ? nonEmbedding[0] : status.models[0]
}

export async function preflight(workspaceId?: string): Promise<E2EPreflightResult> {
  const baseUrl = `http://127.0.0.1:${OMLX_DEFAULT_PORT}`

  // Resolve API key via fallback chain
  const apiKey = resolveApiKey(workspaceId)

  try {
    // Reuse the battle-tested omlxManager (admin API first, /v1/models fallback)
    const status = await omlxManager.checkStatus(baseUrl, apiKey)

    if (!status.running) {
      return {
        ok: false,
        error: `Cannot connect to oMLX at 127.0.0.1:${OMLX_DEFAULT_PORT} — is it running?`
      }
    }

    // Check for auth issues from diagnostics
    if (status.diagnostics?.adminAuthRequired) {
      const detail = status.diagnostics.errorDetail
      // If we have no models at all, the 401 is blocking everything
      if (status.models.length === 0) {
        return {
          ok: false,
          error: detail ?? 'API key required or rejected by oMLX (401 Unauthorized)'
        }
      }
      // We got models via /v1/models but admin API 401'd — log but continue
      log.warn('[preflight] Admin API auth failed but /v1/models succeeded:', detail)
    }

    // Pick a chat model (G3: filter out embedding models)
    const modelId = pickChatModel(status)

    if (!modelId) {
      return {
        ok: false,
        error: 'oMLX is running but no chat models are loaded — load a model first'
      }
    }

    // Tool-capability probe: send a tiny tools-enabled completion to check structured tool_calls.
    // Default to true — only set false when we get a definitive negative response.
    // This avoids false-negatives from timeouts/cold-starts blocking legitimate tool scenarios.
    let supportsTools = true
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const probeBody = {
        model: modelId,
        messages: [
          { role: 'system', content: 'You must use the calculator tool to answer. Do not respond with text.' },
          { role: 'user', content: 'What is 2+2? Use the calculator tool.' }
        ],
        tools: [{
          type: 'function' as const,
          function: {
            name: 'calculator',
            description: 'A simple calculator that evaluates math expressions',
            parameters: {
              type: 'object',
              properties: { expression: { type: 'string', description: 'Math expression to evaluate' } },
              required: ['expression']
            }
          }
        }],
        tool_choice: 'auto',
        max_tokens: 1024,
        temperature: 0
      }

      const probeRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(60_000) // 60s — local models can be slow on first inference
      })

      if (probeRes.ok) {
        const probeJson = await probeRes.json() as {
          choices?: { message?: { tool_calls?: unknown[] } }[]
        }
        const toolCalls = probeJson.choices?.[0]?.message?.tool_calls
        supportsTools = Array.isArray(toolCalls) && toolCalls.length > 0
        log.info(`[preflight] Tool probe: supportsTools=${supportsTools}`, toolCalls ? `(${toolCalls.length} calls)` : '(none)')
      } else {
        log.warn(`[preflight] Tool probe HTTP ${probeRes.status} — assuming tools supported (optimistic)`)
      }
    } catch (err) {
      log.warn(`[preflight] Tool probe failed — assuming tools supported (optimistic):`, (err as Error).message)
    }

    log.info(`[preflight] OK — model: ${modelId}, supportsTools: ${supportsTools}, total models: ${status.models.length}`)
    return { ok: true, modelId, supportsTools }
  } catch (err) {
    const msg = (err as Error).message
    return {
      ok: false,
      error: `Cannot reach oMLX at ${baseUrl}: ${msg}`
    }
  }
}

// ── Runner Service ──

export class E2ERunnerService {
  private mainWindow: BrowserWindow | null = null
  private running = false
  private cancelled = false
  private currentAbort: (() => void) | null = null

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Run a set of scenarios (or all implemented if none specified).
   * Returns the run ID.
   */
  async run(opts?: {
    scenarioIds?: string[]
    category?: string
    workspaceId?: string
  }): Promise<string> {
    if (this.running) throw new Error('A test run is already in progress')

    // Preflight check — pass caller's workspace for API key resolution
    const sourceWorkspaceId = opts?.workspaceId
    const pf = await preflight(sourceWorkspaceId)
    if (!pf.ok) throw new Error(`oMLX preflight failed: ${pf.error}`)

    // Resolve scenarios
    let scenarios: E2EScenario[]
    if (opts?.scenarioIds?.length) {
      scenarios = opts.scenarioIds
        .map((id) => getScenarioById(id))
        .filter((s): s is E2EScenario => s != null && s.status === 'implemented')
    } else if (opts?.category) {
      scenarios = SCENARIO_CATALOG.filter(
        (s) => s.category === opts.category && s.status === 'implemented'
      )
    } else {
      scenarios = getImplementedScenarios()
    }

    if (scenarios.length === 0) throw new Error('No runnable scenarios found')

    // Copy API key settings from source workspace to fixture (encrypted, verbatim)
    let apiKeyFields: { localApiKey?: string; localApiKeyEncrypted?: boolean } | undefined
    if (sourceWorkspaceId) {
      const srcWs = workspaceRepository.findById(sourceWorkspaceId)
      if (srcWs) {
        const srcSettings = workspaceRepository.getSettings(sourceWorkspaceId)
        if (srcSettings.localApiKey) {
          apiKeyFields = {
            localApiKey: srcSettings.localApiKey as string,
            localApiKeyEncrypted: !!srcSettings.localApiKeyEncrypted
          }
        }
      }
    }

    // Ensure fixture workspace
    const workspace = await fixtureManager.ensureWorkspace(
      '127.0.0.1',
      OMLX_DEFAULT_PORT,
      pf.modelId ?? 'unknown',
      apiKeyFields
    )

    const workspaceId = workspace.id

    // Create run record
    const run = e2eTestRunRepository.create(workspaceId, pf.modelId ?? null, 'omlx')
    const results = e2eTestResultRepository.createMany(
      run.id,
      scenarios.map((s) => s.id)
    )

    this.running = true
    this.cancelled = false

    // Start sequential execution in background (pass supportsTools for auto-skip)
    this.executeQueue(run.id, scenarios, results.map((r) => r.id), workspace.id, pf.supportsTools ?? false).catch(
      (err) => {
        log.error('Run queue failed:', err)
        e2eTestRunRepository.updateStatus(run.id, 'completed')
        this.running = false
      }
    )

    return run.id
  }

  /**
   * Requeue failed/error scenarios from a previous run.
   * Prefer caller's workspaceId for key source; fall back to originalRun.workspaceId.
   */
  async requeueFailed(runId: string, workspaceId?: string): Promise<string> {
    const failedResults = e2eTestResultRepository.findFailedByRun(runId)
    if (failedResults.length === 0) throw new Error('No failed scenarios to requeue')

    const scenarioIds = failedResults.map((r) => r.scenarioId)

    // Get workspace from the original run as fallback
    const originalRun = e2eTestRunRepository.findById(runId)
    if (!originalRun) throw new Error(`Run ${runId} not found`)

    // Prefer caller's workspace for key resolution (G5)
    const effectiveWorkspaceId = workspaceId ?? originalRun.workspaceId

    return this.run({ scenarioIds, workspaceId: effectiveWorkspaceId })
  }

  /**
   * Cancel the current run.
   */
  cancel(): void {
    if (!this.running) return
    this.cancelled = true
    if (this.currentAbort) {
      this.currentAbort()
      this.currentAbort = null
    }
  }

  // ── Internal ──

  private async executeQueue(
    runId: string,
    scenarios: E2EScenario[],
    resultIds: string[],
    workspaceId: string,
    supportsTools: boolean
  ): Promise<void> {
    try {
      for (let i = 0; i < scenarios.length; i++) {
        if (this.cancelled) {
          // Mark remaining as skipped (including the in-flight one if it was running)
          for (let j = i; j < scenarios.length; j++) {
            const currentStatus = e2eTestResultRepository.findById(resultIds[j])
            // Mark running scenarios as skipped (cancel path)
            if (!currentStatus || currentStatus.status === 'queued' || currentStatus.status === 'running') {
              e2eTestResultRepository.updateStatus(resultIds[j], 'skipped')
            }
          }
          break
        }

        const scenario = scenarios[i]
        const resultId = resultIds[i]

        // Auto-skip tool-dependent scenarios when the model doesn't support structured tool_calls
        if (!supportsTools && scenarioRequiresTools(scenario)) {
          log.info(`[executeQueue] Skipping tool-dependent scenario ${scenario.id} — model does not emit structured tool_calls`)
          e2eTestResultRepository.updateStatus(resultId, 'skipped', {
            durationMs: 0,
            failureReason: 'Auto-skipped: model/backend does not emit structured tool_calls'
          })
          this.emitProgress(runId, scenario.id, 'skipped')
          continue
        }

        await this.executeScenario(runId, scenario, resultId, workspaceId)
      }
    } finally {
      // Compute totals and finalize run
      const counts = e2eTestResultRepository.countByStatus(runId)
      const finalStatus = this.cancelled ? 'cancelled' : 'completed'
      e2eTestRunRepository.updateStatus(
        runId,
        finalStatus,
        {
          passed: counts.passed,
          failed: counts.failed,
          skipped: counts.skipped,
          error: counts.error
        }
      )

      // Emit terminal progress event so the UI knows the run is finished (M10)
      this.emitProgress(runId, '__run_complete__', finalStatus === 'cancelled' ? 'skipped' : 'passed')

      this.running = false
      this.cancelled = false
      this.currentAbort = null
    }
  }

  private async executeScenario(
    runId: string,
    scenario: E2EScenario,
    resultId: string,
    workspaceId: string
  ): Promise<void> {
    const startTime = Date.now()
    e2eTestResultRepository.updateStatus(resultId, 'running')
    this.emitProgress(runId, scenario.id, 'running')

    let conversationId: string | null = null

    try {
      // Reset fixture
      await fixtureManager.resetFixture()

      // Build model config snapshot — frozen at creation time (M6)
      const snapshot = buildConversationModelSnapshot(workspaceId, 'local-llm')

      // Create conversation with snapshot (matches conversation-crud.ipc.ts pattern)
      const conversation = conversationRepository.create(
        workspaceId,
        `E2E: ${scenario.title}`,
        scenario.mode,
        undefined, // personaSpecialistId
        'local-llm', // llmProvider
        undefined, // mcpOverrides
        undefined, // communicationTone
        undefined, // type
        snapshot
      )
      conversationId = conversation.id

      // Initialize conversation specialist defaults
      conversationSpecialistRepository.initFromWorkspaceDefaults(conversation.id)

      // Execute prompts sequentially, collecting transcript
      const fullTranscript: E2ETranscriptEntry[] = []
      const fixturePath = fixtureManager.getFixturePath()

      for (const step of scenario.prompts) {
        const text = stepText(step)
        const attachmentRels = stepAttachments(step)
        const modeSwitch = stepModeSwitch(step)
        const abortAfterMs = stepAbortAfterMs(step)
        const compactAfter = stepCompactAfter(step)
        const effort = stepSetEffort(step)
        const tone = stepSetTone(step)

        // Apply mode switch before streaming (updates conversation mode)
        if (modeSwitch) {
          conversationRepository.updateMode(conversationId, modeSwitch)
        }

        // Apply effort level before streaming
        if (effort) {
          conversationRepository.updateEffort(conversationId, effort)
        }

        // Apply tone before streaming
        if (tone) {
          conversationRepository.updateTone(conversationId, tone === 'default' ? null : tone)
        }

        // Resolve attachment paths relative to fixture root
        const attachments = attachmentRels.length > 0
          ? attachmentRels.map((rel) => join(fixturePath, rel))
          : undefined

        const transcript = await this.streamPrompt(
          conversationId,
          text,
          scenario.timeoutMs,
          attachments,
          abortAfterMs
        )
        fullTranscript.push(...transcript)

        // Post-step compaction (invokes chatAgentService.compact())
        if (compactAfter) {
          try {
            await chatAgentService.compact(false)
            fullTranscript.push({
              role: 'system',
              type: 'status',
              content: 'compaction: ok',
              timestamp: Date.now()
            })
          } catch (err) {
            fullTranscript.push({
              role: 'system',
              type: 'status',
              content: `compaction: failed — ${(err as Error).message}`,
              timestamp: Date.now()
            })
          }
        }
      }

      // G4: Check cancellation after prompts — mark skipped, not failed
      if (this.cancelled) {
        e2eTestResultRepository.updateStatus(resultId, 'skipped', {
          durationMs: Date.now() - startTime,
          transcriptJson: fullTranscript,
          conversationId: conversationId ?? undefined
        })
        this.emitProgress(runId, scenario.id, 'skipped')
        return
      }

      // Run assertions
      const assertionResults = runAssertions(scenario.assertions, fullTranscript)
      const allPassed = assertionResults.every((a) => a.passed)

      const status: E2EResultStatus = allPassed ? 'passed' : 'failed'
      const failureReason = allPassed
        ? null
        : assertionResults
            .filter((a) => !a.passed)
            .map((a) => `${a.name}: ${a.reason}`)
            .join('; ')

      e2eTestResultRepository.updateStatus(resultId, status, {
        durationMs: Date.now() - startTime,
        failureReason: failureReason ?? undefined,
        assertionResults,
        transcriptJson: fullTranscript,
        conversationId: conversationId ?? undefined
      })

      this.emitProgress(runId, scenario.id, status)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error(`Scenario ${scenario.id} error:`, errMsg)

      e2eTestResultRepository.updateStatus(resultId, 'error', {
        durationMs: Date.now() - startTime,
        failureReason: errMsg,
        conversationId: conversationId ?? undefined
      })

      this.emitProgress(runId, scenario.id, 'error')
    }
  }

  private async streamPrompt(
    conversationId: string,
    text: string,
    timeoutMs: number,
    attachments?: string[],
    abortAfterMs?: number
  ): Promise<E2ETranscriptEntry[]> {
    const transcript: E2ETranscriptEntry[] = []

    // Add user prompt to transcript
    transcript.push({
      role: 'user',
      type: 'text',
      content: text,
      timestamp: Date.now()
    })

    let handle: { abort: () => void; done: Promise<void>; requestId?: string } | null = null
    let ourRequestId: string | undefined
    let abortTimerId: ReturnType<typeof setTimeout> | undefined
    let firstTextSeen = false

    // Register chunk tap — filter by requestId to avoid cross-talk (M8)
    registerChunkTap(CHUNK_TAP_KEY, (requestId: string | undefined, chunk: StreamChunk) => {
      // Drop chunks from other requests if both IDs are known
      if (requestId && ourRequestId && requestId !== ourRequestId) return
      const entry = chunkToTranscriptEntry(chunk)
      if (entry) transcript.push(entry)

      // Abort timer: fire N ms after the first text chunk arrives
      if (abortAfterMs && !firstTextSeen && chunk.type === 'text') {
        firstTextSeen = true
        abortTimerId = setTimeout(() => {
          if (handle) {
            log.info(`[streamPrompt] abortAfterMs=${abortAfterMs} triggered — aborting stream`)
            handle.abort()
          }
        }, abortAfterMs)
      }
    })

    // ask_user auto-responder: answer any ask_user question so the stream doesn't hang.
    // The ask_user tool_use chunk still lands in the transcript for assertion.
    const ASK_USER_DELAY_MS = 500
    const onAskQuestion = (data: {
      questions?: { question: string }[]
      action?: string
      requestId?: string
    }): void => {
      if (data.requestId) {
        log.info(`[streamPrompt] ask_user auto-responder: answering requestId=${data.requestId}`)
        setTimeout(() => {
          chatAgentService.respondToAskUser(
            data.requestId!,
            'Option A — proceed with the first option.'
          )
        }, ASK_USER_DELAY_MS)
      }
    }
    chatAgentService.on('askQuestion', onAskQuestion)

    // G6: declare timer outside try so finally can clear it
    let timerId: ReturnType<typeof setTimeout> | undefined

    try {
      // Start the stream (with optional attachments for vision scenarios)
      handle = await chatStreamService.stream(conversationId, text, attachments)
      ourRequestId = handle.requestId
      this.currentAbort = () => handle!.abort()

      // Race: stream completion vs timeout (G6: clear timer to avoid leak)
      const GRACE_MS = 5_000
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timerId = setTimeout(() => resolve('timeout'), timeoutMs)
      })

      const result = await Promise.race([handle.done.then(() => 'done' as const), timeoutPromise])

      if (result === 'timeout') {
        // Abort the stream before rejecting so the lock disposer runs
        handle.abort()
        // Wait briefly for the abort to settle and release the stream lock
        await Promise.race([
          handle.done.catch(() => {}),
          new Promise<void>((r) => setTimeout(r, GRACE_MS))
        ])

        transcript.push({
          role: 'system',
          type: 'error',
          content: `Prompt timed out after ${timeoutMs}ms`,
          timestamp: Date.now()
        })
      }
    } catch (err) {
      // Don't throw — capture the error in transcript and return
      transcript.push({
        role: 'system',
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
        timestamp: Date.now()
      })
    } finally {
      if (timerId !== undefined) clearTimeout(timerId)
      if (abortTimerId !== undefined) clearTimeout(abortTimerId)
      unregisterChunkTap(CHUNK_TAP_KEY)
      chatAgentService.off('askQuestion', onAskQuestion)
      this.currentAbort = null
    }

    return transcript
  }

  private emitProgress(runId: string, scenarioId: string, status: E2EResultStatus): void {
    if (!this.mainWindow?.isDestroyed()) {
      const counts = e2eTestResultRepository.countByStatus(runId)
      const total = Object.values(counts).reduce((a, b) => a + b, 0)

      const event: E2EProgressEvent = {
        runId,
        scenarioId,
        status,
        counts: {
          ...counts,
          running: counts.running ?? 0,
          total
        }
      }

      this.mainWindow?.webContents.send(IPC_CHANNELS.TESTING_PROGRESS, event)
    }
  }
}

// ── Chunk-to-Transcript Mapper ──

function chunkToTranscriptEntry(chunk: StreamChunk): E2ETranscriptEntry | null {
  const now = Date.now()

  switch (chunk.type) {
    case 'text':
      return {
        role: 'assistant',
        type: 'text',
        content: chunk.content ?? '',
        timestamp: now
      }
    case 'thinking':
      return {
        role: 'assistant',
        type: 'thinking',
        content: chunk.content ?? '',
        timestamp: now
      }
    case 'tool_use': {
      // StreamChunk has toolName/toolInput as optional strings
      let parsedArgs: Record<string, unknown> | undefined
      if (chunk.toolInput) {
        try { parsedArgs = JSON.parse(chunk.toolInput) } catch { /* ignore */ }
      }
      return {
        role: 'assistant',
        type: 'tool_use',
        toolName: chunk.toolName,
        toolArgs: parsedArgs,
        timestamp: now
      }
    }
    case 'tool_result':
      return {
        role: 'assistant',
        type: 'tool_result',
        toolName: chunk.toolName,
        toolResult: chunk.content ?? '',
        timestamp: now
      }
    case 'error':
      return {
        role: 'system',
        type: 'error',
        content: chunk.content ?? 'Unknown error',
        timestamp: now
      }
    case 'status':
      return {
        role: 'system',
        type: 'status',
        content: chunk.content ?? '',
        timestamp: now
      }
    case 'compact_boundary':
      return {
        role: 'system',
        type: 'status',
        content: 'compact_boundary: ' + (chunk.content ?? ''),
        timestamp: now
      }
    case 'context_usage_update':
      return {
        role: 'system',
        type: 'status',
        content: 'context_usage_update',
        timestamp: now
      }
    case 'permission_request':
      return {
        role: 'system',
        type: 'status',
        content: 'permission_request: ' + (chunk.toolName ?? 'unknown'),
        timestamp: now
      }
    case 'todo_update':
      return {
        role: 'system',
        type: 'status',
        content: 'todo_update',
        timestamp: now
      }
    case 'turn_boundary':
      return {
        role: 'system',
        type: 'status',
        content: 'turn_boundary',
        timestamp: now
      }
    default:
      // Generic fallback — map all remaining chunk types (tool_progress, subagent_*,
      // rate_limit, api_retry, files_persisted, hook_lifecycle, session_state,
      // auth_status, tool_use_summary, session_recovery, structured_output,
      // lsp_diagnostics, prompt_suggestion) to status entries.
      return {
        role: 'system',
        type: 'status',
        content: chunk.type + (chunk.toolName ? `: ${chunk.toolName}` : '') + (chunk.content ? ` — ${chunk.content.slice(0, 200)}` : ''),
        timestamp: now
      }
  }
}

// ── Singleton ──

export const e2eRunnerService = new E2ERunnerService()

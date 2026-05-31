/**
 * OpenCode Executor — multi-provider runtime via @opencode-ai/sdk.
 *
 * Uses OpenCode's client-server model to provide access to 75+ AI providers
 * through a single executor. OpenCode handles:
 *   - Provider routing (Anthropic, Ollama, oMLX, OpenAI, Gemini, etc.)
 *   - Agent loop (tool calling, reasoning, multi-turn)
 *   - MCP server connections (configure in opencode.json)
 *   - Session management (create, prompt, stream)
 *   - Structured output (JSON schema via `format` parameter)
 *
 * Architecture:
 *   Electron Main → OpenCodeExecutor → OpenCode Server (in-process) → Provider
 *   Same pattern OpenCode Desktop uses — proven Electron-compatible.
 *
 * Phase 4B — OpenCode Evaluation: Prototype executor backend.
 */

import type { StreamChunk } from './agent-base.service'
import type { ExecutorResult, ExecutorTokenUsage } from './executor-types'
import { normalizeOpenCodeEvent } from './opencode-event-normalizer'
import log from 'electron-log/main'

const openCodeLog = log.scope('OpenCodeExecutor')

// ── Types ──

/**
 * Provider configuration for OpenCode.
 * Maps to opencode.json "provider" section.
 */
export interface OpenCodeProviderConfig {
  /** Provider ID (e.g. 'anthropic', 'ollama', 'openai', 'custom') */
  providerId: string
  /** Model ID within the provider (e.g. 'claude-sonnet-4-6', 'qwen3-coder:30b') */
  modelId: string
  /** Base URL for custom/local providers */
  baseUrl?: string
  /** API key (if required by the provider) */
  apiKey?: string
}

/**
 * MCP server configuration for OpenCode.
 * Maps to opencode.json "mcp" section.
 */
export interface OpenCodeMcpConfig {
  /** Server name → stdio command config */
  servers: Record<
    string,
    {
      type: 'local'
      command: string[]
      env?: Record<string, string>
    }
  >
}

/**
 * Execute options for the OpenCode executor.
 */
export interface OpenCodeExecuteOptions {
  prompt: string
  systemPrompt: string
  provider: OpenCodeProviderConfig
  /** MCP servers to connect */
  mcpServers?: OpenCodeMcpConfig
  /** Working directory for the session */
  cwd: string
  /** Max turns for the agent loop */
  maxTurns?: number
  /** AbortController for cancellation */
  abortController?: AbortController
  /** JSON schema for structured output */
  outputSchema?: Record<string, unknown>
  /** Conversation ID for multi-turn session reuse */
  conversationId?: string
  /** A-1: Context parts to inject before the first prompt (priming). */
  primingContext?: Array<{ type: 'text'; text: string }>
}

/** Result metadata from OpenCode execution */
export interface OpenCodeExecuteResult extends ExecutorResult {
  /** OpenCode session ID */
  openCodeSessionId?: string
  /** Provider used for the response */
  providerId?: string
}

// ── Executor ──

/**
 * OpenCode executor — communicates with an in-process OpenCode server.
 *
 * Lifecycle:
 *   1. start() — initialize the OpenCode server + client
 *   2. execute() — stream a prompt through OpenCode's agent loop
 *   3. stop() — shut down the server
 *
 * The executor manages a single OpenCode server instance. Multiple
 * sessions can run concurrently through the same server.
 */
/** Transient error patterns that warrant retry with backoff */
const TRANSIENT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /overloaded/i,
  /server_is_overloaded/i,
  /too many requests/i,
  /503/,
  /429/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /network/i,
  /timeout/i
]

/** Max retry attempts for transient errors */
const MAX_TRANSIENT_RETRIES = 3

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = 2000

export class OpenCodeExecutor {
  // Store dynamic imports to handle ESM-only package
  private client: ReturnType<
    Awaited<ReturnType<typeof this.importSdk>>['createOpencodeClient']
  > | null = null
  private serverInstance: unknown | null = null
  private isStarted = false
  /** Map of conversationId → OpenCode session ID for multi-turn reuse */
  private readonly sessionMap = new Map<string, string>()
  /** Consecutive error count for circuit breaker integration */
  private consecutiveErrors = 0
  /** Max consecutive errors before circuit breaker trips */
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 5
  /** Health check polling interval (ms) */
  private static readonly HEALTH_CHECK_INTERVAL = 30_000
  /** Health check timer */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  /** Callback for health status changes */
  private onHealthChange?: (healthy: boolean, version?: string) => void
  /** MISS-2: Track child/subagent sessions — parent session ID → Set<child session IDs> */
  private readonly childSessions = new Map<string, Set<string>>()
  /** Last known cwd for auto-restart */
  private lastCwd?: string
  /** Last known config for auto-restart */
  private lastConfig?: Parameters<typeof this.start>[1]
  /** C-4: Promise that resolves when server.connected fires (MCP handshakes complete) */
  private serverReadyResolve?: () => void
  private serverReadyPromise?: Promise<void>

  /**
   * Start the OpenCode server in-process.
   *
   * This mirrors what OpenCode Desktop does — runs the server within
   * Electron's Node.js process for low-latency communication.
   */
  /** A-2: AbortController for cancelling startup if it hangs */
  private startupAbortController: AbortController | null = null

  async start(
    cwd: string,
    config?: {
      providers?: Record<string, { baseUrl?: string; apiKey?: string }>
      mcpServers?: OpenCodeMcpConfig
      /** Path to the opencode.json config file (now in temp dir) */
      configPath?: string
      /** Whether this is a local LLM provider (longer timeout) */
      isLocal?: boolean
    }
  ): Promise<void> {
    if (this.isStarted) {
      openCodeLog.info('[opencode] Server already running')
      return
    }

    try {
      const { createOpencode } = await this.importSdk()

      openCodeLog.info(`[opencode] Starting server in ${cwd}`)

      // Set OPENCODE_CONFIG env var so OpenCode reads from the temp dir
      // instead of looking for opencode.json in the workspace root.
      if (config?.configPath) {
        process.env.OPENCODE_CONFIG = config.configPath
      }

      // ENH-3: Enable experimental LSP tool (goToDefinition, findReferences, etc.)
      process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = 'true'

      // E-9: Enable web search/fetch tools when configured
      // The actual tool availability is controlled by the tools config in opencode.json;
      // this env var is the global gate required by OpenCode's privacy model.
      if (process.env.CODE_ATELIER_WEB_SEARCH === 'true') {
        process.env.OPENCODE_ENABLE_EXA = 'true'
      }

      // A-2: Pass timeout and signal for startup cancellation.
      // Local models (Ollama/oMLX) may need 30s+ to cold-start.
      this.startupAbortController = new AbortController()
      const startupTimeout = config?.isLocal ? 30_000 : 10_000

      const result = await createOpencode({
        cwd,
        timeout: startupTimeout,
        signal: this.startupAbortController.signal
      })

      this.client = result.client as typeof this.client
      this.serverInstance = result
      this.isStarted = true

      // C-4: Set up serverReady promise — resolved when server.connected event fires.
      // This gates the first prompt to ensure MCP handshakes are complete.
      this.serverReadyPromise = new Promise<void>((resolve) => {
        this.serverReadyResolve = resolve
        // Timeout fallback — don't block forever if event never fires
        setTimeout(() => {
          if (this.serverReadyResolve) {
            openCodeLog.warn(
              '[opencode] server.connected not received within 10s — proceeding anyway'
            )
            this.serverReadyResolve()
            this.serverReadyResolve = undefined
          }
        }, 10_000)
      })

      // Store restart context for auto-recovery
      this.lastCwd = cwd
      this.lastConfig = config

      openCodeLog.info('[opencode] Server started successfully')
    } catch (error) {
      openCodeLog.error('[opencode] Failed to start server:', error)
      throw error
    }
  }

  /**
   * Execute a prompt through OpenCode's agent loop.
   * Streams events as StreamChunks for UI display.
   *
   * #3: Includes transient error detection with exponential backoff retry.
   * Circuit breaker trips after MAX consecutive errors across interactions.
   */
  async *execute(
    options: OpenCodeExecuteOptions
  ): AsyncGenerator<StreamChunk & { _meta?: OpenCodeExecuteResult }> {
    if (!this.client || !this.isStarted) {
      yield { type: 'error', error: 'OpenCode server not started — call start() first' }
      return
    }

    // #3: Circuit breaker check — prevent repeated failures from hammering the provider
    if (this.consecutiveErrors >= OpenCodeExecutor.CIRCUIT_BREAKER_THRESHOLD) {
      yield {
        type: 'error',
        error:
          `OpenCode circuit breaker open: ${this.consecutiveErrors} consecutive errors. ` +
          `The provider may be down. Please try again later or switch providers.`
      }
      return
    }

    const { prompt, systemPrompt, provider, abortController, outputSchema } = options

    const tokenUsage: ExecutorTokenUsage = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    }

    let openCodeSessionId: string | undefined
    let resultText = ''

    try {
      // C-4: Wait for server.connected before first prompt to ensure MCP handshakes complete
      if (this.serverReadyPromise) {
        await this.serverReadyPromise
        this.serverReadyPromise = undefined
      }

      // Reuse existing session for multi-turn conversations, or create a new one
      const conversationId = options.conversationId
      if (conversationId) {
        openCodeSessionId = this.sessionMap.get(conversationId)
      }

      if (!openCodeSessionId) {
        // Create a new session
        const session = await this.client.session.create({
          body: { title: `Code Atelier: ${new Date().toISOString()}` }
        })
        openCodeSessionId = session.data?.id

        if (!openCodeSessionId) {
          yield { type: 'error', error: 'Failed to create OpenCode session' }
          return
        }

        // Track for multi-turn reuse
        if (conversationId) {
          this.sessionMap.set(conversationId, openCodeSessionId)
        }

        openCodeLog.info(
          `[opencode] Session ${openCodeSessionId} created — provider=${provider.providerId}/${provider.modelId}`
        )

        // A-1: Prime the session with workspace context before the first real prompt.
        // Uses noReply: true so the context is injected without triggering an AI response.
        if (options.primingContext && options.primingContext.length > 0) {
          await this.primeSession(openCodeSessionId, options.primingContext)
        }
      } else {
        openCodeLog.info(
          `[opencode] Reusing session ${openCodeSessionId} for conversation=${conversationId}`
        )
      }

      // Subscribe to events for streaming
      const events = await this.client.event.subscribe()

      // Send the prompt (non-blocking — events come via the stream)
      // D-1: System prompt is now injected via the plugin’s
      // experimental.chat.system.transform hook into the real system prompt
      // position — no longer prepended as a user message part. The hook reads
      // from CODE_ATELIER_SYSTEM_PROMPT_FILE (written by the config writer).
      // We only fall back to user-message injection if no plugin is loaded.
      const parts: Array<Record<string, unknown>> = []
      const hasPluginSystemPromptHook = !!process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
      if (systemPrompt && !hasPluginSystemPromptHook) {
        // Fallback: inject as user message when plugin hook is not available
        parts.push({ type: 'text', text: `[System Instructions]\n${systemPrompt}` })
      }
      parts.push({ type: 'text', text: prompt })

      const promptBody: Record<string, unknown> = {
        parts,
        model: {
          providerID: provider.providerId,
          modelID: provider.modelId
        }
      }

      // Add structured output schema if provided
      // ENH-10: Include retry config so OpenCode auto-retries on invalid JSON
      if (outputSchema) {
        promptBody.format = {
          type: 'json_schema',
          schema: outputSchema,
          retries: 2
        }
      }

      // ENH-13: Update session title with meaningful content from the user's prompt
      const titleText = prompt.slice(0, 80).replace(/\n/g, ' ').trim()
      const sessionTitle = titleText.length < prompt.length ? `${titleText}…` : titleText
      this.client.session
        .update?.({
          path: { id: openCodeSessionId },
          body: { title: sessionTitle }
        })
        ?.catch(() => {
          // Non-critical — session title is cosmetic
        })

      // Fire and forget the prompt — events come via SSE
      this.client.session
        .prompt({
          path: { id: openCodeSessionId },
          body: promptBody
        })
        .catch((err) => {
          openCodeLog.error('[opencode] Prompt send error:', err)
        })

      // Stream events → StreamChunks
      let turnCount = 0
      let maxTurnsReached = false
      const maxTurns = options.maxTurns ?? 0 // 0 = unlimited
      let transientRetryCount = 0

      if (events.stream) {
        for await (const event of events.stream) {
          if (abortController?.signal.aborted) break

          const chunks = this.normalizeEvent(event, openCodeSessionId, tokenUsage)
          for (const chunk of chunks) {
            if (chunk.type === 'text' && chunk.content) {
              resultText += chunk.content
            }

            // #3: Handle transient errors with retry
            if (chunk.type === 'error' && chunk.error && this.isTransientError(chunk.error)) {
              if (transientRetryCount < MAX_TRANSIENT_RETRIES) {
                transientRetryCount++
                const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, transientRetryCount - 1)
                openCodeLog.info(
                  `[opencode] Transient error detected, retrying in ${delayMs}ms ` +
                    `(attempt ${transientRetryCount}/${MAX_TRANSIENT_RETRIES}): ${chunk.error}`
                )

                // Emit recovery progress to the UI
                yield {
                  type: 'session_recovery',
                  recoveryPhase: 'started',
                  content: `Transient error detected — retrying in ${Math.round(delayMs / 1000)}s (attempt ${transientRetryCount}/${MAX_TRANSIENT_RETRIES})`
                } as StreamChunk

                await new Promise((r) => setTimeout(r, delayMs))

                // Re-send the prompt
                this.client!.session.prompt({
                  path: { id: openCodeSessionId! },
                  body: promptBody
                }).catch((err) => {
                  openCodeLog.error('[opencode] Retry prompt error:', err)
                })

                yield {
                  type: 'session_recovery',
                  recoveryPhase: 'resuming',
                  content: `Retry ${transientRetryCount} in progress...`
                } as StreamChunk

                continue
              }
              // Max retries exhausted — fall through to emit the error
              this.consecutiveErrors++
              openCodeLog.warn(
                `[opencode] Max transient retries exhausted (${this.consecutiveErrors} consecutive errors)`
              )
            }

            // Count tool invocations as turns
            if (chunk.type === 'tool_use') {
              turnCount++
              if (maxTurns > 0 && turnCount >= maxTurns) {
                openCodeLog.info(
                  `[opencode] maxTurns reached (${turnCount}/${maxTurns}) — aborting session`
                )
                maxTurnsReached = true
                if (this.client) {
                  this.client.session.abort({ path: { id: openCodeSessionId } }).catch(() => {})
                }
              }
            }

            yield chunk
          }

          if (maxTurnsReached) break

          // Check for session completion — skip error-based termination during active retries
          const retriesAvailable = transientRetryCount < MAX_TRANSIENT_RETRIES
          if (this.isSessionComplete(event, openCodeSessionId, retriesAvailable)) {
            break
          }
        }
      }

      // Success — reset consecutive error counter
      this.consecutiveErrors = 0

      // Final status
      yield {
        type: 'status',
        content: 'complete',
        _meta: {
          result: resultText || undefined,
          tokenUsage,
          openCodeSessionId,
          providerId: provider.providerId,
          terminalReason: maxTurnsReached ? 'max_turns' : 'completed'
        }
      } as StreamChunk & { _meta: OpenCodeExecuteResult }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        openCodeLog.info('[opencode] Request aborted')
        if (openCodeSessionId && this.client) {
          this.client.session.abort({ path: { id: openCodeSessionId } }).catch(() => {})
        }
      } else {
        this.consecutiveErrors++
        openCodeLog.error(
          `[opencode] Execution error (consecutive=${this.consecutiveErrors}):`,
          error
        )
        yield { type: 'error', error: `OpenCode error: ${(error as Error).message}` }
      }
    }
  }

  /**
   * Stop the OpenCode server and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return

    // A-2: Cancel any in-progress startup
    if (this.startupAbortController) {
      this.startupAbortController.abort()
      this.startupAbortController = null
    }

    this.stopHealthCheck()
    openCodeLog.info('[opencode] Stopping server')
    this.client = null
    this.serverInstance = null
    this.isStarted = false
    this.sessionMap.clear()
    this.consecutiveErrors = 0
  }

  /**
   * MISS-14: Check if the OpenCode server is healthy.
   * Calls global.health() and returns version info or null if unhealthy.
   */
  async checkHealth(): Promise<{ healthy: boolean; version?: string }> {
    if (!this.client || !this.isStarted) {
      return { healthy: false }
    }
    try {
      const result = await (
        this.client as Record<string, unknown> & typeof this.client
      ).global?.health?.()
      const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined
      return {
        healthy: true,
        version: data?.version as string | undefined
      }
    } catch (err) {
      openCodeLog.warn(`[opencode] Health check failed: ${(err as Error).message}`)
      return { healthy: false }
    }
  }

  /**
   * MISS-14: Start periodic health monitoring.
   * Polls global.health() and attempts auto-restart on failure.
   *
   * @param onHealthChange - Callback when health state transitions
   */
  startHealthCheck(onHealthChange?: (healthy: boolean, version?: string) => void): void {
    this.stopHealthCheck()
    this.onHealthChange = onHealthChange

    let wasHealthy = true
    let consecutiveFailures = 0

    this.healthCheckTimer = setInterval(async () => {
      const { healthy, version } = await this.checkHealth()

      if (healthy) {
        if (!wasHealthy) {
          openCodeLog.info(`[opencode] Server recovered (version: ${version ?? 'unknown'})`)
          this.onHealthChange?.(true, version)
        }
        wasHealthy = true
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        openCodeLog.warn(`[opencode] Health check failed (${consecutiveFailures} consecutive)`)

        if (wasHealthy) {
          this.onHealthChange?.(false)
          wasHealthy = false
        }

        // Attempt auto-restart after 3 consecutive failures
        if (consecutiveFailures >= 3 && this.lastCwd) {
          openCodeLog.info('[opencode] Attempting auto-restart after 3 health check failures')
          try {
            await this.stop()
            await this.start(this.lastCwd, this.lastConfig)
            this.onHealthChange?.(true)
            consecutiveFailures = 0
            wasHealthy = true
          } catch (err) {
            openCodeLog.error('[opencode] Auto-restart failed:', err)
          }
        }
      }
    }, OpenCodeExecutor.HEALTH_CHECK_INTERVAL)
  }

  /**
   * Stop the health check polling.
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  /**
   * MISS-2: Get tracked child session IDs for a parent session.
   */
  getChildSessions(parentSessionId: string): string[] {
    return Array.from(this.childSessions.get(parentSessionId) ?? [])
  }

  /**
   * MISS-2: Query the server for child sessions (may include sessions
   * created before we started tracking).
   */
  async fetchChildSessions(sessionId: string): Promise<Array<{ id: string; status?: string }>> {
    if (!this.client) return []
    try {
      const result = await (this.client.session as Record<string, unknown>)['children']?.({
        path: { id: sessionId }
      })
      const children =
        ((result as Record<string, unknown>)?.data as Array<Record<string, unknown>>) ?? []
      return children.map((c) => ({
        id: c.id as string,
        status: c.status as string | undefined
      }))
    } catch (err) {
      openCodeLog.warn(`[opencode] Failed to fetch child sessions: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * MISS-7: Validate that our agent definitions loaded correctly in OpenCode.
   * Returns the list of available agents and flags any that failed to load.
   */
  async validateAgents(): Promise<{
    agents: Array<{ name: string; model?: string; mode?: string }>
    missingExpected: string[]
  }> {
    if (!this.client) return { agents: [], missingExpected: ['DaVinci'] }
    try {
      const result = await (
        this.client as Record<string, unknown> & typeof this.client
      ).app?.agents?.()
      const agentList =
        ((result as Record<string, unknown>)?.data as Array<Record<string, unknown>>) ?? []
      const agents = agentList.map((a) => ({
        name: a.name as string,
        model: a.model as string | undefined,
        mode: a.mode as string | undefined
      }))

      // Check that our expected agents are present
      const agentNames = new Set(agents.map((a) => a.name))
      // B-1: Include Grill and Audit subagents in expected list
      const expectedAgents = ['DaVinci', 'Grill', 'Audit']
      const missingExpected = expectedAgents.filter((name) => !agentNames.has(name))

      if (missingExpected.length > 0) {
        openCodeLog.warn(`[opencode] Missing expected agents: ${missingExpected.join(', ')}`)
      } else {
        openCodeLog.info(
          `[opencode] Agent validation passed: ${agents.map((a) => a.name).join(', ')}`
        )
      }

      return { agents, missingExpected }
    } catch (err) {
      openCodeLog.warn(`[opencode] Agent validation failed: ${(err as Error).message}`)
      return { agents: [], missingExpected: ['DaVinci'] }
    }
  }

  /**
   * Clear a specific session mapping (e.g. on conversation switch or error).
   */
  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
  }

  /**
   * Get the OpenCode session ID for a conversation (if any).
   */
  getSessionId(conversationId: string): string | undefined {
    return this.sessionMap.get(conversationId)
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.isStarted
  }

  /**
   * E-4/B-4: Prime a session with context using noReply: true.
   *
   * Injects workspace context (git changes, plan state, memory context) into
   * the session without triggering an AI response. This is cleaner than
   * prepending context as text parts in the actual prompt.
   *
   * B-4: Also uses session.shell() to gather git context within the session
   * context naturally, without consuming a tool turn.
   *
   * Call this after session creation but before the first real prompt.
   */
  async primeSession(
    sessionId: string,
    contextParts: Array<{ type: 'text'; text: string }>
  ): Promise<void> {
    if (!this.client || !contextParts.length) return

    try {
      // 6E-2: Try file.status() first for structured uncommitted changes.
      // Falls back to session.shell() git command if unavailable.
      let usedFileStatus = false
      try {
        const fileStatus = await this.client.file.status({})
        if (fileStatus.data && fileStatus.data.length > 0) {
          const statusLines = fileStatus.data
            .map((f: { status: string; path: string }) => `  ${f.status} ${f.path}`)
            .join('\n')
          const gitIdx = contextParts.findIndex((p) =>
            p.text.includes('[Workspace Context: Recent Changes]')
          )
          if (gitIdx >= 0) {
            contextParts[gitIdx] = {
              type: 'text',
              text: `[Workspace Context: Uncommitted Changes]\n${statusLines}`
            }
            usedFileStatus = true
          }
        }
      } catch {
        // file.status() not available — fall through to shell
      }

      // B-4: Use session.shell() for git context if file.status() didn't work
      if (!usedFileStatus) {
        try {
          const gitResult = await this.client.session.shell({
            path: { id: sessionId },
            body: { command: 'git diff --stat HEAD~3 2>/dev/null || echo "(no recent commits)"' }
          })
          if (gitResult.data?.stdout && gitResult.data.stdout.trim().length > 10) {
            const gitIdx = contextParts.findIndex((p) =>
              p.text.includes('[Workspace Context: Recent Changes]')
            )
            if (gitIdx >= 0) {
              contextParts[gitIdx] = {
                type: 'text',
                text: `[Workspace Context: Recent Changes (live)]\n${gitResult.data.stdout.trim()}`
              }
            }
          }
        } catch {
          // session.shell() not available or failed — fall back to static context parts
        }
      }

      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: contextParts,
          noReply: true
        }
      })
      openCodeLog.info(
        `[opencode] Session ${sessionId} primed with ${contextParts.length} context parts`
      )
    } catch (err) {
      // Non-fatal — priming failure shouldn't block the real prompt
      openCodeLog.warn(`[opencode] Session priming failed: ${(err as Error).message}`)
    }
  }

  /**
   * #2: Abort a running session. Called from cancelCurrentQuery().
   */
  async abortSession(sessionId: string): Promise<void> {
    if (!this.client) return
    await this.client.session.abort({ path: { id: sessionId } })

    // 6E-3: Cascade cancellation to child/subagent sessions.
    // Prevents orphaned sessions from burning tokens after parent abort.
    const children = this.childSessions.get(sessionId)
    if (children && children.size > 0) {
      for (const childId of children) {
        try {
          await this.client.session.abort({ path: { id: childId } })
          openCodeLog.info(`[opencode] Cascaded abort to child session ${childId}`)
        } catch {
          // Child may already be done or deleted — non-fatal
        }
      }
    }

    openCodeLog.info(`[opencode] Session ${sessionId} aborted`)
  }

  /**
   * #1: Revert a session to a specific message (undo support).
   * Uses OpenCode's native session.revert() which preserves session history
   * and restores file snapshots — more reliable than creating a fresh session.
   */
  async revertSession(sessionId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('OpenCode server not started')
    await this.client.session.revert({
      path: { id: sessionId },
      body: { messageID: messageId }
    })
    openCodeLog.info(`[opencode] Session ${sessionId} reverted to message ${messageId}`)
  }

  /**
   * #1: Cancel a revert operation.
   */
  async unrevertSession(sessionId: string): Promise<void> {
    if (!this.client) throw new Error('OpenCode server not started')
    await this.client.session.unrevert({ path: { id: sessionId } })
    openCodeLog.info(`[opencode] Session ${sessionId} unrevert applied`)
  }

  /**
   * #11: Generate a human-readable summary of a session.
   */
  async summarizeSession(sessionId: string): Promise<string | undefined> {
    if (!this.client) throw new Error('OpenCode server not started')
    const result = await this.client.session.summarize({ path: { id: sessionId } })
    return (result as Record<string, unknown>)?.data as string | undefined
  }

  /**
   * MISS-1: Execute a slash command within a session.
   * Wraps session.command() for commands like /compact, /share, /init, /undo, /redo.
   */
  async executeCommand(
    sessionId: string,
    command: string,
    args?: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.client) return { success: false, error: 'OpenCode server not started' }
    try {
      const result = await (this.client.session as Record<string, unknown>)['command']?.({
        path: { id: sessionId },
        body: { command, args }
      })
      openCodeLog.info(`[opencode] Command /${command} executed on session ${sessionId}`)
      return { success: true, data: (result as Record<string, unknown>)?.data }
    } catch (err) {
      openCodeLog.error(`[opencode] Command /${command} failed:`, err)
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * MISS-1: Convenience wrappers for common commands.
   */
  async compactSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return this.executeCommand(sessionId, 'compact')
  }

  async shareSession(
    sessionId: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    return this.executeCommand(sessionId, 'share')
  }

  async initProject(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return this.executeCommand(sessionId, 'init')
  }

  /**
   * GAP-17: Auto-compact when context usage exceeds a threshold.
   * Called by the normalizer when context_usage_update shows high usage.
   */
  async autoCompactIfNeeded(
    sessionId: string,
    percentage: number,
    threshold = 80
  ): Promise<boolean> {
    if (percentage < threshold) return false
    openCodeLog.info(
      `[opencode] Context usage ${percentage}% >= ${threshold}% — triggering auto-compact`
    )
    const result = await this.compactSession(sessionId)
    return result.success
  }

  /**
   * GAP-17: Switch the active agent via /agent command.
   * Useful for task-type-based agent switching (review → Grill, health → Audit).
   */
  async switchAgent(
    sessionId: string,
    agentName: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.executeCommand(sessionId, 'agent', agentName)
  }

  /**
   * GAP-17: Switch mode via /mode command.
   * Called when the user switches modes in our UI.
   */
  async switchMode(
    sessionId: string,
    mode: 'plan' | 'build' | 'danger'
  ): Promise<{ success: boolean; error?: string }> {
    return this.executeCommand(sessionId, 'mode', mode)
  }

  /**
   * GAP-24: Verify that the configured provider is available before the first prompt.
   * For local LLMs (Ollama), pings the health endpoint. For cloud providers, checks
   * that the provider appears in config.providers().
   * Returns a descriptive error string if the provider is down, or null if OK.
   */
  async verifyProvider(providerId: string, baseUrl?: string): Promise<string | null> {
    // For local providers (Ollama/oMLX), ping the health endpoint directly
    if (providerId === 'ollama') {
      const url = baseUrl ?? 'http://localhost:11434'
      try {
        const response = await fetch(`${url}/api/tags`, {
          signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) {
          return `Ollama is not responding (HTTP ${response.status}). Ensure Ollama is running at ${url}`
        }
      } catch {
        return `Cannot reach Ollama at ${url}. Is it running? Try: ollama serve`
      }
    } else if (providerId === 'omlx') {
      const url = baseUrl ?? 'http://localhost:8080'
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) {
          return `oMLX is not responding (HTTP ${response.status}). Ensure oMLX is running at ${url}`
        }
      } catch {
        return `Cannot reach oMLX at ${url}. Is it running?`
      }
    }

    // For all providers, verify via SDK if available
    if (this.client) {
      try {
        const providers = await this.getProviders()
        const found = providers.find((p) => p.id === providerId)
        if (!found) {
          return `Provider "${providerId}" not found. Available: ${providers.map((p) => p.id).join(', ') || 'none'}`
        }
      } catch {
        // Non-fatal — SDK may not be ready yet
      }
    }

    return null
  }

  /**
   * GAP-20: Pin a session for quick-switch access.
   * Keeps the active workspace session accessible even with many sessions.
   */
  async pinSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) return { success: false, error: 'OpenCode server not started' }
    try {
      await this.client.session.update({
        path: { id: sessionId },
        body: { pinned: true }
      })
      openCodeLog.info(`[opencode] Session ${sessionId} pinned`)
      return { success: true }
    } catch (err) {
      openCodeLog.warn(`[opencode] Failed to pin session: ${(err as Error).message}`)
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * MISS-8: Query available providers and their default models.
   * Can be used to auto-populate the model picker UI.
   */
  async getProviders(): Promise<Array<{ id: string; name?: string; defaultModel?: string }>> {
    if (!this.client) return []
    try {
      const result = await (
        this.client as Record<string, unknown> & typeof this.client
      ).config?.providers?.()
      const providers =
        ((result as Record<string, unknown>)?.data as Array<Record<string, unknown>>) ?? []
      return providers.map((p) => ({
        id: p.id as string,
        name: p.name as string | undefined,
        defaultModel: p.defaultModel as string | undefined
      }))
    } catch (err) {
      openCodeLog.warn(`[opencode] Failed to fetch providers: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * MISS-9: Retrieve all messages in a session for state reconciliation.
   */
  async getSessionMessages(
    sessionId: string
  ): Promise<Array<{ id: string; role: string; content?: string }>> {
    if (!this.client) return []
    try {
      const result = await (this.client.session as Record<string, unknown>)['messages']?.({
        path: { id: sessionId }
      })
      const messages =
        ((result as Record<string, unknown>)?.data as Array<Record<string, unknown>>) ?? []
      return messages.map((m) => ({
        id: m.id as string,
        role: m.role as string,
        content: m.content as string | undefined
      }))
    } catch (err) {
      openCodeLog.warn(`[opencode] Failed to fetch session messages: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * MISS-12: Respond to a permission request from the agent.
   * Called when the user approves/denies a tool use in the Electron UI.
   */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    allowed: boolean
  ): Promise<void> {
    if (!this.client) throw new Error('OpenCode server not started')
    try {
      await (this.client as Record<string, unknown> & typeof this.client).session[
        'postSessionByIdPermissionsByPermissionId'
      ]?.({
        path: { id: sessionId, permissionId },
        body: { allowed }
      })
      openCodeLog.info(
        `[opencode] Permission ${allowed ? 'granted' : 'denied'} for ${permissionId}`
      )
    } catch (err) {
      openCodeLog.error(`[opencode] Failed to respond to permission ${permissionId}:`, err)
      // Fallback: try the generic permission endpoint
      try {
        await (this.client.session as Record<string, unknown>)['permission']?.({
          path: { id: sessionId },
          body: { permissionId, allowed }
        })
      } catch (fallbackErr) {
        openCodeLog.error('[opencode] Permission fallback also failed:', fallbackErr)
        throw fallbackErr
      }
    }
  }

  /**
   * Expose the client instance for direct SDK calls (used by error recovery).
   */
  getClient(): typeof this.client {
    return this.client
  }

  // ── Private helpers ──

  /**
   * #3: Check if an error message indicates a transient/retriable condition.
   */
  private isTransientError(errorMessage: string): boolean {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  }

  /**
   * Reset the consecutive error counter (e.g. after a successful interaction).
   */
  resetCircuitBreaker(): void {
    this.consecutiveErrors = 0
  }

  /**
   * Dynamically import the ESM-only @opencode-ai/sdk.
   * Uses dynamic import() to work in our CJS-compiled Electron main process.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private async importSdk() {
    // Dynamic import for ESM package in CJS context
    return await import('@opencode-ai/sdk')
  }

  /**
   * Normalize an OpenCode SSE event into StreamChunks.
   * Delegates to the OpenCodeEventNormalizer dispatch table.
   */
  private normalizeEvent(
    event: unknown,
    sessionId: string,
    tokenUsage: ExecutorTokenUsage
  ): StreamChunk[] {
    return normalizeOpenCodeEvent(event, sessionId, tokenUsage, {
      childSessions: this.childSessions,
      sessionMap: this.sessionMap,
      serverReadyResolve: this.serverReadyResolve
    })
  }

  /**
   * Check if an event indicates the session has completed.
   *
   * @param retriesAvailable - When true, `session.error` events are NOT treated as
   *   terminal because the caller will retry the prompt. Only after retries are
   *   exhausted should an error event end the stream loop.
   */
  private isSessionComplete(event: unknown, sessionId: string, retriesAvailable = false): boolean {
    const evt = event as Record<string, unknown>
    const type = evt.type as string | undefined
    const properties = evt.properties as Record<string, unknown> | undefined

    if (!properties) return false
    const eventSessionId = properties.sessionID as string | undefined
    if (eventSessionId && eventSessionId !== sessionId) return false

    // session.idle means the agent loop is done
    if (type === 'session.idle') return true

    // session.error terminates only when no retries are available.
    // During active retries the error is handled by the retry logic above
    // and a new prompt is fired — we must NOT break the event loop.
    if (type === 'session.error') {
      if (retriesAvailable) {
        openCodeLog.info('[opencode] session.error suppressed — retries still available')
        return false
      }
      return true
    }

    // Check for status changes indicating completion
    if (type === 'session.status') {
      const status = properties.status as string | undefined
      if (status === 'idle') return true
      if (status === 'error' && !retriesAvailable) return true
    }

    return false
  }
}

/** Singleton instance */
export const openCodeExecutor = new OpenCodeExecutor()

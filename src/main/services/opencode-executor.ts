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
import type { OpencodeClient, SessionPromptData } from '@opencode-ai/sdk'
import type { ImageAttachment } from '../../shared/types'
import { normalizeOpenCodeEvent, type NormalizerState } from './opencode-event-normalizer'
import { ensureOpencodePathInEnv, getOpencodePath } from '../../shared/opencode-cli-path'
import log from 'electron-log/main'

const openCodeLog = log.scope('OpenCodeExecutor')

/** The subset of opencode.json this executor reads. */
interface OpenCodeConfigProviderEntry {
  options?: { baseURL?: string; apiKey?: string }
  npm?: string
}
interface OpenCodeConfigFile {
  provider?: Record<string, OpenCodeConfigProviderEntry>
  [key: string]: unknown
}

/** Error body returned by the OpenCode server on 4xx/5xx. */
interface OpenCodeErrorPayload {
  message?: string
  data?: { message?: string }
}

/** Node spawn/system error fields that aren't on the base Error type. */
type SpawnError = Error & {
  code?: string | number
  syscall?: string
  path?: string
  spawnargs?: string[]
}

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
  /** Image attachments to include with the prompt (vision) */
  images?: ImageAttachment[]
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

/** Default port used by the OpenCode SDK server */
const OPENCODE_SERVER_PORT = 4096

export class OpenCodeExecutor {
  // Store dynamic imports to handle ESM-only package
  private client: OpencodeClient | null = null
  /** Reference to the OpenCode server child process — needed for clean shutdown */
  private server: { url: string; close(): void } | null = null
  private isStarted = false
  /** Map of conversationId → OpenCode session ID for multi-turn reuse */
  private readonly sessionMap = new Map<string, string>()
  /** Consecutive error count for circuit breaker integration */
  private consecutiveErrors = 0
  /** In-flight transient-retry backoffs — a rising value signals a retry storm. */
  private retriesInFlight = 0
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
  /** EXEC-05: Track the serverReady fallback timeout so it can be cancelled */
  private serverReadyTimeout: ReturnType<typeof setTimeout> | null = null
  /** R6-A1: Persistent normalizer state — survives across events so dedupe sets,
   *  F16 lastPartType, and context-delta gating are preserved within a session. */
  private normalizerState: NormalizerState = {
    childSessions: this.childSessions,
    sessionMap: this.sessionMap
  }

  /**
   * Check if the OpenCode CLI is installed and available in PATH.
   * Returns an error message if CLI is not found, null if available.
   */
  async checkCliAvailable(): Promise<string | null> {
    try {
      const { execSync } = await import('node:child_process')

      // Use the cached resolved path (set at startup via resolveOpencodePath)
      const opencodePath = getOpencodePath()

      if (!opencodePath) {
        return (
          'OpenCode CLI not found. Install it by running:\n' +
          '  npm install -g @opencode-ai/cli\n' +
          'Or download from: https://opencode.ai/getting-started'
        )
      }

      // Try to get version
      const versionOutput = execSync('opencode --version', {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      }).trim()

      openCodeLog.info(
        `[opencode] checkCliAvailable: path=${opencodePath}, version=${versionOutput}`
      )

      // Non-empty version output confirms the binary is installed and executable.
      // (The output format varies across versions — e.g. "1.17.9" vs "opencode v1.x")
      if (versionOutput) {
        openCodeLog.info(`[opencode] CLI available at: ${opencodePath}, version: ${versionOutput}`)
        ensureOpencodePathInEnv()
        return null
      }

      return (
        'OpenCode CLI found but returned empty version output.\n' +
        'Try reinstalling: npm install -g @opencode-ai/cli'
      )
    } catch (err) {
      const errorMsg = `Failed to check OpenCode CLI availability: ${(err as Error).message}`
      openCodeLog.error('[opencode]', errorMsg)
      return errorMsg
    }
  }

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

    // Pre-check: Validate OpenCode CLI is installed
    const cliError = await this.checkCliAvailable()
    if (cliError) {
      const cliErr = new Error(cliError)
      openCodeLog.error('[opencode]', cliErr.message)
      throw cliErr
    }

    try {
      // T-1: Ensure opencode path is in PATH (uses cached value from startup)
      // The SDK uses cross-spawn which relies on PATH.
      ensureOpencodePathInEnv()
      openCodeLog.info(`[opencode] Starting server in ${cwd}`)
      openCodeLog.info(`[opencode] Current env.PATH: ${process.env.PATH?.slice(0, 600)}...`)

      // OC-01: Clear stale env vars from any prior workspace to prevent
      // cross-workspace contamination when start() is called without stop()
      delete process.env.OPENCODE_CONFIG
      delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL
      delete process.env.OPENCODE_ENABLE_EXA

      // OC-02: Read config content to pass inline via the SDK.
      // The SDK sets OPENCODE_CONFIG_CONTENT from options.config — if we don't pass it,
      // it defaults to "{}" which overrides any file-based OPENCODE_CONFIG.
      let configContent: OpenCodeConfigFile | undefined
      if (config?.configPath) {
        try {
          const { readFileSync } = await import('node:fs')
          configContent = JSON.parse(readFileSync(config.configPath, 'utf-8'))
          openCodeLog.info(`[opencode] Loaded config inline from ${config.configPath}`)
        } catch (err) {
          openCodeLog.warn(`[opencode] Failed to read config at ${config.configPath}:`, err)
        }
      }

      // OC-08: Log provider config summary for diagnostics (mask apiKey)
      if (configContent) {
        const providers = configContent.provider ?? {}
        for (const [provId, provConfig] of Object.entries(providers)) {
          const opts = provConfig?.options ?? {}
          openCodeLog.info(
            `[opencode] Config provider [${provId}]: ` +
              `baseURL=${opts.baseURL ?? '(none)'}, ` +
              `apiKey=${opts.apiKey ? '***' + String(opts.apiKey).slice(-3) : '(none)'}, ` +
              `npm=${provConfig?.npm ?? '(builtin)'}`
          )
        }
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

      // PORT-FIX: Kill any stale opencode server process that may hold the port
      // from a prior crash / ungraceful shutdown. Without this, createOpencode fails
      // with "ServeError" because port 4096 is already in use.
      await this.killStaleServer()

      // OC-05: Pre-install provider npm package if needed.
      // OpenCode auto-installs on first run, but this takes time and can cause
      // server.connected timeout. Pre-installing avoids the cold-start delay.
      // IMPORTANT: The .opencode/ directory is managed by the OpenCode server.
      // We must not create a conflicting package.json — just install into the
      // existing node_modules if the package is missing.
      if (configContent) {
        const providers = configContent.provider ?? {}
        for (const [provId, provConfig] of Object.entries(providers)) {
          const npmPkg = provConfig?.npm
          if (npmPkg) {
            const { join } = await import('node:path')
            const { existsSync } = await import('node:fs')
            const { execSync } = await import('node:child_process')
            const opencodeDir = join(cwd, '.opencode')
            const pkgDir = join(opencodeDir, 'node_modules', ...npmPkg.split('/'))
            if (!existsSync(pkgDir)) {
              openCodeLog.info(`[opencode] Pre-installing ${npmPkg} for provider ${provId}...`)
              try {
                // Install into the existing .opencode/ dir managed by the OpenCode server.
                // Use --save so the package persists in the existing package.json dependency tree.
                execSync(`npm install ${npmPkg} --prefix "${opencodeDir}"`, {
                  timeout: 30_000,
                  stdio: 'pipe',
                  cwd: opencodeDir,
                  windowsHide: true
                })
                openCodeLog.info(`[opencode] Pre-installed ${npmPkg} successfully`)
              } catch (err) {
                openCodeLog.warn(`[opencode] Failed to pre-install ${npmPkg}:`, err)
                // Non-fatal — server may still auto-install
              }
            } else {
              openCodeLog.info(`[opencode] ${npmPkg} already installed for provider ${provId}`)
            }
          }
        }
      }

      openCodeLog.info(
        `[opencode] Calling createOpencode with port ${OPENCODE_SERVER_PORT}, timeout ${startupTimeout}ms`
      )

      // Import the SDK to get createOpencode function
      const { createOpencode } = await import('@opencode-ai/sdk')

      // OC-04: Set CWD to workspace so opencode serve inherits the correct project directory.
      // The SDK's createOpencodeServer() doesn't support a `cwd` option, and `opencode serve`
      // doesn't support `--project`. The child process CWD is determined at spawn time.
      const originalCwd = process.cwd()
      process.chdir(cwd)
      openCodeLog.info(`[opencode] Set CWD to workspace: ${cwd}`)

      // OC-09: Isolate from global opencode config to prevent personal MCP servers
      // (e.g. ~/.config/opencode/opencode.json registering a "pencil" MCP) from
      // leaking into sessions. Point XDG_CONFIG_HOME at an empty app-controlled
      // directory so the opencode binary's global config resolves clean.
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { mkdirSync } = await import('node:fs')
      const isolatedConfigHome = join(tmpdir(), 'agentstudio-opencode-xdg')
      mkdirSync(join(isolatedConfigHome, 'opencode'), { recursive: true })
      const savedXdgConfigHome = process.env.XDG_CONFIG_HOME
      process.env.XDG_CONFIG_HOME = isolatedConfigHome
      openCodeLog.info(
        `[opencode] Set XDG_CONFIG_HOME=${isolatedConfigHome} (was ${savedXdgConfigHome ?? 'unset'})`
      )

      // OC-10: Force XDG_DATA_HOME to temp dir so the opencode SQLite database
      // lives alongside the config — e2e-runner can reliably clean it.
      const savedXdgDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = isolatedConfigHome
      openCodeLog.info(
        `[opencode] Set XDG_DATA_HOME=${isolatedConfigHome} (was ${savedXdgDataHome ?? 'unset'})`
      )

      let result: Awaited<ReturnType<typeof createOpencode>>
      try {
        result = await createOpencode({
          port: OPENCODE_SERVER_PORT,
          timeout: startupTimeout,
          signal: this.startupAbortController.signal,
          // OC-02: Pass config inline so the SDK sets OPENCODE_CONFIG_CONTENT correctly.
          // Without this, the SDK defaults to "{}" which the server prioritizes over file-based config.
          ...(configContent ? { config: configContent as Record<string, unknown> } : {})
        })
      } finally {
        process.chdir(originalCwd)
        // Restore XDG_CONFIG_HOME so the Electron main process is unaffected
        if (savedXdgConfigHome !== undefined) {
          process.env.XDG_CONFIG_HOME = savedXdgConfigHome
        } else {
          delete process.env.XDG_CONFIG_HOME
        }
        if (savedXdgDataHome !== undefined) {
          process.env.XDG_DATA_HOME = savedXdgDataHome
        } else {
          delete process.env.XDG_DATA_HOME
        }
        openCodeLog.info(`[opencode] Restored CWD and XDG_*_HOME`)
      }

      // EXEC-06: Validate client exists before marking as started
      if (!result?.client) {
        throw new Error('OpenCode SDK initialization failed: no client returned')
      }
      this.client = result.client
      this.server = result.server ?? null
      this.isStarted = true

      // C-4: Set up serverReady promise — resolved when server.connected event fires.
      // This gates the first prompt to ensure MCP handshakes are complete.
      // EXEC-05: Cancel any prior timeout before creating a new promise
      if (this.serverReadyTimeout) {
        clearTimeout(this.serverReadyTimeout)
        this.serverReadyTimeout = null
      }
      this.serverReadyPromise = new Promise<void>((resolve) => {
        this.serverReadyResolve = resolve
        // Timeout fallback — don't block forever if event never fires
        // OC-06: Local providers need more time for npm installs + MCP handshakes
        const serverReadyTimeoutMs = config?.isLocal ? 30_000 : 10_000
        this.serverReadyTimeout = setTimeout(() => {
          if (this.serverReadyResolve) {
            openCodeLog.warn(
              `[opencode] server.connected not received within ${serverReadyTimeoutMs / 1000}s — proceeding anyway`
            )
            this.serverReadyResolve()
            this.serverReadyResolve = undefined
          }
          this.serverReadyTimeout = null
        }, serverReadyTimeoutMs)
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

  // ── Event stream processing ────────────────────────────────────────────────

  /**
   * Handle a transient error chunk: yield recovery events, wait, resend.
   * Returns the updated retry count, or -1 if max retries are exhausted.
   */
  private async *handleTransientRetry(
    chunk: StreamChunk,
    retryCount: number,
    sessionId: string,
    promptBody: SessionPromptData['body']
  ): AsyncGenerator<StreamChunk, number> {
    const retry = this.computeTransientRetry(retryCount, chunk.error!)
    if (!retry) {
      // Max retries exhausted
      this.consecutiveErrors++
      openCodeLog.warn(
        `[opencode] Max transient retries exhausted (${this.consecutiveErrors} consecutive errors)`
      )
      return -1
    }

    yield {
      type: 'session_recovery',
      recoveryPhase: 'started',
      content: retry.startedMessage
    } as StreamChunk

    this.retriesInFlight++
    try {
      await new Promise((r) => setTimeout(r, retry.delayMs))
    } finally {
      this.retriesInFlight--
    }
    this.resendPrompt(sessionId, promptBody)

    yield {
      type: 'session_recovery',
      recoveryPhase: 'resuming',
      content: retry.resumingMessage
    } as StreamChunk

    return retry.attemptNumber
  }

  /**
   * Process the event stream, handling transient retries and turn counting.
   * Yields StreamChunks and collects resultText + maxTurnsReached status.
   */
  private async *processEventStream(params: {
    events: { stream: AsyncIterable<unknown> }
    openCodeSessionId: string
    promptBody: SessionPromptData['body']
    tokenUsage: ExecutorTokenUsage
    maxTurns: number
    abortController?: AbortController
  }): AsyncGenerator<StreamChunk, { resultText: string; maxTurnsReached: boolean }> {
    const { events, openCodeSessionId, promptBody, tokenUsage, maxTurns, abortController } = params
    let resultText = ''
    let turnCount = 0
    let maxTurnsReached = false
    let transientRetryCount = 0

    for await (const event of events.stream) {
      if (abortController?.signal.aborted) break

      let retryInitiatedThisEvent = false
      const chunks = this.normalizeEvent(event, openCodeSessionId, tokenUsage)
      for (const chunk of chunks) {
        if (chunk.type === 'text' && chunk.content) {
          resultText += chunk.content
        }

        // Handle transient errors with retry
        if (chunk.type === 'error' && chunk.error && this.isTransientError(chunk.error)) {
          const retryGen = this.handleTransientRetry(
            chunk,
            transientRetryCount,
            openCodeSessionId,
            promptBody
          )
          let retryResult = await retryGen.next()
          while (!retryResult.done) {
            yield retryResult.value
            retryResult = await retryGen.next()
          }
          const newRetryCount = retryResult.value
          if (newRetryCount >= 0) {
            transientRetryCount = newRetryCount
            retryInitiatedThisEvent = true
            continue
          }
          // Max retries exhausted — fall through to emit the error
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
              this.client.session
                .abort({ path: { id: openCodeSessionId } })
                .catch(() => {}) /* non-fatal: best-effort abort after maxTurns */
            }
          }
        }

        yield chunk
      }

      if (maxTurnsReached) break

      // Only suppress session.error when a retry was actually initiated for THIS event.
      // Without this, the first non-retried error gets suppressed forever (deadlock).
      const retriesAvailable = retryInitiatedThisEvent
      if (this.isSessionComplete(event, openCodeSessionId, retriesAvailable)) {
        break
      }
    }

    return { resultText, maxTurnsReached }
  }

  // ── execute ──────────────────────────────────────────────────────────

  /**
   * Execute a prompt through OpenCode's agent loop.
   * Streams events as StreamChunks for UI display.
   */
  async *execute(
    options: OpenCodeExecuteOptions
  ): AsyncGenerator<StreamChunk & { _meta?: OpenCodeExecuteResult }> {
    if (!this.client || !this.isStarted) {
      yield { type: 'error', error: 'OpenCode server not started — call start() first' }
      return
    }

    // Circuit breaker check
    if (this.consecutiveErrors >= OpenCodeExecutor.CIRCUIT_BREAKER_THRESHOLD) {
      yield {
        type: 'error',
        error:
          `OpenCode circuit breaker open: ${this.consecutiveErrors} consecutive errors. ` +
          `The provider may be down. Please try again later or switch providers.`
      }
      return
    }

    const { prompt, images, systemPrompt, provider, abortController, outputSchema } = options

    const tokenUsage: ExecutorTokenUsage = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    }

    let openCodeSessionId: string | undefined

    try {
      // C-4: Wait for server.connected before first prompt to ensure MCP handshakes complete
      if (this.serverReadyPromise) {
        await this.serverReadyPromise
        this.serverReadyPromise = undefined
      }

      // Get or create session for multi-turn reuse
      openCodeSessionId = await this.getOrCreateSession(options)
      if (!openCodeSessionId) {
        yield { type: 'error', error: 'Failed to create OpenCode session' }
        return
      }

      // Subscribe to events for streaming
      const events = await this.client.event.subscribe()

      // Build the prompt body (parts + model config + output schema)
      const promptBody = this.buildPromptBody(prompt, systemPrompt, provider, outputSchema, images)

      // ENH-13: Update session title with meaningful content from the user's prompt
      const titleText = prompt.slice(0, 80).replace(/\n/g, ' ').trim()
      const sessionTitle = titleText.length < prompt.length ? `${titleText}…` : titleText
      this.client.session
        .update?.({
          path: { id: openCodeSessionId },
          body: { title: sessionTitle }
        })
        ?.catch(() => {
          /* non-fatal: session title is cosmetic */
        })

      // OC-04: Fire-and-forget prompt via the async endpoint.
      // promptAsync → POST /session/{id}/prompt_async → returns 204 immediately.
      // Events arrive via SSE (event.subscribe). The synchronous session.prompt()
      // blocks until the full AI response completes, which holds an HTTP connection
      // open for the entire agent loop — wrong pattern for streaming.
      let promptSendError: Error | null = null
      this.client.session
        .promptAsync({
          path: { id: openCodeSessionId },
          body: promptBody
        })
        .then((response) => {
          // OC-07: Check the error field — HTTP 4xx/5xx errors land here.
          // promptAsync returns 204 (void) on success, so data is undefined.
          const errorData = (response as { error?: OpenCodeErrorPayload })?.error
          if (errorData) {
            const errorMsg =
              errorData?.data?.message ?? errorData?.message ?? JSON.stringify(errorData)
            openCodeLog.error(`[opencode] Prompt REJECTED by server: ${errorMsg}`)
            promptSendError = new Error(`OpenCode server error: ${errorMsg}`)
            return
          }

          // 204 accepted — the server is processing via the agent loop.
          // Events will arrive on the SSE stream.
          openCodeLog.info('[opencode] Prompt accepted (204)')
        })
        .catch((err) => {
          openCodeLog.error('[opencode] Prompt send error:', err)
          promptSendError = err instanceof Error ? err : new Error(String(err))
        })

      // OC-07: Start a watcher that breaks the stream if the prompt send fails.
      // The prompt is fire-and-forget — if the server returns 500, the stream
      // will hang forever because no events will be emitted.
      const promptErrorWatcher = setInterval(() => {
        if (promptSendError && abortController && !abortController.signal.aborted) {
          openCodeLog.warn('[opencode] Prompt send failed — aborting event stream')
          abortController.abort(promptSendError)
        }
      }, 500)

      // Process event stream
      let resultText = ''
      let maxTurnsReached = false

      if (events.stream) {
        const streamGen = this.processEventStream({
          events: events as { stream: AsyncIterable<unknown> },
          openCodeSessionId,
          promptBody,
          tokenUsage,
          maxTurns: options.maxTurns ?? 0,
          abortController
        })
        let streamResult = await streamGen.next()
        while (!streamResult.done) {
          yield streamResult.value
          streamResult = await streamGen.next()
        }
        ;({ resultText, maxTurnsReached } = streamResult.value)
      }

      clearInterval(promptErrorWatcher)

      // OC-04: If prompt send failed before/during streaming, surface the error
      if (promptSendError) {
        yield { type: 'error', error: `Prompt send failed: ${(promptSendError as Error).message}` }
        return
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
          this.client.session
            .abort({ path: { id: openCodeSessionId } })
            .catch(() => {}) /* non-fatal: best-effort abort on user cancellation */
        }
      } else {
        this.consecutiveErrors++
        const errorDetails = {
          message: (error as Error).message,
          name: (error as Error).name,
          stack: (error as Error).stack,
          code: (error as SpawnError)?.code,
          syscall: (error as SpawnError)?.syscall,
          path: (error as SpawnError)?.path,
          spawnargs: (error as SpawnError)?.spawnargs,
          platform: process.platform,
          envPATH: process.env.PATH?.slice(0, 600)
        }
        openCodeLog.error(
          `[opencode] Execution error (consecutive=${this.consecutiveErrors}):`,
          errorDetails
        )
        openCodeLog.error(`[opencode] Current PATH: ${process.env.PATH || 'not set'}`)

        // Provide helpful troubleshooting info in the error message
        const helpMessage = `OpenCode error: ${(error as Error).message}

Troubleshooting:
- Check that opencode is installed: npm install -g @opencode-ai/cli
- Check the opencode path: which opencode
- Ensure the opencode directory is in PATH: echo $PATH
- Current PATH: ${process.env.PATH?.slice(0, 300) || 'not set'}`

        yield { type: 'error', error: helpMessage }
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

    // PORT-FIX: Close the server child process so the port is released.
    // Previously this reference was never stored, leaving orphaned processes.
    if (this.server) {
      try {
        this.server.close()
      } catch (err) {
        openCodeLog.warn('[opencode] Error closing server:', err)
      }
      this.server = null
    }

    this.client = null
    this.isStarted = false
    this.sessionMap.clear()
    this.consecutiveErrors = 0

    // EXEC-05: Cancel the serverReady fallback timeout
    if (this.serverReadyTimeout) {
      clearTimeout(this.serverReadyTimeout)
      this.serverReadyTimeout = null
    }
    this.serverReadyResolve = undefined
    this.serverReadyPromise = undefined

    // EXEC-01: Clean up global env vars set during start() to prevent
    // cross-session contamination when switching workspaces
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL
    delete process.env.OPENCODE_ENABLE_EXA
  }

  /**
   * MISS-14: Check if the OpenCode server is healthy.
   * The SDK exposes no dedicated health endpoint, so we issue a lightweight,
   * non-destructive session.list() call — success implies the server responds.
   */
  async checkHealth(): Promise<{ healthy: boolean; version?: string }> {
    if (!this.client || !this.isStarted) {
      return { healthy: false }
    }
    try {
      await this.client.session.list()
      return { healthy: true }
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
      const result = await this.client.session.children({
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

    // Wrap in a timeout — priming is best-effort and must never block the real prompt.
    // enrichGitContext and session.prompt (synchronous) can hang if MCP handshakes are incomplete.
    const PRIMING_TIMEOUT_MS = 8_000
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), PRIMING_TIMEOUT_MS)
    )

    const primingWork = (async () => {
      // 6E-2/B-4: Enrich git context via file.status() or session.shell() fallback
      await this.enrichGitContext(sessionId, contextParts)

      await this.client!.session.prompt({
        path: { id: sessionId },
        body: {
          parts: contextParts,
          noReply: true
        }
      })
      return 'done' as const
    })()

    try {
      const result = await Promise.race([primingWork, timeoutPromise])
      if (result === 'timeout') {
        openCodeLog.warn(
          `[opencode] Session priming timed out after ${PRIMING_TIMEOUT_MS}ms — proceeding without priming`
        )
      } else {
        openCodeLog.info(
          `[opencode] Session ${sessionId} primed with ${contextParts.length} context parts`
        )
      }
    } catch (err) {
      // Non-fatal — priming failure shouldn't block the real prompt
      openCodeLog.warn(`[opencode] Session priming failed: ${(err as Error).message}`)
    }
  }

  /**
   * 6E-2/B-4: Enrich git context in priming parts via dual-fallback.
   * Uses file.status() for structured uncommitted changes.
   * Mutates the matching contextParts entry in place.
   */
  private async enrichGitContext(
    _sessionId: string,
    contextParts: Array<{ type: 'text'; text: string }>
  ): Promise<void> {
    if (!this.client) return

    const gitIdx = contextParts.findIndex((p) =>
      p.text.includes('[Workspace Context: Recent Changes]')
    )
    if (gitIdx < 0) return

    // Try file.status() first for structured uncommitted changes
    try {
      const fileStatus = await this.client.file.status({})
      if (fileStatus.data && fileStatus.data.length > 0) {
        const statusLines = fileStatus.data
          .map((f: { status: string; path: string }) => `  ${f.status} ${f.path}`)
          .join('\n')
        contextParts[gitIdx] = {
          type: 'text',
          text: `[Workspace Context: Uncommitted Changes]\n${statusLines}`
        }
        return
      }
    } catch {
      // file.status() not available — keep the static context parts.
      // (A session.shell() git-diff fallback was removed: the SDK's shell
      // response is an AssistantMessage with no stdout field to read.)
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
      const result = await this.client.session.command({
        path: { id: sessionId },
        body: { command, arguments: args ?? '' }
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
    // For local providers, ping the health endpoint directly
    const localCheck = await this.checkLocalProviderHealth(providerId, baseUrl)
    if (localCheck) return localCheck

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
    // The OpenCode SDK exposes no session-pin API (session.update only accepts
    // `title`). Pinning is a local-only UI affordance, so this is a no-op stub
    // that reports success without a server round-trip.
    openCodeLog.info(`[opencode] pinSession is a local-only no-op for session ${sessionId}`)
    return { success: true }
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
      const result = await this.client.session.messages({
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
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: allowed ? 'always' : 'reject' }
      })
      openCodeLog.info(
        `[opencode] Permission ${allowed ? 'granted' : 'denied'} for ${permissionId}`
      )
    } catch (err) {
      openCodeLog.error(`[opencode] Failed to respond to permission ${permissionId}:`, err)
      throw err
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
   * GAP-24: Check local provider health by pinging their HTTP endpoint.
   * Returns a descriptive error string if unreachable, or null if healthy/not-local.
   */
  private async checkLocalProviderHealth(
    providerId: string,
    baseUrl?: string
  ): Promise<string | null> {
    const LOCAL_PROVIDERS: Record<
      string,
      { defaultUrl: string; healthPath: string; hint?: string }
    > = {
      ollama: {
        defaultUrl: 'http://localhost:11434',
        healthPath: '/api/tags',
        hint: 'Try: ollama serve'
      },
      omlx: { defaultUrl: 'http://localhost:8000', healthPath: '/v1/models' }
    }

    const provider = LOCAL_PROVIDERS[providerId]
    if (!provider) return null

    const url = baseUrl ?? provider.defaultUrl
    try {
      const response = await fetch(`${url}${provider.healthPath}`, {
        signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) {
        return `${providerId} is not responding (HTTP ${response.status}). Ensure ${providerId} is running at ${url}`
      }
    } catch {
      const hint = provider.hint ? ` ${provider.hint}` : ''
      return `Cannot reach ${providerId} at ${url}. Is it running?${hint}`
    }

    return null
  }

  /**
   * #3: Check if an error message indicates a transient/retriable condition.
   */
  private isTransientError(errorMessage: string): boolean {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  }

  /**
   * Compute retry state for a transient error. Returns null when retries exhausted.
   */
  private computeTransientRetry(
    currentRetryCount: number,
    errorMessage: string
  ): {
    attemptNumber: number
    delayMs: number
    startedMessage: string
    resumingMessage: string
  } | null {
    if (currentRetryCount >= MAX_TRANSIENT_RETRIES) return null

    const attemptNumber = currentRetryCount + 1
    const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attemptNumber - 1)
    openCodeLog.info(
      `[opencode] Transient error detected, retrying in ${delayMs}ms ` +
        `(attempt ${attemptNumber}/${MAX_TRANSIENT_RETRIES}): ${errorMessage}`
    )

    return {
      attemptNumber,
      delayMs,
      startedMessage: `Transient error detected — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attemptNumber}/${MAX_TRANSIENT_RETRIES})`,
      resumingMessage: `Retry ${attemptNumber} in progress...`
    }
  }

  /**
   * Re-send a prompt to the OpenCode session (fire-and-forget for retries).
   */
  private resendPrompt(sessionId: string, promptBody: SessionPromptData['body']): void {
    this.client!.session.promptAsync({
      path: { id: sessionId },
      body: promptBody
    }).catch((err) => {
      openCodeLog.error('[opencode] Retry prompt error:', err)
    })
  }

  /**
   * Get or create an OpenCode session for the given options.
   * Handles session reuse for multi-turn conversations and priming.
   */
  private async getOrCreateSession(options: OpenCodeExecuteOptions): Promise<string | undefined> {
    const { conversationId, provider } = options
    let sessionId: string | undefined

    if (conversationId) {
      sessionId = this.sessionMap.get(conversationId)
    }

    if (!sessionId) {
      const session = await this.client!.session.create({
        body: { title: `Code Atelier: ${new Date().toISOString()}` }
      })
      sessionId = session.data?.id
      if (!sessionId) {
        // Log the full response so config/provider errors are diagnosable
        openCodeLog.error(
          '[opencode] session.create returned no ID — response:',
          JSON.stringify(session.data ?? session, null, 2)
        )
        return undefined
      }

      if (conversationId) {
        this.sessionMap.set(conversationId, sessionId)
      }

      openCodeLog.info(
        `[opencode] Session ${sessionId} created — provider=${provider.providerId}/${provider.modelId}`
      )

      // A-1: Prime the session with workspace context before the first real prompt
      if (options.primingContext && options.primingContext.length > 0) {
        await this.primeSession(sessionId, options.primingContext)
      }
    } else {
      openCodeLog.info(`[opencode] Reusing session ${sessionId} for conversation=${conversationId}`)
    }

    return sessionId
  }

  /**
   * Build the prompt body with parts, model config, and optional output schema.
   * D-1: System prompt uses the SDK `system` field (proper channel for model instructions).
   * When the plugin hook is active, it injects system prompt via its own mechanism.
   */
  private buildPromptBody(
    prompt: string,
    systemPrompt: string,
    provider: OpenCodeProviderConfig,
    outputSchema?: Record<string, unknown>,
    images?: ImageAttachment[]
  ): SessionPromptData['body'] {
    const hasPluginSystemPromptHook = !!process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    const body: Record<string, unknown> = {
      parts: [
        { type: 'text', text: prompt },
        // Vision: include image attachments as file parts with data URLs
        ...(images ?? []).map((img) => ({
          type: 'file',
          mime: img.mimeType,
          filename: img.fileName,
          url: `data:${img.mimeType};base64,${img.base64}`
        }))
      ],
      model: {
        providerID: provider.providerId,
        modelID: provider.modelId
      },
      // Use the SDK's system field for system prompts — proper channel for model instructions.
      // This gives the system prompt higher priority, enables provider-specific routing,
      // and supports prefix caching. Skip when the plugin hook injects its own system prompt.
      ...(systemPrompt && !hasPluginSystemPromptHook ? { system: systemPrompt } : {})
    }

    // ENH-10: Include retry config so OpenCode auto-retries on invalid JSON
    if (outputSchema) {
      body.format = { type: 'json_schema', schema: outputSchema, retryCount: 2 }
    }

    return body as SessionPromptData['body']
  }

  /**
   * Reset the consecutive error counter (e.g. after a successful interaction).
   */
  resetCircuitBreaker(): void {
    this.consecutiveErrors = 0
  }

  /**
   * PORT-FIX: Kill any stale `opencode serve` process holding the server port.
   * This handles ungraceful shutdowns where stop() wasn't called or failed.
   */
  private async killStaleServer(): Promise<void> {
    try {
      const { execSync } = await import('node:child_process')
      // lsof finds PIDs listening on our port; awk extracts the PID column
      const output = execSync(`lsof -ti :${OPENCODE_SERVER_PORT} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true
      }).trim()
      if (output) {
        const pids = output.split('\n').filter(Boolean)
        for (const pid of pids) {
          openCodeLog.warn(
            `[opencode] Killing stale server process on port ${OPENCODE_SERVER_PORT} (PID ${pid})`
          )
          try {
            process.kill(Number(pid), 'SIGTERM')
          } catch {
            // Process may have already exited
          }
        }
        // Brief wait for the port to be released
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch {
      // lsof not found or no process on port — safe to proceed
    }
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
    // R6-A1: Keep serverReadyResolve in sync (it's set/cleared outside the state)
    this.normalizerState.serverReadyResolve = this.serverReadyResolve
    return normalizeOpenCodeEvent(event, sessionId, tokenUsage, this.normalizerState)
  }

  /**
   * Check if an event indicates the session has completed.
   *
   * @param retriesAvailable - When true, `session.error` events are NOT treated as
   *   terminal because a retry was actually initiated for this event. This flag
   *   should only be true when handleTransientRetry fired successfully — NOT simply
   *   because the retry budget hasn't been exhausted (which caused the suppression
   *   deadlock: errors were suppressed but no retry ever fired).
   */
  /** Diagnostic gauges for the vitals heartbeat (see main-vitals.ts). */
  public getVitals(): { activeSessions: number; retriesInFlight: number } {
    return { activeSessions: this.sessionMap.size, retriesInFlight: this.retriesInFlight }
  }

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

    // NOTE: session.next.step.ended with finish="stop" is NOT treated as terminal.
    // It marks the end of a single generation *step*, not the agent loop. Reasoning
    // models emit a step.ended(stop) for the thinking step before the final answer
    // step streams in — breaking here truncated the last text (e.g. the JSON answer),
    // left the server session running as a zombie, and stalled the UI with no loading
    // state. `session.idle` / `session.status:idle` is the authoritative completion
    // signal (see handleSessionIdle in opencode-event-normalizer.ts); the outer
    // streamPrompt timeout is the backstop if idle never arrives.

    // V2 event bus: session.next.step.failed is a terminal signal
    if (type === 'session.next.step.failed') {
      if (retriesAvailable) {
        openCodeLog.info('[opencode] session.next.step.failed suppressed — retries still available')
        return false
      }
      return true
    }

    return false
  }
}

/** Singleton instance */
export const openCodeExecutor = new OpenCodeExecutor()

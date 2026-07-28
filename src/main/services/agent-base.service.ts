import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { LogFunctions } from 'electron-log'
import type { AgentStatus } from '../../shared/types'
import { buildEnvWithPath } from './env-utils'
import { agentSessionRepository } from '../db/repositories'
import { summarizeToolInput } from './tool-input-summarizer'

// Re-export for backward compatibility — consumers import from here or the barrel
export { summarizeToolInput }

export interface StreamChunk {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'tool_progress'
    | 'error'
    | 'status'
    | 'turn_boundary'
    | 'subagent_start'
    | 'subagent_progress'
    | 'subagent_complete'
    | 'rate_limit'
    | 'compact_boundary'
    | 'api_retry'
    | 'prompt_suggestion'
    | 'files_persisted'
    | 'hook_lifecycle'
    | 'session_state'
    | 'auth_status'
    | 'tool_use_summary'
    | 'session_recovery'
    | 'context_usage_update'
    | 'permission_request'
    | 'structured_output'
    | 'lsp_diagnostics'
    | 'todo_update'
    | 'turn_limit'
    | 'phase_progress'
  content?: string
  toolName?: string
  toolInput?: string
  toolId?: string
  error?: string
  /** True when the CLI's tool_result had is_error: true (e.g. permission denied). */
  isError?: boolean
  /** Elapsed time in seconds for tool_progress */
  elapsedSeconds?: number
  /** Rate limit info for rate_limit type */
  rateLimit?: {
    status: 'allowed' | 'allowed_warning' | 'rejected'
    utilization?: number
    resetsAt?: number
    rateLimitType?: string
  }
  /** API retry info */
  retryInfo?: {
    attempt: number
    maxRetries: number
    retryDelayMs: number
    errorStatus: number | null
  }
  /** Files persisted list */
  persistedFiles?: Array<{ filename: string; fileId: string }>
  /** Session recovery phase */
  recoveryPhase?: 'started' | 'building_context' | 'resuming' | 'completed' | 'failed'
  /** Live context usage update — emitted each turn for real-time badge updates */
  contextUsageUpdate?: {
    inputTokens: number
    contextWindowSize: number
    percentage: number
    /** Prompt cache hit rate (0–100) — ratio of cache-read tokens to total input. */
    cacheHitRate?: number
  }
  /** Hook lifecycle info */
  hookInfo?: {
    hookId: string
    hookName: string
    hookEvent: string
    phase: 'started' | 'progress' | 'response'
    output?: string
    outcome?: 'success' | 'error' | 'cancelled'
  }
  /** Permission request info (plan mode) */
  permissionRequest?: {
    permissionId: string
    tool: string
    args?: Record<string, unknown>
    message: string
  }
  /** GAP-9: Structured output from agent response (JSON schema result) */
  structuredOutput?: {
    data: unknown
    schemaName?: string
  }
  /** GAP-14: LSP diagnostics from compiler/linter */
  lspDiagnostics?: Array<{
    file: string
    line: number
    severity: 'error' | 'warning' | 'info' | 'hint'
    message: string
    source?: string
  }>
  /** GAP-15: Todo list update from todowrite tool */
  todoUpdate?: {
    action: 'add' | 'complete' | 'remove' | 'update'
    text: string
    index?: number
  }
  /** Phase progress update from plan execution */
  phaseProgress?: {
    planId: string | null
    phaseId: number
    phaseTitle: string
    status: 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped'
    totalPhases: number
    message?: string
  }
  /** Turn limit reached — emitted when all auto-continuations are exhausted */
  turnLimit?: {
    /** Whether the user can click Continue to resume */
    continuable: boolean
    /** How many auto-continuations were used */
    continuationsUsed: number
    /** Max auto-continuations allowed */
    continuationsMax: number
  }
}

/**
 * Shared base class for agent services.
 *
 * N6: Dead SDK stream processing methods removed. The CLI and OpenCode
 * execution paths use stream-normalizer.ts and opencode-event-normalizer.ts
 * respectively — they no longer route through AgentBaseService stream methods.
 *
 * Retains: process lifecycle, DB session tracking, env building, stop().
 */
export abstract class AgentBaseService extends EventEmitter {
  protected process: ChildProcess | null = null
  protected currentStatus: AgentStatus['status'] = 'idle'
  protected tokenUsage: number = 0
  protected inputTokens: number = 0
  protected outputTokens: number = 0
  protected cacheReadTokens: number = 0
  protected cacheCreationTokens: number = 0
  protected startedAt: number = 0
  protected messageStartedAt: number = 0
  /** Workspace directory — used to relativize file paths in tool summaries */
  protected cwd: string | undefined

  /** Database session ID for token tracking */
  protected dbSessionId: string | null = null

  /** Scoped logger — each subclass provides its own scope */
  protected abstract readonly log: LogFunctions

  constructor() {
    super()
    this.on('error', (err) => {
      this.log.error('[AgentBase:unhandled-error]', err)
    })
  }

  abstract getStatus(): AgentStatus

  /**
   * Builds a process environment with PATH augmented for claude CLI discovery.
   * Delegates to shared env-utils for cross-platform PATH construction.
   */
  protected buildEnvWithPath(): NodeJS.ProcessEnv {
    return buildEnvWithPath()
  }

  /**
   * Creates a DB session record for token tracking.
   * Call from subclass start() after spawning the process.
   */
  protected createDbSession(
    agentType: string,
    opts: { pid?: number; conversationId?: string; workspaceId?: string } = {}
  ): void {
    try {
      const session = agentSessionRepository.create(agentType, opts)
      this.dbSessionId = session.id
    } catch (err) {
      this.log.error('Failed to create DB session:', err)
    }
  }

  /**
   * Links the DB session to a conversation after the conversation ID becomes known.
   * Use for long-lived agents (e.g. the chat agent) where conversationId is not available at start().
   */
  protected updateDbSessionConversation(conversationId: string): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.updateConversationId(this.dbSessionId, conversationId)
    } catch (err) {
      this.log.error('Failed to update DB session conversationId:', err)
    }
  }

  /**
   * Flushes current token usage to the DB session without completing it.
   * Use for long-lived agents (e.g. the chat agent) so the dashboard shows live data.
   */
  protected flushTokenUsage(): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.updateTokenUsage(this.dbSessionId, this.tokenUsage, {
        input: this.inputTokens,
        output: this.outputTokens,
        cacheRead: this.cacheReadTokens,
        cacheCreation: this.cacheCreationTokens
      })
    } catch (err) {
      this.log.error('Failed to flush token usage:', err)
    }
  }

  /**
   * Completes the DB session record with final status and token usage.
   */
  protected completeDbSession(status: 'completed' | 'failed' | 'terminated'): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.completeWithBreakdown(this.dbSessionId, status, {
        total: this.tokenUsage,
        input: this.inputTokens,
        output: this.outputTokens,
        cacheRead: this.cacheReadTokens,
        cacheCreation: this.cacheCreationTokens
      })
    } catch (err) {
      this.log.error('Failed to complete DB session:', err)
    }
    this.dbSessionId = null
  }

  /**
   * Gracefully stops the process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      // Complete DB session before killing
      this.completeDbSession('terminated')

      this.process.kill('SIGTERM')

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL')
          resolve()
        }, 5000)

        this.process?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })

      this.process = null
    }
    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
  }
}

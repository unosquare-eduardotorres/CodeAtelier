import type { StreamChunk } from './agent-base.service'
import type { ExecutorResult } from './executor-types'
import type { CLIExecutor } from './cli-executor'
import { DA_VINCI_AGENT_ID, MCP_TOOLS } from '../../shared/constants'
import { chatAgentLogger } from '../logger'
import { conversationRepository } from '../db/repositories'
import { usageTrackerService } from './usage-tracker.service'

export interface RecoveryNudgeOptions {
  /** CLI executor to perform the 1-turn text-only recovery call */
  cliExecutor: CLIExecutor
  /** System prompt for the recovery query context */
  systemPrompt: string
  /** Workspace path for model resolution */
  workspacePath: string
  /** Model identifier for the recovery query */
  model: string
  /** Whether the generalist is in build mode (affects permissionMode) */
  isBuildMode: boolean
  /** Current session ID for resume */
  sessionId: string | undefined
  /** Conversation ID for session tracking */
  conversationId: string
  /** Workspace id for unified usage logging (nullable). */
  workspaceId?: string | null
  /** Number of tool calls made (for fallback message) */
  toolCallCount: number
  /** Names of the last tool(s) called (for context-specific recovery prompt) */
  lastToolNames?: string[]
  /** Callback to capture new session ID from recovery response */
  onSessionCapture: (sessionId: string) => void
  /** Callback to emit stream chunks to the renderer */
  onChunk: (chunk: StreamChunk) => void
  /** Callback to track token usage from recovery response */
  onTokens: (tokens: number) => void
}

export interface RecoveryNudgeResult {
  /** Whether the recovery nudge produced text output */
  recovered: boolean
  /** Accumulated recovery text (or fallback message if not recovered) */
  text: string
}

export interface PlanToolRecoveryOptions {
  /** CLI executor to perform the recovery call */
  cliExecutor: CLIExecutor
  /** System prompt for the recovery query context */
  systemPrompt: string
  /** Workspace path for model resolution */
  workspacePath: string
  /** Model identifier for the recovery query */
  model: string
  /** Current session ID for resume */
  sessionId: string | undefined
  /** Conversation ID for session tracking */
  conversationId: string
  /** Workspace id for unified usage logging (nullable). */
  workspaceId?: string | null
  /**
   * MCP config path that mounts the control-actions server (emit_plan). Without
   * it the recovery turn cannot call emit_plan. When undefined, recovery is skipped.
   */
  mcpConfigPath: string | undefined
  /** Callback to capture new session ID from recovery response */
  onSessionCapture: (sessionId: string) => void
  /** Callback to emit stream chunks to the renderer */
  onChunk: (chunk: StreamChunk) => void
  /** Callback to track token usage from recovery response */
  onTokens: (tokens: number) => void
}

export interface PlanToolRecoveryResult {
  /** Whether the recovery turn ran to completion (does not guarantee a plan was emitted). */
  attempted: boolean
}

/**
 * Handles the "silent tool completion" recovery strategy.
 *
 * When the stream ends after tool calls without producing a text summary,
 * this service fires a 1-turn text-only nudge to extract a summary from the model.
 * If the nudge also fails, it produces a user-facing fallback message.
 *
 * This is a complete sub-interaction with its own executor call, session handling,
 * and fallback logic — isolated from the main stream loop.
 */
export class RecoveryNudgeService {
  private readonly log = chatAgentLogger

  /**
   * Attempt a 1-turn text-only recovery when tools completed without summary.
   * Returns whether recovery succeeded and the text produced (or fallback).
   */
  async attemptRecovery(opts: RecoveryNudgeOptions): Promise<RecoveryNudgeResult> {
    this.log.warn(
      `[PIPELINE:silent-tool-completion] conversationId=${opts.conversationId} toolCalls=${opts.toolCallCount} — attempting recovery nudge`
    )

    let recovered = false
    let recoveredText = ''

    // Build context-specific recovery prompt when tool names are available
    const toolContext = opts.lastToolNames?.length
      ? ` Your previous call(s) used ${opts.lastToolNames.join(', ')}.`
      : ''

    try {
      for await (const chunk of opts.cliExecutor.execute({
        prompt: (() => {
          const action = opts.isBuildMode ? 'found or executed' : 'found'
          const source = opts.isBuildMode ? 'read or ran' : 'read'
          return `[System: Your previous response ended after tool calls without providing a summary to the user.${toolContext} Please summarize what you ${action} in 2-5 sentences. Do NOT use any tools — just summarize from what you already ${source}.]`
        })(),
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        cwd: opts.workspacePath,
        permissionMode: opts.isBuildMode ? 'bypassPermissions' : 'plan',
        allowedTools: [], // No tools — text summary only
        disallowedTools: [
          'Agent',
          'Task',
          'local_agent',
          'ToolSearch',
          'ExitPlanMode',
          'AskUserQuestion'
        ],
        maxTurns: 1,
        resume: opts.sessionId,
        agentId: DA_VINCI_AGENT_ID,
        // Recovery is lightweight summarization — omit thinking entirely.
        effort: 'low'
      })) {
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as ExecutorResult
          if (meta.sessionId && opts.conversationId) {
            opts.onSessionCapture(meta.sessionId)
            try {
              conversationRepository.updateSessionId(opts.conversationId, meta.sessionId)
            } catch {
              /* ignore */
            }
          }
          opts.onTokens(meta.tokenUsage.input + meta.tokenUsage.output)
          usageTrackerService.recordUsage({
            feature: 'recovery_nudge',
            model: opts.model,
            workspaceId: opts.workspaceId ?? null,
            conversationId: opts.conversationId,
            tokens: {
              input: meta.tokenUsage.input,
              output: meta.tokenUsage.output,
              cacheRead: meta.tokenUsage.cacheReadInputTokens,
              cacheCreation: meta.tokenUsage.cacheCreationInputTokens
            }
          })
        } else if (chunk.type === 'text' && chunk.content) {
          recovered = true
          recoveredText += chunk.content
          opts.onChunk(chunk)
        }
      }

      if (recovered) {
        this.log.info(
          `[PIPELINE:silent-tool-recovery] Successfully recovered summary for conversationId=${opts.conversationId}`
        )
      }
    } catch (err) {
      this.log.error('[PIPELINE:recovery-nudge-failed]', err)
    }

    if (!recovered) {
      const fallbackMessage =
        opts.toolCallCount === 1
          ? '\n\n_I read a file but my response was cut short. Could you repeat your question?_'
          : `\n\n_I used ${opts.toolCallCount} tools but didn't produce a summary. Try asking "what did you find?" and I'll summarize._`
      recoveredText = fallbackMessage
      this.log.warn(
        `[PIPELINE:recovery-nudge-fallback] Emitting fallback for conversationId=${opts.conversationId} toolCalls=${opts.toolCallCount}`
      )
      opts.onChunk({
        type: 'text',
        content: fallbackMessage
      } as StreamChunk)
    }

    return { recovered, text: recoveredText }
  }

  /**
   * Plan-mode recovery: the model tried a blocked Write/Edit to author a plan.
   * Fire a short follow-up turn that allows ONLY the control-actions tools
   * (emit_plan) and instruct the model to re-deliver its plan via emit_plan.
   *
   * This guarantees the user still gets a plan card even when the model slips,
   * complementing the prompt steering (Layer 1) and bug-report suppression (Layer 3).
   */
  async attemptPlanToolRecovery(opts: PlanToolRecoveryOptions): Promise<PlanToolRecoveryResult> {
    if (!opts.mcpConfigPath) {
      this.log.warn(
        `[PIPELINE:plan-tool-recovery-skipped] No MCP config path — cannot mount emit_plan for conversationId=${opts.conversationId}`
      )
      return { attempted: false }
    }

    this.log.warn(
      `[PIPELINE:plan-tool-recovery] conversationId=${opts.conversationId} — re-issuing plan via emit_plan after a blocked Write/Edit`
    )

    const prompt =
      '[System: Your last action tried to Write/Edit a file, which is blocked in Plan mode ' +
      '("No such tool available"). Re-deliver that plan NOW by calling the emit_plan tool with ' +
      'type, title, and phases (referencing the real file paths you already identified). ' +
      'Do NOT use Write or Edit — emit_plan is the only way to deliver a plan. Do not write any other text.]'

    try {
      for await (const chunk of opts.cliExecutor.execute({
        prompt,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        cwd: opts.workspacePath,
        permissionMode: 'plan',
        // Only the control-actions tools (emit_plan / ask_user) — no Read/Write/etc.
        allowedTools: [...MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES],
        disallowedTools: [
          'Write',
          'Edit',
          'MultiEdit',
          'Agent',
          'Task',
          'local_agent',
          'ToolSearch',
          'ExitPlanMode',
          'AskUserQuestion'
        ],
        mcpConfigPath: opts.mcpConfigPath,
        maxTurns: 2,
        resume: opts.sessionId,
        agentId: DA_VINCI_AGENT_ID,
        effort: 'low'
      })) {
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as ExecutorResult
          if (meta.sessionId && opts.conversationId) {
            opts.onSessionCapture(meta.sessionId)
            try {
              conversationRepository.updateSessionId(opts.conversationId, meta.sessionId)
            } catch {
              /* ignore */
            }
          }
          opts.onTokens(meta.tokenUsage.input + meta.tokenUsage.output)
          usageTrackerService.recordUsage({
            feature: 'plan_recovery',
            model: opts.model,
            workspaceId: opts.workspaceId ?? null,
            conversationId: opts.conversationId,
            tokens: {
              input: meta.tokenUsage.input,
              output: meta.tokenUsage.output,
              cacheRead: meta.tokenUsage.cacheReadInputTokens,
              cacheCreation: meta.tokenUsage.cacheCreationInputTokens
            }
          })
        } else {
          // Forward all chunks (the emit_plan tool fires via the control-actions
          // MCP callbacks wired into the cached config; tool chunks are filtered
          // by the chunk router, plan delivery flows through the control path).
          opts.onChunk(chunk)
        }
      }
      this.log.info(`[PIPELINE:plan-tool-recovery-done] conversationId=${opts.conversationId}`)
      return { attempted: true }
    } catch (err) {
      this.log.error('[PIPELINE:plan-tool-recovery-failed]', err)
      return { attempted: false }
    }
  }
}

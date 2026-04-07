import type { StreamChunk } from './agent-base.service'
import type { SDKExecuteResult } from './sdk-executor'
import type { SDKExecutor } from './sdk-executor'
import { AGENT_IDS } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { conversationRepository } from '../db/repositories'

export interface RecoveryNudgeOptions {
  /** SDK executor to perform the 1-turn text-only recovery call */
  sdkExecutor: SDKExecutor
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
  /** Number of tool calls made (for fallback message) */
  toolCallCount: number
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

/**
 * Handles the "silent tool completion" recovery strategy.
 *
 * When the SDK stream ends after tool calls without producing a text summary,
 * this service fires a 1-turn text-only nudge to extract a summary from the model.
 * If the nudge also fails, it produces a user-facing fallback message.
 *
 * This is a complete sub-interaction with its own SDK call, session handling,
 * and fallback logic — isolated from the main stream loop.
 */
export class RecoveryNudgeService {
  private readonly log = generalistLogger

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

    try {
      for await (const chunk of opts.sdkExecutor.execute({
        prompt:
          '[System: Your previous response ended after tool calls without providing a summary to the user. Please summarize what you found in 2-5 sentences. Do NOT use any tools — just summarize from what you already read.]',
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        cwd: opts.workspacePath,
        permissionMode: opts.isBuildMode ? 'bypassPermissions' : 'default',
        allowedTools: [], // No tools — text summary only
        disallowedTools: ['Agent', 'ToolSearch', 'ExitPlanMode', 'AskUserQuestion'],
        maxTurns: 1,
        resume: opts.sessionId,
        agentId: AGENT_IDS.GENERALIST,
        // Recovery is lightweight summarization — minimal thinking
        thinking: { type: 'disabled' },
        effort: 'low'
      })) {
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as SDKExecuteResult
          if (meta.sessionId && opts.conversationId) {
            opts.onSessionCapture(meta.sessionId)
            try {
              conversationRepository.updateSessionId(opts.conversationId, meta.sessionId)
            } catch {
              /* ignore */
            }
          }
          opts.onTokens(meta.tokenUsage.input + meta.tokenUsage.output)
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
      opts.onChunk({
        type: 'text',
        content: fallbackMessage
      } as StreamChunk)
    }

    return { recovered, text: recoveredText }
  }
}

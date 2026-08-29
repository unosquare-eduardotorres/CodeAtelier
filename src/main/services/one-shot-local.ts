/**
 * one-shot-local — OpenAI-compatible HTTP call to a local LLM (oMLX) with
 * automatic Claude fallback on failure.
 *
 * Used for background tasks (memory feed, activation, haiku) when the user
 * configures local models for those roles. Falls back silently to Claude
 * with a warning log when the local server is unreachable or errors.
 *
 * Records usage to the unified usage_log sink.
 */

import log from 'electron-log/main'
import { usageTrackerService } from './usage-tracker.service'
import { runOneShotClaude, type OneShotClaudeOptions } from './one-shot-claude'
import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'

const localLog = log.scope('OneShotLocal')

/** Default timeout for local LLM requests (10s) */
const LOCAL_REQUEST_TIMEOUT_MS = 10_000

/** Build the Claude CLI fallback args for memory-feed one-shot calls.
 * Single source of truth — consumed by spawnSummarizer, spawnClassifier, and tests.
 */
export function buildMemoryFeedFallbackArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    DEFAULT_MODEL_CONFIG.memoryFeed,
    '--output-format',
    'text',
    '--permission-mode',
    'plan'
  ]
}

export interface OneShotLocalOptions {
  /** System prompt */
  systemPrompt: string
  /** User message */
  userMessage: string
  /** oMLX/local LLM base URL (e.g., http://127.0.0.1:10434) */
  baseUrl: string
  /** Model name/ID on the local server */
  model: string
  /** Optional API key for authenticated oMLX instances */
  apiKey?: string
  /** Feature bucket for usage_log */
  feature: string
  workspaceId?: string | null
  conversationId?: string | null
  /** Maximum tokens in response */
  maxTokens?: number
  /** Request timeout in ms (default: 10s) */
  timeoutMs?: number
  /**
   * Path appended to baseUrl for the chat-completions call. Default
   * '/v1/chat/completions' (ollama/omlx layout). Cloud OpenAI-compatible
   * endpoints whose base URL already ends in a version segment (Z.ai Coding
   * Plan: https://api.z.ai/api/coding/paas/v4) need '/chat/completions'.
   */
  chatCompletionsPath?: string
  /** Claude fallback args — used when local call fails */
  claudeFallbackArgs?: string[]
  /** Claude fallback model */
  claudeFallbackModel?: string
}

export interface OneShotLocalResult {
  /** Response text */
  text: string
  /** Which provider actually served the response */
  provider: 'local' | 'claude'
  /** Model used */
  model: string
  /** Whether this was a fallback from a failed local call */
  wasFallback: boolean
}

/**
 * Make an OpenAI-compatible chat completion request to a local LLM.
 * Falls back to Claude on any failure.
 */
export async function runOneShotLocal(opts: OneShotLocalOptions): Promise<OneShotLocalResult> {
  const timeout = opts.timeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (opts.apiKey) {
      headers['Authorization'] = `Bearer ${opts.apiKey}`
    }

    const body = JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage }
      ],
      max_tokens: opts.maxTokens ?? 2048,
      stream: false
    })

    const response = await fetch(
      `${opts.baseUrl}${opts.chatCompletionsPath ?? '/v1/chat/completions'}`,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      }
    )

    clearTimeout(timer)

    if (!response.ok) {
      throw new Error(`Local LLM returned ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const text = data.choices?.[0]?.message?.content ?? ''
    const inputTokens = data.usage?.prompt_tokens ?? 0
    const outputTokens = data.usage?.completion_tokens ?? 0

    // Record usage
    usageTrackerService.recordUsage({
      feature: opts.feature,
      model: opts.model,
      workspaceId: opts.workspaceId ?? null,
      conversationId: opts.conversationId ?? null,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheCreation: 0
      }
    })

    localLog.info(
      `[${opts.feature}] Local LLM success — model=${opts.model} in=${inputTokens} out=${outputTokens}`
    )

    return { text, provider: 'local', model: opts.model, wasFallback: false }
  } catch (err) {
    localLog.warn(
      `[${opts.feature}] Local LLM failed — falling back to Claude:`,
      err instanceof Error ? err.message : String(err)
    )

    // Fall back to Claude
    if (opts.claudeFallbackArgs && opts.claudeFallbackArgs.length > 0) {
      const claudeOpts: OneShotClaudeOptions = {
        args: opts.claudeFallbackArgs,
        feature: opts.feature,
        model: opts.claudeFallbackModel ?? null,
        workspaceId: opts.workspaceId,
        conversationId: opts.conversationId
      }

      const result = await runOneShotClaude(claudeOpts)
      return {
        text: result.text,
        provider: 'claude',
        model: result.model ?? 'claude-haiku-4-5-20251001',
        wasFallback: true
      }
    }

    // No fallback configured — return empty. Callers that must surface the
    // failure (e.g. GLM extraction, which must never silently degrade) check
    // result.text themselves; prompt-optimizer deliberately treats empty as
    // skippedReason:'error' and keeps the original prompt.
    return {
      text: '',
      provider: 'local',
      model: opts.model,
      wasFallback: false
    }
  }
}

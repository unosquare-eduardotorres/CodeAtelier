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
  /**
   * GLM-REASONING (C1): finish_reason of the winning completion, when the
   * server reported one. 'length' on an empty text means the whole budget
   * went to reasoning tokens — callers can distinguish truncation from a
   * true empty response. Additive/optional — existing callers unaffected.
   */
  finishReason?: string
}

/** GLM-REASONING (C1): parsed OpenAI-compatible chat completion — pure, unit-testable. */
export interface ParsedChatCompletion {
  text: string
  finishReason: string | null
  reasoningText: string
}

/**
 * GLM-REASONING (C1): parse the full chat-completion shape, not just
 * message.content. Reasoning models (GLM-4.5+ / GLM-5.x) emit a sibling
 * `reasoning_content` field that consumes from the same max_tokens budget —
 * when the budget is exhausted mid-reasoning, `content` is "" with
 * finish_reason "length", and the old reader silently turned that into an
 * empty extraction. Pure function: no HTTP, no logging.
 */
export function parseChatCompletion(data: unknown): ParsedChatCompletion {
  const choices = (data as { choices?: unknown[] })?.choices
  const choice = Array.isArray(choices)
    ? (choices[0] as Record<string, unknown> | undefined)
    : undefined
  const message = choice?.message as Record<string, unknown> | undefined
  const content = typeof message?.content === 'string' ? message.content : ''
  const reasoning =
    typeof message?.reasoning_content === 'string' ? (message.reasoning_content as string) : ''
  const finishRaw = choice?.finish_reason
  const finishReason = typeof finishRaw === 'string' && finishRaw ? finishRaw : null
  return { text: content, finishReason, reasoningText: reasoning }
}

/** GLM-REASONING (C1): is this the truncation shape that warrants a budget-doubling retry? */
export function isTruncationWithReasoning(parsed: ParsedChatCompletion): boolean {
  return (
    parsed.text.trim() === '' &&
    parsed.finishReason === 'length' &&
    parsed.reasoningText.trim() !== ''
  )
}

/** GLM-REASONING (C1): hard ceiling for the budget-doubling retry. */
const MAX_TOKENS_RETRY_CEILING = 16_384

/**
 * GLM-REASONING (C1): single chat-completions POST with an explicit
 * max_tokens. Extracted from runOneShotLocal so the truncation retry can
 * re-issue the request with a doubled budget without duplicating the fetch.
 */
async function postChatCompletion(
  opts: OneShotLocalOptions,
  maxTokens: number,
  timeout: number
): Promise<unknown> {
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
    max_tokens: maxTokens,
    stream: false
  })

  try {
    const response = await fetch(
      `${opts.baseUrl}${opts.chatCompletionsPath ?? '/v1/chat/completions'}`,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      }
    )

    if (!response.ok) {
      throw new Error(`Local LLM returned ${response.status}: ${response.statusText}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** GLM-REASONING (C1): usage block of a chat completion (0s when absent). */
function extractUsage(data: unknown): { input: number; output: number } {
  const usage = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
    ?.usage
  const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { input: toNum(usage?.prompt_tokens), output: toNum(usage?.completion_tokens) }
}

/**
 * Make an OpenAI-compatible chat completion request to a local LLM.
 * Falls back to Claude on any failure.
 */
export async function runOneShotLocal(opts: OneShotLocalOptions): Promise<OneShotLocalResult> {
  const timeout = opts.timeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS
  const initialMaxTokens = opts.maxTokens ?? 2048

  try {
    const firstData = await postChatCompletion(opts, initialMaxTokens, timeout)
    let parsed = parseChatCompletion(firstData)
    let finishReason: string | null = parsed.finishReason
    let usage = extractUsage(firstData)

    // GLM-REASONING (C1): truncation-shaped empty content — reasoning tokens
    // ate the whole budget. Retry ONCE with the budget doubled (bounded by
    // MAX_TOKENS_RETRY_CEILING) so the answer fits alongside the reasoning.
    if (isTruncationWithReasoning(parsed) && initialMaxTokens < MAX_TOKENS_RETRY_CEILING) {
      const doubled = Math.min(initialMaxTokens * 2, MAX_TOKENS_RETRY_CEILING)
      localLog.warn(
        `[${opts.feature}] Reasoning model truncated (finish_reason=length, ` +
          `${parsed.reasoningText.length} chars reasoning, empty content) — ` +
          `retrying once with max_tokens ${initialMaxTokens} → ${doubled}`
      )
      const retryData = await postChatCompletion(opts, doubled, timeout)
      const retryParsed = parseChatCompletion(retryData)
      // Adopt the retry when it carries anything usable: its content, or at
      // least its reasoning — the retry ran with the larger budget, so its
      // reasoning trace is the more complete one to fall back to below.
      if (retryParsed.text.trim() !== '' || retryParsed.reasoningText.trim() !== '') {
        parsed = retryParsed
        finishReason = retryParsed.finishReason
        usage = extractUsage(retryData)
      }
    }

    let text = parsed.text
    // GLM-REASONING (C1): doc-sanctioned degradation — for an extraction
    // engine the reasoning trace is far better than a hard failure.
    if (text.trim() === '' && parsed.reasoningText.trim() !== '') {
      localLog.warn(
        `[${opts.feature}] Empty content but non-empty reasoning_content — ` +
          `falling back to reasoning text (${parsed.reasoningText.length} chars)`
      )
      text = parsed.reasoningText
    }

    // Record usage
    usageTrackerService.recordUsage({
      feature: opts.feature,
      model: opts.model,
      workspaceId: opts.workspaceId ?? null,
      conversationId: opts.conversationId ?? null,
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: 0,
        cacheCreation: 0
      }
    })

    localLog.info(
      `[${opts.feature}] Local LLM success — model=${opts.model} in=${usage.input} out=${usage.output}`
    )

    return {
      text,
      provider: 'local',
      model: opts.model,
      wasFallback: false,
      ...(finishReason ? { finishReason } : {})
    }
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

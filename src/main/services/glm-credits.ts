/**
 * GLM Coding Plan credit accounting.
 *
 * A Coding Plan is a subscription with a credit quota, not pay-as-you-go billing, so
 * the USD path in cost-tracker.service is meaningless for GLM workspaces: its pricing
 * table is Claude-only and its unknown-model fallback is Sonnet's $3/$15, which would
 * report confident, fabricated dollar figures for every GLM turn.
 *
 * Two properties of the published rates drive everything here:
 *   - output costs ~3.5x input, so housekeeping belongs on Flash;
 *   - cached input is ~4x cheaper than fresh input, so prompt-prefix stability is the
 *     single biggest lever on quota consumption.
 *
 * Cached input is tracked as its own term. `estimateCostCents` ignores cached tokens
 * entirely, which is survivable for USD estimates and not survivable here.
 */

import {
  GLM_CREDIT_RATES,
  GLM_MCP_CREDITS_PER_CALL,
  GLM_OFF_PEAK_MULTIPLIER,
  GLM_PEAK_WINDOW_UTC8,
  GLM_PLAN_LIMITS
} from '../../shared/constants'
import type { GlmQuotaStatus } from '../../shared/types'

export type { GlmQuotaStatus }

/** Rates are quoted per 10,000 tokens. */
const TOKENS_PER_RATE_UNIT = 10_000

/** Token counts for one GLM turn, with cached input separated from fresh input. */
export interface GlmTokenUsage {
  /** Fresh (uncached) input tokens. */
  inputTokens: number
  /** Input tokens served from GLM's automatic prompt cache. */
  cachedInputTokens: number
  outputTokens: number
  /** GLM-hosted MCP tool calls (Web Search / Web Reader), billed per call. */
  mcpCalls?: number
}

/**
 * Peak pricing applies Mon–Fri 14:00–18:00 in UTC+8; everything else bills at half.
 *
 * `at` is any instant — the UTC+8 wall-clock time is derived from it rather than from
 * the host timezone, so the answer does not change with the user's machine settings.
 */
export function isGlmOffPeak(at: Date = new Date()): boolean {
  const utc8 = new Date(at.getTime() + 8 * 60 * 60_000)
  const day = utc8.getUTCDay() // 0 = Sunday
  const hour = utc8.getUTCHours()
  const isWeekday = day >= 1 && day <= 5
  const inPeakHours = hour >= GLM_PEAK_WINDOW_UTC8.startHour && hour < GLM_PEAK_WINDOW_UTC8.endHour
  return !(isWeekday && inPeakHours)
}

/**
 * Credits consumed by one turn.
 *
 * Unknown model IDs fall back to the frontier (most expensive) rates deliberately: a
 * quota meter that under-reports is worse than one that over-reports, because the
 * failure mode is a surprise 5-hour lockout.
 */
export function estimateGlmCredits(
  usage: GlmTokenUsage,
  modelId: string,
  at: Date = new Date()
): number {
  const rates = GLM_CREDIT_RATES[modelId] ?? mostExpensiveRates()

  const tokenCredits =
    (usage.inputTokens * rates.input +
      usage.cachedInputTokens * rates.cachedInput +
      usage.outputTokens * rates.output) /
    TOKENS_PER_RATE_UNIT

  const mcpCredits = (usage.mcpCalls ?? 0) * GLM_MCP_CREDITS_PER_CALL

  const multiplier = isGlmOffPeak(at) ? GLM_OFF_PEAK_MULTIPLIER : 1
  return (tokenCredits + mcpCredits) * multiplier
}

/** The highest published rate in each dimension — the conservative unknown-model default. */
function mostExpensiveRates(): { input: number; cachedInput: number; output: number } {
  const all = Object.values(GLM_CREDIT_RATES)
  return {
    input: Math.max(...all.map((r) => r.input)),
    cachedInput: Math.max(...all.map((r) => r.cachedInput)),
    output: Math.max(...all.map((r) => r.output))
  }
}

/** Aggregate per-turn credit figures into a quota status for the UI meter. */
export function buildGlmQuotaStatus(
  creditsIn5h: number,
  creditsInWeek: number,
  at: Date = new Date()
): GlmQuotaStatus {
  const { per5h, perWeek } = GLM_PLAN_LIMITS.max
  return {
    creditsIn5h,
    creditsInWeek,
    limit5h: per5h,
    limitWeek: perWeek,
    percentOf5h: per5h > 0 ? (creditsIn5h / per5h) * 100 : 0,
    percentOfWeek: perWeek > 0 ? (creditsInWeek / perWeek) * 100 : 0,
    offPeak: isGlmOffPeak(at)
  }
}

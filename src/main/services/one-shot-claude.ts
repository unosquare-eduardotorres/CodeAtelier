/**
 * one-shot-claude — unified wrapper around a single `claude -p` CLI call that
 * captures token usage into the unified `usage_log` sink.
 *
 * It runs the CLI with `--output-format json` (instead of `text`), parses the
 * single JSON result object for the response text + token usage + model + cost,
 * records the usage via usageTrackerService, and returns the text so existing
 * callers keep working with a one-line change.
 */

import log from 'electron-log/main'
import { runClaudeCliOneShot, type ClaudeOneShotOptions } from './claude-cli-oneshot'
import { usageTrackerService } from './usage-tracker.service'
import { estimateCostCents } from './cost-tracker.service'

const oneShotLog = log.scope('OneShotClaude')

export interface OneShotUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export interface OneShotClaudeResult {
  /** The response text (the CLI's `result` field, or raw stdout on parse failure). */
  text: string
  /** Token usage extracted from the JSON result (zeros when unavailable). */
  usage: OneShotUsage
  /** Resolved model (caller-provided, else parsed from JSON, else null). */
  model: string | null
  /** Estimated cost in cents. */
  costCents: number
}

export interface OneShotClaudeOptions {
  /** CLI args (caller-built). Any existing `--output-format <val>` is replaced with json. */
  args: string[]
  /** Feature bucket for usage_log (condense|goal_decompose|grill_plan|...). */
  feature: string
  /** ACTUAL resolved model. Recorded with usage and used for cost estimation. */
  model?: string | null
  workspaceId?: string | null
  conversationId?: string | null
  /** execFile options (timeout/cwd/maxBuffer). */
  cli?: ClaudeOneShotOptions
  /** Test seam — overrides the CLI runner. Defaults to runClaudeCliOneShot. */
  _runner?: (args: string[], opts?: ClaudeOneShotOptions) => Promise<string>
}

/** Force `--output-format json`, replacing any caller-supplied output format. */
function withJsonOutputFormat(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-format') {
      i++ // skip the format value too
      continue
    }
    out.push(args[i])
  }
  out.push('--output-format', 'json')
  return out
}

interface ParsedOneShot {
  text: string
  usage: OneShotUsage
  model: string | null
  totalCostUsd: number | null
}

/**
 * Parse the JSON produced by `claude -p --output-format json`. The result is a
 * single object: `{ result, usage: { input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens }, total_cost_usd,
 * modelUsage }`. Returns null when stdout is not valid JSON.
 */
export function parseOneShotResult(stdout: string): ParsedOneShot | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    return null
  }

  const result = typeof parsed.result === 'string' ? parsed.result : ''
  const usageObj = (parsed.usage ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const usage: OneShotUsage = {
    input: num(usageObj.input_tokens),
    output: num(usageObj.output_tokens),
    cacheRead: num(usageObj.cache_read_input_tokens),
    cacheCreation: num(usageObj.cache_creation_input_tokens)
  }

  // Model: top-level `model`, else the first key of `modelUsage`.
  let model: string | null = typeof parsed.model === 'string' ? parsed.model : null
  if (!model && parsed.modelUsage && typeof parsed.modelUsage === 'object') {
    const keys = Object.keys(parsed.modelUsage as Record<string, unknown>)
    if (keys.length > 0) model = keys[0]
  }

  const totalCostUsd =
    typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)
      ? parsed.total_cost_usd
      : null

  return { text: result, usage, model, totalCostUsd }
}

/**
 * Run a one-shot `claude` call, record its token usage to the unified
 * usage_log, and return the response text + usage.
 *
 * Usage logging never breaks the call — recording failures are swallowed by
 * usageTrackerService, and a JSON parse failure falls back to returning the raw
 * stdout (no usage recorded).
 */
export async function runOneShotClaude(opts: OneShotClaudeOptions): Promise<OneShotClaudeResult> {
  const runner = opts._runner ?? runClaudeCliOneShot
  const stdout = await runner(withJsonOutputFormat(opts.args), opts.cli)

  const parsed = parseOneShotResult(stdout)

  if (!parsed) {
    oneShotLog.warn(
      `[${opts.feature}] Could not parse JSON result — returning raw stdout, usage not recorded`
    )
    return {
      text: stdout,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      model: opts.model ?? null,
      costCents: 0
    }
  }

  const model = opts.model ?? parsed.model
  const costCents =
    parsed.totalCostUsd != null
      ? Math.round(parsed.totalCostUsd * 100)
      : estimateCostCents(parsed.usage.input, parsed.usage.output, model ?? undefined)

  usageTrackerService.recordUsage({
    feature: opts.feature,
    model: model ?? null,
    workspaceId: opts.workspaceId ?? null,
    conversationId: opts.conversationId ?? null,
    tokens: parsed.usage
  })

  return { text: parsed.text, usage: parsed.usage, model: model ?? null, costCents }
}

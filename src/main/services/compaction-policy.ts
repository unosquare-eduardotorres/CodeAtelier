/**
 * Compaction policy — pure, side-effect-free decision helpers for context
 * compaction. Extracted from AgentStreamProcessor / AgentExecutorFactory so the
 * band-classification and threshold math can be unit-tested deterministically
 * (mirrors the `resolveContextLevel` pattern in ipc/context-usage-level.ts).
 *
 * Nothing here touches state, the DB, the SDK, or emits events. The stateful
 * callers gather inputs, call these functions, then do the emit/log/assignment.
 */

import type { ContextWindowTier } from './context-management'
import { TIER_LIMITS } from './context-management'
import { COMPACTION_RATIOS, AUTO_TO_CRITICAL_MULTIPLIER } from '../../shared/constants'

// ── Compaction band classification ──────────────────────────────────────

/** UI-facing compaction bands emitted via the `compactNeeded` event. */
export type CompactionLevel = 'warning' | 'suggest' | 'critical' | 'auto-compact-pending'

export interface ClassifyCompactionInput {
  /** Current context-window occupancy in tokens. */
  inputTokens: number
  /** Token threshold at which we start suggesting a compact. */
  suggestThreshold: number
  /** Token threshold at which compaction is forced / SDK auto-compact fires. */
  autoThreshold: number
  /** Whether SDK auto-compact is active (drives critical → auto-compact-pending). */
  isAutoCompactEnabled: boolean
  /** Whether a `suggest` was already emitted (debounce state). */
  compactSuggested: boolean
  /** Turns elapsed since the last `suggest` (debounce counter). */
  turnsSinceCompactSuggestion: number
}

export interface ClassifyCompactionResult {
  /** Band to emit, or null when nothing should be emitted this turn. */
  level: CompactionLevel | null
  /** Next value for `compactSuggested` state. */
  nextSuggested: boolean
  /** Next value for `turnsSinceCompactSuggestion` state. */
  nextTurns: number
}

/**
 * Classify the current context usage into a compaction band.
 *
 * Band layout (relative to suggestThreshold S and autoThreshold A):
 *   [0, 0.8·S)   → no event (resets debounce state)
 *   [0.8·S, S)   → `warning` (only while not already suggesting)
 *   [S, A)       → `suggest`, debounced: re-fires at most once every 3 turns
 *   [A, C)       → `auto-compact-pending` if auto-compact on, else `critical`
 *   [C, ∞)       → `critical` always, where C = A × AUTO_TO_CRITICAL_MULTIPLIER
 */
export function classifyCompaction(input: ClassifyCompactionInput): ClassifyCompactionResult {
  const {
    inputTokens,
    suggestThreshold,
    autoThreshold,
    isAutoCompactEnabled,
    compactSuggested,
    turnsSinceCompactSuggestion
  } = input

  const warningThreshold = Math.floor(suggestThreshold * 0.8)

  // Default: leave debounce state untouched.
  const unchanged: ClassifyCompactionResult = {
    level: null,
    nextSuggested: compactSuggested,
    nextTurns: turnsSinceCompactSuggestion
  }

  const criticalCeiling = autoThreshold * AUTO_TO_CRITICAL_MULTIPLIER

  // Above the ceiling the CLI has had its chance and not acted — always surface
  // the modal, even when auto-compact reports as enabled. Guards against the
  // CLI ignoring CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (older claude-code builds).
  if (inputTokens >= criticalCeiling) {
    return {
      level: 'critical',
      nextSuggested: compactSuggested,
      nextTurns: turnsSinceCompactSuggestion
    }
  }

  if (inputTokens >= autoThreshold) {
    return {
      level: isAutoCompactEnabled ? 'auto-compact-pending' : 'critical',
      nextSuggested: compactSuggested,
      nextTurns: turnsSinceCompactSuggestion
    }
  }

  if (inputTokens >= suggestThreshold) {
    if (!compactSuggested || turnsSinceCompactSuggestion >= 3) {
      return { level: 'suggest', nextSuggested: true, nextTurns: 0 }
    }
    return {
      level: null,
      nextSuggested: compactSuggested,
      nextTurns: turnsSinceCompactSuggestion + 1
    }
  }

  if (inputTokens >= warningThreshold && !compactSuggested) {
    return {
      level: 'warning',
      nextSuggested: compactSuggested,
      nextTurns: turnsSinceCompactSuggestion
    }
  }

  if (inputTokens < warningThreshold) {
    // Dropped below the warning zone (e.g. after a compact) — reset debounce.
    return { level: null, nextSuggested: false, nextTurns: 0 }
  }

  return unchanged
}

// ── Threshold resolution ─────────────────────────────────────────────────

export interface CompactionThresholds {
  suggest: number
  auto: number
}

/**
 * Default app-level nudge thresholds derived from a Claude effective window.
 * Uniform 0.6 / 0.75 ratios for every window size — see COMPACTION_RATIOS.
 */
export function resolveCompactionThresholds(effectiveContextWindow: number): CompactionThresholds {
  return {
    suggest: Math.round(effectiveContextWindow * COMPACTION_RATIOS.suggest),
    auto: Math.round(effectiveContextWindow * COMPACTION_RATIOS.auto)
  }
}

export interface ResolveAppliedThresholdsInput {
  /** Local LLM provider — thresholds come from the per-tier table. */
  isLocal: boolean
  /** Tier for local providers (required when isLocal). */
  localTier?: ContextWindowTier
  /** Claude effective window (required when !isLocal). */
  effectiveContextWindow?: number
  /** User-configured override for the suggest threshold (wins when set). */
  userSuggestThreshold?: number
  /** User-configured override for the auto threshold (wins when set). */
  userAutoThreshold?: number
}

/**
 * Resolve the suggest/auto thresholds actually applied to a session.
 *   - Local providers use the fixed per-tier limits (TIER_LIMITS).
 *   - Claude sessions derive defaults from the effective window, with optional
 *     user overrides taking precedence.
 */
export function resolveAppliedThresholds(
  input: ResolveAppliedThresholdsInput
): CompactionThresholds {
  if (input.isLocal) {
    const tier = input.localTier ?? 'small'
    const limits = TIER_LIMITS[tier]
    return { suggest: limits.compactSuggestThreshold, auto: limits.compactAutoThreshold }
  }

  const defaults = resolveCompactionThresholds(input.effectiveContextWindow ?? 200_000)
  return {
    suggest: input.userSuggestThreshold ?? defaults.suggest,
    auto: input.userAutoThreshold ?? defaults.auto
  }
}

// ── Claude CLI compaction env wiring ───────────────────────────────────────

/**
 * The `claude` CLI controls its auto-compact window via env vars, NOT via any
 * argv flag (`contextWindowSize`/`autoCompactEnabled` options are not forwarded
 * to the CLI). To make the documented compaction behaviour real we set:
 *   - CLAUDE_CODE_AUTO_COMPACT_WINDOW = the effective window. 1M-capable models
 *     MUST set 1000000 here or the CLI uses its (smaller) model-default window,
 *     which inflates the context badge and triggers premature compaction.
 *   - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = COMPACTION_RATIOS.auto × 100, applied to
 *     ALL models including 1M. Without it the CLI uses its `usable - 13K`
 *     default (~98% of the window), leaving a large gap where the app has
 *     stopped nudging but the CLI has not yet compacted. Honoured by
 *     claude-code ≥ 2.1.x.
 *
 * Env vars only take effect at process spawn; on continueSession turns the
 * process is already running, so they're a no-op there (still returned for a
 * consistent option shape and testability).
 */
export function resolveClaudeCompactionEnv(effectiveContextWindow: number): Record<string, string> {
  return {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(effectiveContextWindow),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(COMPACTION_RATIOS.auto * 100)
  }
}

/**
 * Whether this install may request API-only beta headers.
 *
 * `--betas` is rejected for subscription/OAuth logins ("Custom betas are only
 * available for API key users"), and Code Atelier ships against Claude Max by
 * default (CLAUDE.md). Requesting it anyway is not merely a no-op: the caller
 * also sizes CLAUDE_CODE_AUTO_COMPACT_WINDOW to 1M, so auto-compact never fires
 * against the real 200K ceiling and the turn overflows silently.
 */
export function canUseContext1MBeta(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODE_ATELIER_CONTEXT_1M === '0') return false
  if (env.CODE_ATELIER_CONTEXT_1M === '1') return true
  return !!env.ANTHROPIC_API_KEY?.trim()
}

/**
 * Resolve the `contextWindowSize` option for the executor. 1M models pass the
 * full window; ≤200K models pass 80% of the window. (Kept for option-shape
 * compatibility — the CLI itself reads the env vars above, not this value.)
 */
export function resolveSdkContextWindowSize(
  supports1M: boolean,
  effectiveContextWindow: number
): number {
  return supports1M ? effectiveContextWindow : Math.round(effectiveContextWindow * 0.8)
}

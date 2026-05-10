/**
 * Context management configuration for Claude sessions.
 *
 * Implements a three-tier cascade (cheapest first):
 *   Tier 1 — PREVENTIVE: Fix autoCompact settings, output budgeting hooks
 *   Tier 2 — SERVER-SIDE EDITING: Tool result clearing, thinking block clearing (zero LLM cost)
 *   Tier 3 — COMPACTION: Server-side summarization (LLM cost, last resort)
 *
 * The SDK subprocess (Claude Code) handles the five-layer compaction pipeline
 * internally when autoCompactEnabled is true. This module configures the
 * thresholds and exclusion rules that feed into that pipeline.
 */

// ── Context Window Tiers ─────────────────────────────────────────────

/** Context window tier — drives tool selection, budgets, and turn limits. */
export type ContextWindowTier = 'small' | 'medium' | 'large'

/** Resolve tier from context window size in tokens */
export function resolveContextTier(contextWindow: number): ContextWindowTier {
  if (contextWindow <= 65_536) return 'small'      // 32K models (Qwen 3B/7B/14B)
  if (contextWindow <= 131_072) return 'medium'     // 128K models (Gemma 4)
  return 'large'                                     // 262K models (Qwen 3.6 MoE, Qwen 3 Coder)
}

/** Per-tier operational limits */
export interface ContextTierLimits {
  /** Max agentic turns (tool-use rounds) before SDK stops the loop */
  maxTurnsPlan: number
  maxTurnsBuild: number
  /** Read hook default line limit */
  readLineLimit: number
  /** Tool result budget (characters per agentic turn) */
  toolResultBudgetChars: number
  /** Compaction thresholds for app-level UI */
  compactSuggestThreshold: number
  compactAutoThreshold: number
}

export const TIER_LIMITS: Record<ContextWindowTier, ContextTierLimits> = {
  small: {
    maxTurnsPlan: 8,
    maxTurnsBuild: 12,
    readLineLimit: 100,             // 100 lines ≈ 1.2K tokens (vs 300 = 3.6K for Claude)
    toolResultBudgetChars: 30_000,  // ~8.5K tokens — leaves room in 32K
    compactSuggestThreshold: 16_000,
    compactAutoThreshold: 24_000,
  },
  medium: {
    maxTurnsPlan: 15,
    maxTurnsBuild: 25,
    readLineLimit: 200,
    toolResultBudgetChars: 100_000, // ~28K tokens — comfortable in 128K
    compactSuggestThreshold: 60_000,
    compactAutoThreshold: 80_000,
  },
  large: {
    maxTurnsPlan: 30,
    maxTurnsBuild: 50,
    readLineLimit: 300,
    toolResultBudgetChars: 200_000, // Same as Claude — 262K is roomy
    compactSuggestThreshold: 120_000,
    compactAutoThreshold: 160_000,
  },
} as const

// ── Context Management Config ────────────────────────────────────────

export interface ContextManagementConfig {
  // ── Tier 2a: Tool result clearing ──
  /** Enable tool result clearing */
  clearToolResults: boolean
  /** Token threshold to trigger tool clearing */
  clearToolResultsTrigger: number
  /** Number of recent tool uses to keep */
  clearToolResultsKeep: number
  /** Minimum tokens to clear per firing (amortizes cache invalidation) */
  clearToolResultsMinClear: number
  /** Tool names excluded from clearing (e.g. memory tools) */
  clearToolResultsExclude: string[]

  // ── Tier 2b: Thinking block clearing ──
  /** Enable thinking block clearing */
  clearThinking: boolean
  /** Number of recent turns whose thinking to keep */
  clearThinkingKeepTurns: number

  // ── Tier 3: Server-side compaction ──
  /** Enable server-side compaction */
  serverCompaction: boolean
  /** Token threshold to trigger compaction */
  serverCompactionTrigger: number
  /** Custom compaction instructions */
  compactionInstructions?: string

  // ── Local LLM tier metadata (only set for local LLM configs) ──
  /** Tier-specific operational limits */
  _tierLimits?: ContextTierLimits
  /** Resolved context tier */
  _tier?: ContextWindowTier
}

/** Default config for Claude sessions with 1M context window */
export const CLAUDE_1M_CONTEXT_CONFIG: ContextManagementConfig = {
  clearToolResults: true,
  clearToolResultsTrigger: 300_000, // 30% of 1M — fire early
  clearToolResultsKeep: 5, // keep last 5 tool results
  clearToolResultsMinClear: 50_000, // clear at least 50K (amortize cache invalidation)
  clearToolResultsExclude: [
    'mcp__memory-control__SearchMemories',
    'mcp__memory-control__GetMemory',
    'mcp__plan-control__ExitPlanMode',
    'mcp__plan-control__AskUserQuestion'
  ],

  clearThinking: true,
  clearThinkingKeepTurns: 2, // keep last 2 turns of thinking

  serverCompaction: true,
  serverCompactionTrigger: 600_000, // 60% of 1M — fire after clearing is insufficient
  compactionInstructions: [
    'Preserve: file paths modified, key decisions made, current plan state,',
    'error patterns encountered, workspace conventions learned.',
    'Discard: verbatim file contents (re-readable), intermediate search results,',
    'tool outputs already acted upon, exploratory dead ends.',
    'Wrap in <summary></summary>.'
  ].join(' ')
} as const

/** Economy mode — lower thresholds for 200K effective window */
export const CLAUDE_ECONOMY_CONTEXT_CONFIG: ContextManagementConfig = {
  ...CLAUDE_1M_CONTEXT_CONFIG,
  clearToolResultsTrigger: 80_000,
  clearToolResultsKeep: 3,
  clearToolResultsMinClear: 20_000,
  serverCompactionTrigger: 150_000,
  clearThinkingKeepTurns: 1
} as const

/** Local LLM mode — tier-aware configuration for context management */
export function getLocalLlmContextConfig(contextWindow: number): ContextManagementConfig {
  const tier = resolveContextTier(contextWindow)
  const limits = TIER_LIMITS[tier]
  return {
    clearToolResults: true,
    clearToolResultsTrigger: Math.round(contextWindow * 0.3),
    clearToolResultsKeep: tier === 'small' ? 2 : 3,
    clearToolResultsMinClear: Math.round(contextWindow * 0.05),
    clearToolResultsExclude: [],  // Local has no memory MCP tools to protect
    clearThinking: false,         // Local LLMs don't use extended thinking
    clearThinkingKeepTurns: 0,
    serverCompaction: false,      // Local LLMs don't support server-side compaction
    serverCompactionTrigger: 0,
    // Attach tier limits for downstream consumers (hooks, maxTurns, diagnostics)
    _tierLimits: limits,
    _tier: tier,
  }
}

/**
 * Context management configuration for Claude sessions.
 *
 * Implements a three-tier cascade (cheapest first):
 *   Tier 1 — PREVENTIVE: SDK hooks (ReadLimit, BashOutputCap, ToolResultBudget)
 *   Tier 2 — SDK AUTO-COMPACT: autoCompactEnabled + autoCompactWindow via Settings
 *   Tier 3 — APP-LEVEL NUDGE: compactSuggestThreshold / compactAutoThreshold → UI modal
 *
 * ⚠️ IMPORTANT: The clearToolResults*, clearThinking*, and serverCompaction*
 * fields in ContextManagementConfig are NOT forwarded to the SDK. The Claude
 * Agent SDK's Settings type only accepts autoCompactEnabled, autoCompactWindow,
 * and compactInstructions. These fields serve as:
 *   - Tier metadata for hook parameterization (_tierLimits, _tier)
 *   - App-level diagnostics and UI threshold configuration
 *   - Future-proofing for when the SDK adds server-side clearing APIs
 *   - Documentation of the intended compaction strategy
 *
 * The SDK subprocess (Claude Code) handles the compaction pipeline internally
 * when autoCompactEnabled is true. The contextWindowSize passed to the SDK
 * controls when auto-compact fires (~80-95% of that value). For 200K models
 * (Opus/Haiku), we shrink contextWindowSize to 160K and set
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 so compaction fires at ~128K tokens.
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

/**
 * App-level context management config. Passed as `contextManagement` to the SDK
 * but the SDK only reads `compactionInstructions` from it — all other fields are
 * consumed by app-level hooks and UI logic, NOT by the SDK's compaction engine.
 */
export interface ContextManagementConfig {
  // ── App-level: Tool result clearing (not SDK-forwarded) ──
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

/**
 * Config for Claude sessions using the default 200K context window (Opus, Haiku).
 * The context-1m beta is NOT active — thresholds scaled proportionally to 200K.
 */
export const CLAUDE_200K_CONTEXT_CONFIG: ContextManagementConfig = {
  clearToolResults: true,
  clearToolResultsTrigger: 60_000,    // 30% of 200K
  clearToolResultsKeep: 3,
  clearToolResultsMinClear: 10_000,
  clearToolResultsExclude: [...CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsExclude],

  clearThinking: true,
  clearThinkingKeepTurns: 1,

  serverCompaction: true,
  serverCompactionTrigger: 120_000,   // 60% of 200K
  compactionInstructions: CLAUDE_1M_CONTEXT_CONFIG.compactionInstructions,
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

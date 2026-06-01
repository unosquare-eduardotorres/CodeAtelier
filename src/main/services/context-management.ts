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
 * The `claude` CLI handles the compaction pipeline internally. Note the CLI
 * does NOT read `contextWindowSize`/`autoCompactEnabled` from argv — those are
 * not forwarded as flags. The compaction window is controlled purely via
 * process env vars, wired in agent-executor-factory.ts (resolveClaudeCompactionEnv):
 *   - CLAUDE_CODE_AUTO_COMPACT_WINDOW = effective window. 1M models MUST set
 *     1000000 here or the CLI falls back to its smaller model-default window
 *     (which inflates the context badge and triggers premature auto-compact).
 *   - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 for 200K models (Opus<=4.7/Haiku), so
 *     auto-compact fires at ~80% of the usable window (~128-152K) instead of
 *     the usable-13K default. Honoured by claude-code >= 2.1.x.
 */

// ── Context Window Tiers ─────────────────────────────────────────────

/** Context window tier — drives tool selection, budgets, and turn limits. */
export type ContextWindowTier = 'small' | 'medium' | 'large'

/** Resolve tier from context window size in tokens */
export function resolveContextTier(contextWindow: number): ContextWindowTier {
  if (contextWindow <= 65_536) return 'small' // 32K models (Qwen 3B/7B/14B)
  if (contextWindow <= 131_072) return 'medium' // 128K models (Gemma 4)
  return 'large' // 262K models (Qwen 3.6 MoE, Qwen 3 Coder)
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
  /**
   * S11: SDK built-in tools allowed in plan mode (local LLM only).
   * Restricts the tool schema overhead for small/medium context windows.
   * Omit or empty array = no restriction (all builtins available).
   */
  planBuiltinAllowlist?: string[]
}

/**
 * S11: SDK built-in tools allowed in local LLM plan mode.
 * Small tier: read-only exploration only (saves ~8-10K tokens in tool schemas).
 * Medium tier: adds Bash for running type-checks / grep commands.
 * Large tier: no restriction (all builtins available).
 */
const LOCAL_PLAN_BUILTIN_SMALL = ['Read', 'Glob', 'Grep'] as const
const LOCAL_PLAN_BUILTIN_MEDIUM = ['Read', 'Glob', 'Grep', 'Bash'] as const

export const TIER_LIMITS: Record<ContextWindowTier, ContextTierLimits> = {
  small: {
    maxTurnsPlan: 12, // Increased from 8 — simple plans need ~6 exploration + ~4 writing turns
    maxTurnsBuild: 15, // Increased from 12 — matched to plan+buffer
    readLineLimit: 100, // 100 lines ≈ 1.2K tokens (vs 300 = 3.6K for Claude)
    toolResultBudgetChars: 30_000, // ~8.5K tokens — leaves room in 32K
    compactSuggestThreshold: 16_000,
    compactAutoThreshold: 24_000,
    planBuiltinAllowlist: [...LOCAL_PLAN_BUILTIN_SMALL]
  },
  medium: {
    maxTurnsPlan: 15,
    maxTurnsBuild: 25,
    readLineLimit: 200,
    toolResultBudgetChars: 100_000, // ~28K tokens — comfortable in 128K
    compactSuggestThreshold: 60_000,
    compactAutoThreshold: 80_000,
    planBuiltinAllowlist: [...LOCAL_PLAN_BUILTIN_MEDIUM]
  },
  large: {
    maxTurnsPlan: 30,
    maxTurnsBuild: 50,
    readLineLimit: 300,
    toolResultBudgetChars: 200_000, // Same as Claude — 262K is roomy
    compactSuggestThreshold: 120_000,
    compactAutoThreshold: 160_000
    // No planBuiltinAllowlist — large tier gets all built-in tools
  }
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
  clearToolResultsTrigger: 60_000, // 30% of 200K
  clearToolResultsKeep: 3,
  clearToolResultsMinClear: 10_000,
  clearToolResultsExclude: [...CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsExclude],

  clearThinking: true,
  clearThinkingKeepTurns: 1,

  serverCompaction: true,
  serverCompactionTrigger: 120_000, // 60% of 200K
  compactionInstructions: CLAUDE_1M_CONTEXT_CONFIG.compactionInstructions
} as const

/**
 * S13: Structured compaction instructions for local LLMs.
 *
 * Used by both SDK auto-compact (oMLX, S14) and app-level compaction (S7).
 * The structured template ensures the model produces useful summaries that
 * preserve file paths and plan progress while discarding raw tool output.
 */
export const LOCAL_COMPACTION_INSTRUCTIONS = [
  'Summarize using this exact structure:',
  '## Goal: [what the user wants to accomplish]',
  '## Files Found: [exact file paths explored, one per line]',
  '## Key Findings: [important code patterns, component locations, line ranges]',
  '## Plan So Far: [numbered list of changes identified]',
  '## Next Steps: [what remains to be done]',
  'Keep file paths exact. Omit file contents (they can be re-read).',
  'Do NOT include tool call details or conversation meta-data.'
].join('\n')

/**
 * Local LLM mode — tier-aware configuration for context management.
 *
 * @param contextWindow - The context window size in tokens
 * @param isOmlx - Whether the backend is oMLX (enables compaction instructions)
 */
export function getLocalLlmContextConfig(
  contextWindow: number,
  isOmlx = false
): ContextManagementConfig {
  const tier = resolveContextTier(contextWindow)
  const limits = TIER_LIMITS[tier]
  return {
    clearToolResults: true,
    clearToolResultsTrigger: Math.round(contextWindow * 0.3),
    clearToolResultsKeep: tier === 'small' ? 2 : 3,
    clearToolResultsMinClear: Math.round(contextWindow * 0.05),
    clearToolResultsExclude: [], // Local has no memory MCP tools to protect
    clearThinking: false, // Local LLMs don't use extended thinking
    clearThinkingKeepTurns: 0,
    serverCompaction: isOmlx, // S14: oMLX supports server-side compaction via auto-compact
    serverCompactionTrigger: isOmlx ? Math.round(contextWindow * 0.6) : 0,
    // S13: Structured compaction instructions for auto-compact quality
    compactionInstructions: isOmlx ? LOCAL_COMPACTION_INSTRUCTIONS : undefined,
    // Attach tier limits for downstream consumers (hooks, maxTurns, diagnostics)
    _tierLimits: limits,
    _tier: tier
  }
}

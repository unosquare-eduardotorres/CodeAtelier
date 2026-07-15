/**
 * Tests for buildWorkspaceMcpConfig — the exported entry point that dispatches
 * to buildLocalProviderMcpConfig or buildClaudeProviderMcpConfig.
 *
 * The `app` import from electron works under tsx (returns a stub), so we can
 * import the module directly. We bypass `mountExternalMcps` by passing
 * `externalMcpActive: {}` (empty → loop body never executes).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildWorkspaceMcpConfig } from '../workspace-mcp-config'
type BuildMcpConfigOpts = any
type McpFeatureFlags = any
import type { ContextWindowTier } from '../context-management'
import { MCP_TOOLS } from '../../../shared/constants'

// ── Helpers ──────────────────────────────────────────────────────────────

/** No-op control callbacks (satisfy the ControlActionCallbacks type) */
const NOOP_CALLBACKS = {
  emitPlan: () => {},
  askUser: () => Promise.resolve(''),
  emitMemory: () => {}
}

function baseFlags(overrides: Partial<McpFeatureFlags> = {}): McpFeatureFlags {
  return {
    repomapEnabled: true,
    semanticSearchEnabled: true,
    githubConfigured: false,
    externalMcpActive: {},
    localMcpActive: {},
    ...overrides
  }
}

function makeOpts(overrides: Partial<BuildMcpConfigOpts> = {}): BuildMcpConfigOpts {
  return {
    mode: 'build',
    workspacePath: '/tmp/test-ws',
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    featureFlags: baseFlags(),
    controlCallbacks: NOOP_CALLBACKS as any,
    ...overrides
  }
}

// Constant references
const ESSENTIAL_CG: string[] = [
  MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name,
  MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name,
  MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.name,
  MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.name,
  MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.name,
  MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name
]

const ALL_CG = MCP_TOOLS.CODE_GRAPH._ALL_NAMES
const CONTROL_TOOLS = MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES

// ── Dispatch tests ───────────────────────────────────────────────────────

describe('buildWorkspaceMcpConfig — dispatch', () => {
  test('isLocalProvider=false dispatches to Claude path (no planBuiltinDisallowed)', () => {
    const result = buildWorkspaceMcpConfig(makeOpts({ isLocalProvider: false }))
    assert.equal(result.planBuiltinDisallowed, undefined)
  })

  test('isLocalProvider=true dispatches to local path (planBuiltinDisallowed may exist)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    // Local plan+small tier should produce a planBuiltinDisallowed array
    assert.ok(Array.isArray(result.planBuiltinDisallowed))
  })
})

// ── buildLocalProviderMcpConfig (via buildWorkspaceMcpConfig) ─────────

describe('buildLocalProviderMcpConfig — small tier', () => {
  test('small tier → only 6 essential CG tools + 3 control tools in allowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    // Plan mode generates an allowedTools list
    assert.ok(Array.isArray(result.allowedTools))
    for (const tool of ESSENTIAL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing essential CG tool: ${tool}`)
    }
    for (const tool of CONTROL_TOOLS) {
      assert.ok(result.allowedTools!.includes(tool), `Missing control tool: ${tool}`)
    }
  })

  test('small tier → excludes non-essential CG tools from allowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    const nonEssentialCG = ALL_CG.filter((t) => !ESSENTIAL_CG.includes(t))
    for (const tool of nonEssentialCG) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('small tier → excludes semantic-search tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('small tier → excludes code-analysis tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('small tier → populates smallTierDisallowed in disallowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    // Non-essential CG tools should appear in disallowedTools
    const nonEssentialCG = ALL_CG.filter((t) => !ESSENTIAL_CG.includes(t))
    for (const tool of nonEssentialCG) {
      assert.ok(result.disallowedTools.includes(tool), `Missing from disallowed: ${tool}`)
    }
    // Semantic-search and code-analysis should also be in disallowed
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(result.disallowedTools.includes(tool), `Missing from disallowed: ${tool}`)
    }
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(result.disallowedTools.includes(tool), `Missing from disallowed: ${tool}`)
    }
  })
})

describe('buildLocalProviderMcpConfig — medium tier', () => {
  test('medium tier → includes full CG tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'plan' })
    )
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing CG tool: ${tool}`)
    }
  })

  test('medium tier → includes semantic-search tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        featureFlags: baseFlags({ semanticSearchEnabled: true })
      })
    )
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing semantic-search tool: ${tool}`)
    }
  })

  test('medium tier → includes code-analysis tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'plan' })
    )
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing code-analysis tool: ${tool}`)
    }
  })

  test('medium tier → no smallTierDisallowed entries in disallowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'build' })
    )
    // Non-essential CG tools should NOT be in disallowedTools (they're allowed)
    const nonEssentialCG = ALL_CG.filter((t) => !ESSENTIAL_CG.includes(t))
    for (const tool of nonEssentialCG) {
      assert.ok(!result.disallowedTools.includes(tool), `Should not be disallowed: ${tool}`)
    }
  })
})

describe('buildLocalProviderMcpConfig — large tier', () => {
  test('large tier → includes all CG + semantic-search + code-analysis', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'large',
        mode: 'plan',
        featureFlags: baseFlags({ semanticSearchEnabled: true })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('large tier → defaults when contextTier is omitted', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, mode: 'plan' })
    )
    // omitting contextTier defaults to 'large' — should include all CG
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })
})

describe('buildLocalProviderMcpConfig — feature flag combos', () => {
  test('codeGraph disabled (repomapEnabled=false) → no CG tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        featureFlags: baseFlags({ repomapEnabled: false })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('workspaceId=null → no CG tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        workspaceId: null
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('localMcpActive code-graph=false → no CG tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'code-graph': false } })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('localMcpActive semantic-search=false → no semantic-search tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'semantic-search': false } })
      })
    )
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('localMcpActive code-analysis=false → no code-analysis tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'medium',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'code-analysis': false } })
      })
    )
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('build mode → allowedTools is undefined (all tools allowed)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'build' })
    )
    assert.equal(result.allowedTools, undefined)
  })

  test('control actions always present in plan mode (any tier)', () => {
    for (const tier of ['small', 'medium', 'large'] as ContextWindowTier[]) {
      const result = buildWorkspaceMcpConfig(
        makeOpts({ isLocalProvider: true, contextTier: tier, mode: 'plan' })
      )
      for (const tool of CONTROL_TOOLS) {
        assert.ok(
          result.allowedTools!.includes(tool),
          `Missing control tool in ${tier}: ${tool}`
        )
      }
    }
  })
})

// ── buildClaudeProviderMcpConfig (via buildWorkspaceMcpConfig) ────────

describe('buildClaudeProviderMcpConfig — build mode', () => {
  test('build mode → allowedTools is undefined', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'build' })
    )
    assert.equal(result.allowedTools, undefined)
  })

  test('build mode → disallowedTools contains Agent, ToolSearch etc.', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'build' })
    )
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('ToolSearch'))
  })

  test('build mode → no mcpServers when externalMcpActive is empty', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'build' })
    )
    assert.equal(result.mcpServers, undefined)
  })
})

describe('buildClaudeProviderMcpConfig — plan mode', () => {
  test('plan mode → allowedTools is an array', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    assert.ok(Array.isArray(result.allowedTools))
  })

  test('plan mode → base allowed includes Read, Glob, Grep, Bash', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    assert.ok(result.allowedTools!.includes('Read'))
    assert.ok(result.allowedTools!.includes('Glob'))
    assert.ok(result.allowedTools!.includes('Grep'))
    assert.ok(result.allowedTools!.includes('Bash'))
  })

  test('plan mode → CG tools included when repomapEnabled + workspaceId', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('plan mode → semantic-search tools when enabled', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ semanticSearchEnabled: true })
      })
    )
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('plan mode → no semantic-search when semanticSearchEnabled=false', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ semanticSearchEnabled: false })
      })
    )
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode → git-context tools always present (default localMcpActive)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    for (const tool of MCP_TOOLS.GIT_CONTEXT._ALL_NAMES) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('plan mode → git-context disabled via localMcpActive', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'git-context': false } })
      })
    )
    for (const tool of MCP_TOOLS.GIT_CONTEXT._ALL_NAMES) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode → github-context only when githubConfigured=true', () => {
    const withGithub = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ githubConfigured: true })
      })
    )
    for (const tool of MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES) {
      assert.ok(withGithub.allowedTools!.includes(tool), `Missing: ${tool}`)
    }

    const withoutGithub = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ githubConfigured: false })
      })
    )
    for (const tool of MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES) {
      assert.ok(!withoutGithub.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode → control actions always present', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    for (const tool of CONTROL_TOOLS) {
      assert.ok(result.allowedTools!.includes(tool), `Missing control tool: ${tool}`)
    }
  })

  test('plan mode → allowedTools includes Write, Edit (Claude permission-mode gates them)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    // Write/Edit are exposed in the tool list so that a live
    // set_permission_mode(plan→acceptEdits) switch unlocks them without respawn.
    // --permission-mode plan gates writes at runtime.
    assert.ok(result.allowedTools!.includes('Write'), 'Write should be in allowedTools')
    assert.ok(result.allowedTools!.includes('Edit'), 'Edit should be in allowedTools')
  })

  test('plan mode → disallowedTools does NOT include Write, Edit (Claude path strips them)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    assert.ok(!result.disallowedTools.includes('Write'), 'Write should not be disallowed on Claude path')
    assert.ok(!result.disallowedTools.includes('Edit'), 'Edit should not be disallowed on Claude path')
  })

  test('plan mode → no planBuiltinDisallowed for Claude path', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    assert.equal(result.planBuiltinDisallowed, undefined)
  })
})

// ── resolvePlanBuiltinDisallowed (tested via local provider path) ─────

describe('resolvePlanBuiltinDisallowed — via local provider', () => {
  test('build mode → no planBuiltinDisallowed', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'build' })
    )
    assert.equal(result.planBuiltinDisallowed, undefined)
  })

  test('plan + small tier → planBuiltinDisallowed filters ALL_BUILTINS by small allowlist', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    assert.ok(Array.isArray(result.planBuiltinDisallowed))
    // Small tier allowlist is ['Read', 'Glob', 'Grep'] — so Write, Edit, Bash etc. should be disallowed
    assert.ok(result.planBuiltinDisallowed!.includes('Write'))
    assert.ok(result.planBuiltinDisallowed!.includes('Edit'))
    assert.ok(result.planBuiltinDisallowed!.includes('Bash'))
    // Read, Glob, Grep should NOT be disallowed
    assert.ok(!result.planBuiltinDisallowed!.includes('Read'))
    assert.ok(!result.planBuiltinDisallowed!.includes('Glob'))
    assert.ok(!result.planBuiltinDisallowed!.includes('Grep'))
  })

  test('plan + medium tier → planBuiltinDisallowed filters by medium allowlist', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'plan' })
    )
    assert.ok(Array.isArray(result.planBuiltinDisallowed))
    // Medium allowlist is ['Read', 'Glob', 'Grep', 'Bash'] — Bash now allowed
    assert.ok(!result.planBuiltinDisallowed!.includes('Bash'))
    assert.ok(!result.planBuiltinDisallowed!.includes('Read'))
    // Write, Edit should still be disallowed
    assert.ok(result.planBuiltinDisallowed!.includes('Write'))
    assert.ok(result.planBuiltinDisallowed!.includes('Edit'))
  })

  test('plan + large tier → no planBuiltinDisallowed (no allowlist on large)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'large', mode: 'plan' })
    )
    // Large tier has no planBuiltinAllowlist → returns undefined
    assert.equal(result.planBuiltinDisallowed, undefined)
  })

  test('planBuiltinDisallowed items also appear in disallowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'small', mode: 'plan' })
    )
    if (result.planBuiltinDisallowed) {
      for (const tool of result.planBuiltinDisallowed) {
        assert.ok(
          result.disallowedTools.includes(tool),
          `planBuiltinDisallowed "${tool}" not in disallowedTools`
        )
      }
    }
  })
})

// ── isLocalMcpEnabled logic (tested via behavior) ────────────────────

describe('isLocalMcpEnabled — behavior tests', () => {
  test('undefined localMcpActive → all MCP servers enabled (backward-compat)', () => {
    // Empty {} is the default — all keys missing → enabled
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'large',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: {} })
      })
    )
    // All CG tools should be present
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('explicit true → server enabled', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'large',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'code-graph': true } })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })

  test('explicit false → server disabled', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'large',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'code-graph': false } })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools!.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('different key (unrelated) → code-graph still enabled', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'large',
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'semantic-search': false } })
      })
    )
    // code-graph key is missing from localMcpActive → enabled
    for (const tool of ALL_CG) {
      assert.ok(result.allowedTools!.includes(tool), `Missing: ${tool}`)
    }
  })
})

// ── Claude vs Local: Write/Edit gating divergence ──

describe('Claude vs Local path — Write/Edit gating', () => {
  test('local-provider plan mode still disallows Write/Edit (unchanged behavior)', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'plan' })
    )
    assert.ok(result.disallowedTools.includes('Write'), 'Local path should disallow Write in plan mode')
    assert.ok(result.disallowedTools.includes('Edit'), 'Local path should disallow Edit in plan mode')
  })

  test('local-provider plan mode does NOT include Write/Edit in allowedTools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'medium', mode: 'plan' })
    )
    assert.ok(!result.allowedTools!.includes('Write'), 'Local path should not allow Write in plan mode')
    assert.ok(!result.allowedTools!.includes('Edit'), 'Local path should not allow Edit in plan mode')
  })

  test('Claude plan mode exposes Write/Edit; local plan mode does not', () => {
    const claude = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: false, mode: 'plan' })
    )
    const local = buildWorkspaceMcpConfig(
      makeOpts({ isLocalProvider: true, contextTier: 'large', mode: 'plan' })
    )
    // Claude: Write/Edit in allowed, not in disallowed
    assert.ok(claude.allowedTools!.includes('Write'), 'Claude should allow Write')
    assert.ok(!claude.disallowedTools.includes('Write'), 'Claude should not disallow Write')
    // Local: Write/Edit in disallowed, not in allowed
    assert.ok(local.allowedTools!.includes('Write') === false || local.allowedTools === undefined,
      'Local should not allow Write in plan mode')
    assert.ok(local.disallowedTools.includes('Write'), 'Local should disallow Write')
  })
})

// ── Phase 6A: additional coverage for uncovered branches ──

describe('buildLocalProviderMcpConfig — small tier + codeGraph disabled', () => {
  test('small tier + repomapEnabled=false → smallTierDisallowed has no CG filter entries', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: true,
        contextTier: 'small',
        mode: 'plan',
        featureFlags: baseFlags({ repomapEnabled: false })
      })
    )
    // CG tools should NOT be in allowedTools (disabled)
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools?.includes(tool), `CG tool should not be allowed: ${tool}`)
    }
    // Semantic-search + code-analysis should still be in disallowed (small tier gating)
    for (const tool of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(result.disallowedTools.includes(tool), `Should still disallow: ${tool}`)
    }
  })
})

describe('buildClaudeProviderMcpConfig — plan mode toggle combos', () => {
  test('plan mode + checkpoint-context disabled → no checkpoint tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'checkpoint-context': false } })
      })
    )
    for (const tool of MCP_TOOLS.CHECKPOINT_CONTEXT._ALL_NAMES) {
      assert.ok(!result.allowedTools?.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode + code-analysis disabled → no code-analysis tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ localMcpActive: { 'code-analysis': false } })
      })
    )
    for (const tool of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(!result.allowedTools?.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode + repomapEnabled=false → no CG tools in allowed list', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ repomapEnabled: false })
      })
    )
    for (const tool of ALL_CG) {
      assert.ok(!result.allowedTools?.includes(tool), `Should not include: ${tool}`)
    }
  })

  test('plan mode + github enabled → includes github-context tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ githubConfigured: true })
      })
    )
    for (const tool of MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES) {
      assert.ok(result.allowedTools?.includes(tool), `Missing github tool: ${tool}`)
    }
  })

  test('plan mode + github disabled → no github-context tools', () => {
    const result = buildWorkspaceMcpConfig(
      makeOpts({
        isLocalProvider: false,
        mode: 'plan',
        featureFlags: baseFlags({ githubConfigured: false })
      })
    )
    for (const tool of MCP_TOOLS.GITHUB_CONTEXT._ALL_NAMES) {
      assert.ok(!result.allowedTools?.includes(tool), `Should not include: ${tool}`)
    }
  })
})

// ── Summary ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

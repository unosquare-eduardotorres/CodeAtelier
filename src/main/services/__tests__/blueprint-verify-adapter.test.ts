/**
 * Unit tests for BlueprintVerifyAdapter — read-only + Bash verification adapter.
 *
 * Tests: constructor identity, getModelAction, getPhaseMessage content (4-level methodology),
 * buildMcpConfig (read + Bash, no Write/Edit), code-graph conditional.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

// E3's preference read reaches db/index (and its `.sql?raw` import). The adapter
// requires it lazily so this file still loads without a database, but the stub
// is installed anyway for the cases that exercise the enabled path. Idempotent.
setupElectronStub()

import { BlueprintVerifyAdapter } from '../role-adapters/blueprint/blueprint-verify.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'
import type { PhaseContext } from '../../../shared/blueprint-types'
import { MCP_TOOLS } from '../../../shared/constants'

const basePhaseContext: PhaseContext = {
  blueprint: {
    id: 'bp-1',
    title: 'Test Blueprint',
    shortName: 'test-bp',
    description: 'A test blueprint',
    priority: 'P2',
    currentPhase: 'verify',
    settings: {}
  },
  constitution: null,
  previousArtifacts: [],
  specFilePath: '/tmp/spec.md',
  blueprintDir: '/tmp/blueprint'
}

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'verify',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    sessionId: undefined,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/bp-verify-test',
    workspaceId: 'ws-bv1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
    ...overrides
  }
}

describe('BlueprintVerifyAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_blueprint_verify', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    assert.equal(adapter.role, 'blueprint-verify')
  })

  test('agentId_includes_blueprintId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-55',
      phaseContext: basePhaseContext
    })
    assert.equal(adapter.agentId, 'blueprint-verify-bp-55')
  })

  // ── getModelAction ──

  test('getModelAction_returns_blueprint_verify', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const action = (adapter as any).getModelAction()
    assert.equal(action, 'blueprint:verify')
  })

  // ── getPhaseMessage ──

  test('getPhaseMessage_contains_4_level_artifact_verification', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    // Pass empty message so buildPrompts falls through to getPhaseMessage()
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('4-level artifact verification methodology'))
  })

  test('getPhaseMessage_contains_EXISTS_SUBSTANTIVE_WIRED_DATA_FLOWING', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('EXISTS'))
    assert.ok(result.effectiveMessage.includes('SUBSTANTIVE'))
    assert.ok(result.effectiveMessage.includes('WIRED'))
    assert.ok(result.effectiveMessage.includes('DATA FLOWING'))
  })

  test('getPhaseMessage_contains_blueprint_phase_complete', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('blueprint-phase-complete'))
  })

  // ── buildMcpConfig (read + Bash, no Write/Edit) ──

  test('buildMcpConfig_allowedTools_includes_Read_Bash_ListDir', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
    assert.ok(allowedTools.includes('Bash'))
    assert.ok(allowedTools.includes('ListDir'))
    assert.ok(allowedTools.includes('Glob'))
    assert.ok(allowedTools.includes('Grep'))
  })

  test('buildMcpConfig_allowedTools_does_NOT_include_Write_Edit', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.includes('Write'))
    assert.ok(!allowedTools.includes('Edit'))
  })

  test('buildMcpConfig_disallowedTools_includes_Write_Edit_Agent', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(disallowedTools.includes('Write'))
    assert.ok(disallowedTools.includes('Edit'))
    assert.ok(disallowedTools.includes('Agent'))
    assert.ok(disallowedTools.includes('ToolSearch'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  // ── Memory tools ──

  test('buildMcpConfig_includes_memory_tools_when_workspaceId_present', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.MEMORY._ALL_NAMES) {
      assert.ok(allowedTools.includes(name), `should include ${name}`)
    }
  })

  test('buildMcpConfig_excludes_memory_tools_without_workspaceId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__memory__')))
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // ── E3: flag-gated feature-diff injection ──

  describe('E3 — feature diff in the first message', () => {
    /**
     * Build an adapter with both seams stubbed. The adapter loads the
     * preference and diff modules lazily and their ESM namespaces are frozen,
     * so overriding the protected methods is the only way in — the same seam
     * pattern `overloadBackoffMs` uses in blueprint-build.service.
     */
    function makeAdapter(opts: { enabled: boolean; diff?: string | null }): any {
      const adapter: any = new BlueprintVerifyAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext: basePhaseContext,
        workspacePath: '/tmp/does-not-matter'
      })
      adapter.verifyDiffEnabled = (): boolean => opts.enabled
      adapter.loadFeatureDiff = (): string | null =>
        opts.diff === undefined ? null : opts.diff
      return adapter
    }

    test('flag OFF leaves the message byte-for-byte unchanged', () => {
      const withPath = makeAdapter({
        enabled: false,
        diff: 'diff --git a/x b/x'
      }).getPhaseMessage()
      // The same adapter with no workspacePath cannot inject at all, so it is
      // the reference for "what the message was before E3".
      const noPath = new BlueprintVerifyAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext: basePhaseContext
      }).getPhaseMessage()

      assert.equal(withPath, noPath, 'default-off must not even change whitespace')
      assert.ok(!withPath.includes('```diff'))
    })

    test('flag ON injects the diff with the anti-anchoring framing', () => {
      const msg = makeAdapter({
        enabled: true,
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1'
      }).getPhaseMessage()
      assert.ok(msg.includes('```diff'), 'diff is fenced')
      assert.ok(msg.includes('export const a = 1'), 'diff content present')

      // The framing is the whole safeguard. A diff shows what was WRITTEN while
      // levels 1-2 of the methodology are about what is MISSING; without this
      // sentence the phase trades thoroughness for speed and reports the trade
      // as a higher pass rate.
      assert.ok(
        msg.includes('Use it to orient, not to scope'),
        'anti-anchoring framing must accompany the diff'
      )
      assert.ok(
        msg.includes('a finding, not an absence of evidence'),
        'the missing-requirement case must be stated explicitly'
      )

      // The methodology must still lead — the diff orients, it does not replace.
      assert.ok(msg.includes('4-level artifact verification methodology'))
      assert.ok(msg.includes('blueprint-phase-complete'), 'completion contract intact')
    })

    test('flag ON but no diff available injects nothing', () => {
      // null = no baseline / git failed. '' = clean tree. Neither is a section:
      // an empty fence would read as "BUILD changed nothing", which is a claim.
      for (const diff of [null, '']) {
        const msg = makeAdapter({ enabled: true, diff }).getPhaseMessage()
        assert.ok(!msg.includes('```diff'), `no section for ${JSON.stringify(diff)}`)
      }
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

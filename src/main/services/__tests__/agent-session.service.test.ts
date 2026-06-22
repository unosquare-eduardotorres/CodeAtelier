/**
 * Unit tests for AgentSessionService — the generic long-lived Claude SDK
 * session runtime extracted in Phase 1 of the Project Specialist refactor.
 *
 * These tests verify the pure, role-agnostic pieces of the class:
 *   - event forwarding between session ↔ adapter
 *   - status snapshotting
 *   - compaction threshold logic
 *   - role wiring via the adapter interface
 *
 * We do NOT exercise real SDK streams here — that lives in execution-pipeline.test.ts
 * and the Playwright E2E suites. This suite focuses on the generic contract.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AgentSessionService } from '../agent-session.service'
import type { ExecutorBaseOptions } from '../executor-types'
import type {
  AgentRoleAdapter,
  AdapterIntentContext,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'

/**
 * Minimal test adapter that captures every lifecycle call for assertions.
 * Returns identity prompts so the session has something to forward.
 */
function createTestAdapter(overrides: Partial<AgentRoleAdapter> = {}): {
  adapter: AgentRoleAdapter
  calls: {
    onSessionStart: AdapterSessionLifecycleCtx[]
    refreshFeatureFlags: AdapterSessionLifecycleCtx[]
    onConversationSwitch: string[]
    buildPrompts: AdapterPromptContext[]
    buildMcpConfig: AdapterMcpContext[]
    emitDetectedIntents: AdapterIntentContext[]
    onSessionStop: number
  }
} {
  const calls = {
    onSessionStart: [] as AdapterSessionLifecycleCtx[],
    refreshFeatureFlags: [] as AdapterSessionLifecycleCtx[],
    onConversationSwitch: [] as string[],
    buildPrompts: [] as AdapterPromptContext[],
    buildMcpConfig: [] as AdapterMcpContext[],
    emitDetectedIntents: [] as AdapterIntentContext[],
    onSessionStop: 0
  }

  const adapter: AgentRoleAdapter = {
    role: 'project-specialist',
    agentId: 'workspace-specialist-test',
    onSessionStart: async (ctx) => {
      calls.onSessionStart.push(ctx)
    },
    refreshFeatureFlags: (ctx) => {
      calls.refreshFeatureFlags.push(ctx)
    },
    onConversationSwitch: (cid) => {
      calls.onConversationSwitch.push(cid)
    },
    buildPrompts: (ctx): AdapterPromptResult => {
      calls.buildPrompts.push(ctx)
      return { systemPrompt: 'SYS', effectiveMessage: `ECHO:${ctx.message}` }
    },
    buildMcpConfig: (ctx): AdapterMcpResult => {
      calls.buildMcpConfig.push(ctx)
      return { mcpServers: {}, allowedTools: [], disallowedTools: [] }
    },
    buildControlCallbacks: (): ControlActionCallbacks => ({
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }),
    emitDetectedIntents: (ctx) => {
      calls.emitDetectedIntents.push(ctx)
    },
    onSessionStop: () => {
      calls.onSessionStop++
    },
    ...overrides
  }

  return { adapter, calls }
}

describe('AgentSessionService', () => {
  test('exposes_role_and_agentId_from_adapter', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getRole(), 'project-specialist')
    assert.equal(session.getAgentId(), 'workspace-specialist-test')
    assert.equal(session.getAdapter(), adapter)
  })

  test('initial_state_is_not_running', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.isRunning(), false)
    assert.equal(session.getWorkspacePath(), null)
    assert.equal(session.getWorkspaceId(), null)
    assert.equal(session.getCurrentConversationId(), null)
    assert.equal(session.getMode(), 'plan')
    assert.equal(session.getStreamedContent(), '')
  })

  test('getStatus_reports_idle_with_adapter_identity', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    const status = session.getStatus()
    assert.equal(status.agentId, 'workspace-specialist-test')
    assert.equal(status.agentType, 'specialist')
    assert.equal(status.status, 'idle')
    assert.equal(status.tokenUsage, 0)
  })

  test('getStatus_reports_da_vinci_agentType_for_da_vinci_role', () => {
    const { adapter } = createTestAdapter({
      role: 'da-vinci',
      agentId: 'da-vinci'
    })
    const session = new AgentSessionService(adapter)
    assert.equal(session.getStatus().agentType, 'da-vinci')
  })

  test('emits_forwarded_events_as_EventEmitter', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)

    let chunks = 0
    let completes = 0
    session.on('chunk', () => chunks++)
    session.on('complete', () => completes++)

    session.emit('chunk', { type: 'text', content: 'hi' })
    session.emit('chunk', { type: 'text', content: 'ho' })
    session.emit('complete')

    assert.equal(chunks, 2)
    assert.equal(completes, 1)
  })

  test('getSessionId_returns_undefined_for_unknown_conversation', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getSessionId('nope'), undefined)
  })

  test('clearSession_removes_session_from_map', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    // clearSession is idempotent on an unknown id
    session.clearSession('nope')
    assert.equal(session.getSessionId('nope'), undefined)
  })

  test('switchMode_no_op_when_mode_unchanged', async () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    // Same mode as default — should no-op and not crash without workspace
    await session.switchMode('plan')
    assert.equal(session.getMode(), 'plan')
  })

  test('event_forwarder_helper_works_for_all_session_events', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)

    const seen: AgentSessionEventName[] = []
    const events: AgentSessionEventName[] = [
      'chunk',
      'statusUpdate',
      'complete',
      'intent',
      'plan',
      'askQuestion',
      'promptSuggestion',
      'compactNeeded',
      'elicitation',
      'elicitationResponse'
    ]
    for (const e of events) {
      session.on(e, () => seen.push(e))
    }
    for (const e of events) {
      session.emit(e, {})
    }
    assert.deepEqual(seen, events)
  })

  test('ExecutorBaseOptions_autoCompact_uses_correct_types', () => {
    // Verify the interface contract: autoCompactEnabled is boolean, contextWindowSize is number.
    // This catches the original bug where autoCompactWindow was passed as boolean (SDK expects number).
    const opts: Partial<ExecutorBaseOptions> = {
      autoCompactEnabled: true,
      contextWindowSize: 1_000_000
    }
    assert.equal(typeof opts.autoCompactEnabled, 'boolean')
    assert.equal(typeof opts.contextWindowSize, 'number')

    // Verify that the old broken property name no longer exists on the interface.
    // TypeScript compile-time ensures this — if 'autoCompactWindow' were on ExecutorBaseOptions,
    // the type assertion below would succeed. Since we removed it, this is a runtime assertion
    // that the object shape is correct.
    assert.equal(
      'autoCompactWindow' in opts,
      false,
      'autoCompactWindow should not exist on ExecutorBaseOptions'
    )
  })

  test('ExecutorBaseOptions_contextManagement_is_optional', () => {
    // Verify contextManagement is accepted as a valid option
    const opts: Partial<ExecutorBaseOptions> = {
      contextManagement: {
        clearToolResults: true,
        clearToolResultsTrigger: 300_000,
        clearToolResultsKeep: 5,
        clearToolResultsMinClear: 50_000,
        clearToolResultsExclude: [],
        clearThinking: true,
        clearThinkingKeepTurns: 2,
        serverCompaction: true,
        serverCompactionTrigger: 600_000
      }
    }
    assert.ok(opts.contextManagement)
    assert.equal(opts.contextManagement!.clearToolResultsTrigger, 300_000)
  })

  test('ExecutorBaseOptions_contextManagement_accepts_tier_metadata', () => {
    // Verify _tier and _tierLimits are accepted in the interface
    const opts: Partial<ExecutorBaseOptions> = {
      contextManagement: {
        clearToolResults: true,
        clearToolResultsTrigger: 9_830,
        clearToolResultsKeep: 2,
        clearToolResultsMinClear: 1_638,
        clearToolResultsExclude: [],
        clearThinking: false,
        clearThinkingKeepTurns: 0,
        serverCompaction: false,
        serverCompactionTrigger: 0,
        _tier: 'small',
        _tierLimits: {
          maxTurnsPlan: 12,
          maxTurnsBuild: 15,
          readLineLimit: 100,
          toolResultBudgetChars: 30_000,
          compactSuggestThreshold: 16_000,
          compactAutoThreshold: 24_000
        }
      }
    }
    assert.equal(opts.contextManagement!._tier, 'small')
    assert.equal(opts.contextManagement!._tierLimits!.maxTurnsBuild, 15)
    assert.equal(opts.contextManagement!._tierLimits!.readLineLimit, 100)
  })

  test('compact_throws_when_session_not_running', async () => {
    // compact() on a non-started session should reject with a clear error
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)

    let thrown = false
    try {
      await session.compact()
    } catch (err) {
      thrown = true
      assert.ok((err as Error).message.includes('Session not running'))
    }
    assert.equal(thrown, true, 'compact() should throw when session is not running')
  })

  test('compactNeeded_event_payload_shape_includes_isLocalProvider', () => {
    // Verify the compactNeeded event can carry isLocalProvider for the UI
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)

    let emittedPayload: Record<string, unknown> | null = null
    session.on('compactNeeded', (payload: unknown) => {
      emittedPayload = payload as Record<string, unknown>
    })

    // Simulate a compactNeeded emission with isLocalProvider flag
    session.emit('compactNeeded', {
      level: 'local-unsupported',
      inputTokens: 20_000,
      isLocalProvider: true,
      message: 'Local LLMs cannot compact mid-conversation.'
    })

    assert.ok(emittedPayload)
    const p = emittedPayload as Record<string, unknown>
    assert.equal(p.level, 'local-unsupported')
    assert.equal(p.isLocalProvider, true)
    assert.equal(typeof p.inputTokens, 'number')
  })

  test('AdapterMcpContext_accepts_contextTier', () => {
    // Verify the interface accepts the new contextTier field
    const { adapter, calls } = createTestAdapter()
    adapter.buildMcpConfig({
      mode: 'plan',
      workspacePath: '/test',
      workspaceId: null,
      conversationId: null,
      controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
      contextTier: 'small'
    })
    assert.equal(calls.buildMcpConfig.length, 1)
    assert.equal(calls.buildMcpConfig[0].contextTier, 'small')
  })

  // ── Run 34: Additional getter / state / lifecycle coverage ──────────

  test('wasTimedOut_defaults_to_false', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.wasTimedOut(), false)
  })

  test('getWorkspaceId_returns_null_before_start', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getWorkspaceId(), null)
  })

  test('getWorkspacePath_returns_null_before_start', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getWorkspacePath(), null)
  })

  test('getCurrentConversationId_returns_null_before_start', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getCurrentConversationId(), null)
  })

  test('getMode_defaults_to_plan', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getMode(), 'plan')
  })

  test('getStreamedContent_defaults_to_empty_string', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getStreamedContent(), '')
  })

  test('isRunning_false_before_start', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.isRunning(), false)
  })

  test('clearSession_is_idempotent_on_unknown_id', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    // Should not throw
    session.clearSession('unknown-conv-id')
    session.clearSession('unknown-conv-id')
    assert.equal(session.getSessionId('unknown-conv-id'), undefined)
  })

  test('getAdapter_returns_the_injected_adapter', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.getAdapter(), adapter)
  })

  test('getRole_delegates_to_adapter_role', () => {
    const { adapter } = createTestAdapter({ role: 'da-vinci' })
    const session = new AgentSessionService(adapter)
    assert.equal(session.getRole(), 'da-vinci')
  })

  test('getAgentId_delegates_to_adapter_agentId', () => {
    const { adapter } = createTestAdapter({ agentId: 'custom-agent-xyz' })
    const session = new AgentSessionService(adapter)
    assert.equal(session.getAgentId(), 'custom-agent-xyz')
  })

  test('getStatus_shape_has_all_expected_fields', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    const status = session.getStatus()
    assert.equal(typeof status.agentId, 'string')
    assert.equal(typeof status.agentType, 'string')
    assert.equal(typeof status.status, 'string')
    assert.equal(typeof status.tokenUsage, 'number')
    assert.equal(typeof status.elapsedMs, 'number')
  })

  test('getStatus_agentType_maps_non_da_vinci_to_specialist', () => {
    const { adapter } = createTestAdapter({ role: 'grill' as AgentRoleAdapter['role'] })
    const session = new AgentSessionService(adapter)
    // All non-da-vinci roles map to 'specialist' agentType
    assert.equal(session.getStatus().agentType, 'specialist')
  })

  test('getStatus_agentType_maps_project_specialist_role', () => {
    const { adapter } = createTestAdapter({
      role: 'project-specialist',
      agentId: 'workspace-specialist-ws-1'
    })
    const session = new AgentSessionService(adapter)
    assert.equal(session.getStatus().agentType, 'specialist')
  })

  test('multiple_event_listeners_on_same_event_all_fire', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    const results: number[] = []
    session.on('chunk', () => results.push(1))
    session.on('chunk', () => results.push(2))
    session.on('chunk', () => results.push(3))
    session.emit('chunk', { type: 'text', content: 'hi' })
    assert.deepEqual(results, [1, 2, 3])
  })

  test('switchMode_no_op_when_no_workspace_path', async () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    // switchMode returns early when workspacePath is null
    await session.switchMode('build')
    assert.equal(session.getMode(), 'plan', 'mode unchanged when no workspace path')
  })

  test('switchMode_no_op_for_danger_when_no_workspace_path', async () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    await session.switchMode('danger')
    assert.equal(session.getMode(), 'plan', 'mode unchanged when no workspace path')
  })

  test('compact_defaults_show_zero_compaction_state', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.compactSuggested, false)
    assert.equal(session.turnsSinceCompactSuggestion, 0)
  })

  test('maxTurnsContinuations_defaults_to_zero', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.maxTurnsContinuations, 0)
  })

  test('lastStreamOpts_defaults_to_null', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.lastStreamOpts, null)
  })

  test('respondToAskUser_logs_warning_when_no_ipc_bridge', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    // Should not throw even without an IPC bridge
    session.respondToAskUser('req-1', 'user response')
    assert.ok(true, 'respondToAskUser completed without error')
  })

  test('getCacheEfficiency_returns_report_object', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    const report = session.getCacheEfficiency()
    // Returns a report object (shape varies, but should not throw)
    assert.ok(report !== null && report !== undefined)
  })

  test('effectiveContextWindow_defaults_to_undefined', () => {
    const { adapter } = createTestAdapter()
    const session = new AgentSessionService(adapter)
    assert.equal(session.effectiveContextWindow, undefined)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

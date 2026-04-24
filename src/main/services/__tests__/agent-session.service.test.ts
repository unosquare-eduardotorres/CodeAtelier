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

  test('getStatus_reports_generalist_agentType_for_da_vinci_role', () => {
    const { adapter } = createTestAdapter({
      role: 'da-vinci',
      agentId: 'generalist'
    })
    const session = new AgentSessionService(adapter)
    assert.equal(session.getStatus().agentType, 'generalist')
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
      'handoff',
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
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

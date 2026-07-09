/**
 * Unit tests for CouncilChairmanRoleAdapter — pure synthesis, no tools.
 *
 * Tests: role, agentId, timeout, MCP strategy (none), buildPrompts guard,
 * onSessionStop cleanup, persistMemory no-op.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { CouncilChairmanRoleAdapter } from '../role-adapters/council-chairman.adapter'
import type { AdapterPromptContext } from '../agent-session.types'
import type { CouncilReview, CouncilPeerReview } from '../../../shared/types'

// ── Helpers ──

const dummyReview: CouncilReview = {
  advisorRole: 'contrarian',
  score: 75,
  verdict: 'needs-revision',
  keyFindings: ['Missing error handling'],
  blindSpots: ['No caching strategy'],
  evidence: [{ file: 'src/app.ts', finding: 'Uncaught promise rejection' }],
  summary: 'The plan has gaps in error handling.'
}

const dummyPeerReview: CouncilPeerReview = {
  reviewerRole: 'executor',
  strongestResponse: 'contrarian',
  strongestReason: 'Most thorough code analysis',
  biggestBlindSpot: 'outsider',
  blindSpotDescription: 'Missed implementation feasibility',
  missedByAll: 'No performance benchmarks proposed'
}

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof CouncilChairmanRoleAdapter>[0]> = {}
) {
  return new CouncilChairmanRoleAdapter({
    workspaceId: 'ws-1',
    framedInput: {
      inputType: 'plan',
      originalUserRequest: 'Add a caching layer',
      planContent: '# Plan\nAdd Redis.',
      filesInScope: [],
      structuredPlan: null,
      workspaceContext: ''
    },
    reviews: [dummyReview],
    peerReviews: [dummyPeerReview],
    ...overrides
  })
}

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'hello',
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

describe('CouncilChairmanRoleAdapter', () => {
  // ── Identity ──

  test('role_is_council-chairman', () => {
    const a = createAdapter()
    assert.equal(a.role, 'council-chairman')
  })

  test('agentId_is_council-chairman-{workspaceId}', () => {
    const a = createAdapter({ workspaceId: 'ws-99' })
    assert.equal(a.agentId, 'council-chairman-ws-99')
  })

  // ── Timeout ──

  test('interactionTimeoutMs_is_3_minutes', () => {
    const a = createAdapter()
    assert.equal(a.interactionTimeoutMs, 3 * 60_000)
  })

  // ── MCP Strategy ──

  test('getMcpStrategy_returns_none', () => {
    const a = createAdapter()
    assert.equal((a as any).getMcpStrategy(), 'none')
  })

  test('buildMcpConfig_returns_no_tools', () => {
    const a = createAdapter()
    const result = a.buildMcpConfig({
      mode: 'plan',
      workspacePath: '/tmp',
      workspaceId: 'ws-1',
      conversationId: null,
      controlCallbacks: { onPlan: () => {}, onAskUser: () => {} }
    })
    assert.deepEqual(result.allowedTools, [])
    assert.ok(result.disallowedTools!.length > 0)
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = createAdapter()
    assert.throws(
      () => a.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  test('buildPrompts_returns_effectiveMessage_after_setup', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'Chairman prompt'
    const result = a.buildPrompts(makePromptCtx())
    assert.equal(result.systemPrompt, 'Chairman prompt')
    assert.equal(result.effectiveMessage, 'Synthesize the council verdict.')
  })

  // persistMemory removed — memory tools now on dedicated memory MCP server

  // ── onSessionStop ──

  test('onSessionStop_clears_state', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'something'
    ;(a as any).resolvedModel = 'claude-opus-4-7'
    a.onSessionStop()
    assert.equal((a as any).systemPrompt, null)
    assert.equal((a as any).resolvedModel, undefined)
  })

  test('onSessionStop_is_safe_to_call_twice', () => {
    const a = createAdapter()
    a.onSessionStop()
    a.onSessionStop()
    assert.equal((a as any).systemPrompt, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

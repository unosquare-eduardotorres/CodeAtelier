/**
 * Run 17: Local-LLM context reconstruction + compaction unavailability.
 *
 * Covers the Path A (local LLM, no SDK resume) behaviours that can't be reached
 * through a live stream:
 *   - LocalContextReconstructor.buildContextFromHistory budget + priority + null
 *   - AgentSessionService.enrichLocalLLMContext selection order (S12 → S6 → raw)
 *     including the 25%-of-window token budget
 *   - AgentSessionService.compact() emitting `local-unsupported` for local LLMs
 *
 * Singletons are monkey-patched and restored synchronously WITHIN each test body
 * (via withPatched). The custom harness runs hook-bearing tests concurrently, so
 * beforeEach/afterEach mutations to shared module singletons would race — keeping
 * patch+restore inside a single synchronous test body avoids interleaving.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AgentSessionService } from '../agent-session.service'
import { localContextReconstructor } from '../local-context-reconstructor'
import { localPlanStateService } from '../local-plan-state.service'
import { conversationRepository, messageRepository } from '../../db/repositories'
import type {
  AgentRoleAdapter,
  AdapterMcpResult,
  AdapterPromptResult
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'

// ── Minimal adapter ─────────────────────────────────────────────────────
function makeAdapter(): AgentRoleAdapter {
  return {
    role: 'da-vinci',
    agentId: 'da-vinci-test',
    supportsEmitPlanRecovery: false,
    onSessionStart: async () => {},
    refreshFeatureFlags: () => {},
    onConversationSwitch: () => {},
    buildPrompts: (): AdapterPromptResult => ({ systemPrompt: 'SYS', effectiveMessage: 'MSG' }),
    buildMcpConfig: (): AdapterMcpResult => ({
      mcpServers: {},
      allowedTools: [],
      disallowedTools: []
    }),
    buildControlCallbacks: (): ControlActionCallbacks => ({
      onPlan: () => {},
      onAskUser: () => {}
    }),
    emitDetectedIntents: () => {},
    onSessionStop: () => {}
  }
}

// ── Synchronous patch/restore helper (no shared-state races) ──────────────
type Patch = { obj: Record<string, unknown>; key: string; value: unknown }

function withPatched<T>(patches: Patch[], fn: () => T): T {
  const saved = patches.map((p) => ({ ...p, orig: p.obj[p.key] }))
  for (const p of patches) p.obj[p.key] = p.value
  try {
    return fn()
  } finally {
    for (const s of saved) s.obj[s.key] = s.orig
  }
}

const planSvcM = localPlanStateService as unknown as Record<string, unknown>
const convRepoM = conversationRepository as unknown as Record<string, unknown>
const msgRepoM = messageRepository as unknown as Record<string, unknown>
const reconM = localContextReconstructor as unknown as Record<string, unknown>

interface PlanStateLike {
  originalRequest: string
  discoveredContext: {
    filesExplored: string[]
    keyFindings: string[]
    planItems: string[]
    nextSteps: string[]
  }
  planText: string
  continuationCount: number
}

const SAMPLE_PLAN: PlanStateLike = {
  originalRequest: 'Build the thing',
  discoveredContext: {
    filesExplored: ['src/a.ts', 'src/b.ts'],
    keyFindings: ['uses repo pattern'],
    planItems: ['1. edit a'],
    nextSteps: []
  },
  planText: '',
  continuationCount: 1
}

describe('LocalContextReconstructor.buildContextFromHistory', () => {
  test('returns null when there is no plan state, summary, or messages', () => {
    withPatched(
      [
        { obj: planSvcM, key: 'getForConversation', value: () => null },
        { obj: convRepoM, key: 'getSummary', value: () => null },
        { obj: msgRepoM, key: 'findRecentByConversation', value: () => [] }
      ],
      () => {
        const out = localContextReconstructor.buildContextFromHistory({
          conversationId: 'c1',
          maxTokenBudget: 4000,
          tier: 'small'
        })
        assert.equal(out, null)
      }
    )
  })

  test('prioritizes plan state (S3) over summary (S6)', () => {
    withPatched(
      [
        { obj: planSvcM, key: 'getForConversation', value: () => SAMPLE_PLAN },
        { obj: convRepoM, key: 'getSummary', value: () => 'THIS SUMMARY SHOULD BE SKIPPED' },
        { obj: msgRepoM, key: 'findRecentByConversation', value: () => [] }
      ],
      () => {
        const out = localContextReconstructor.buildContextFromHistory({
          conversationId: 'c1',
          maxTokenBudget: 8000,
          tier: 'small'
        })
        assert.ok(out, 'expected reconstruction')
        assert.match(out!, /Saved Plan State/)
        assert.match(out!, /src\/a\.ts/)
        assert.doesNotMatch(out!, /THIS SUMMARY SHOULD BE SKIPPED/)
      }
    )
  })

  test('respects maxChars = budget × 3.5 — a summary larger than the budget is omitted', () => {
    const bigSummary = 'x'.repeat(10_000)
    // budget=100 → maxChars=350; summary (10K) does not fit → omitted → null
    withPatched(
      [
        { obj: planSvcM, key: 'getForConversation', value: () => null },
        { obj: convRepoM, key: 'getSummary', value: () => bigSummary },
        { obj: msgRepoM, key: 'findRecentByConversation', value: () => [] }
      ],
      () => {
        const tooSmall = localContextReconstructor.buildContextFromHistory({
          conversationId: 'c1',
          maxTokenBudget: 100,
          tier: 'small'
        })
        assert.equal(tooSmall, null)

        // budget=5000 → maxChars=17500; summary (10K) fits → included
        const fits = localContextReconstructor.buildContextFromHistory({
          conversationId: 'c1',
          maxTokenBudget: 5000,
          tier: 'small'
        })
        assert.ok(fits)
        assert.match(fits!, /Previous Summary/)
      }
    )
  })
})

describe('AgentSessionService.enrichLocalLLMContext', () => {
  type EnrichFn = (p: {
    message: string
    conversationId: string
    localContextWindow: number
    contextTier: string
  }) => string

  function enrich(session: AgentSessionService, window: number): string {
    return (session as unknown as { enrichLocalLLMContext: EnrichFn }).enrichLocalLLMContext({
      message: 'CURRENT',
      conversationId: 'c1',
      localContextWindow: window,
      contextTier: 'small'
    })
  }

  test('budget passed to reconstruction is floor(window × 0.25)', () => {
    let capturedBudget = -1
    withPatched(
      [
        {
          obj: reconM,
          key: 'buildContextFromHistory',
          value: (p: { maxTokenBudget: number }) => {
            capturedBudget = p.maxTokenBudget
            return null
          }
        },
        { obj: convRepoM, key: 'getSummary', value: () => null }
      ],
      () => {
        enrich(new AgentSessionService(makeAdapter()), 64_000)
        assert.equal(capturedBudget, 16_000)
      }
    )
  })

  test('reconstruction present → wraps in ## Previous Context (summary ignored)', () => {
    withPatched(
      [
        { obj: reconM, key: 'buildContextFromHistory', value: () => 'RECONSTRUCTED' },
        { obj: convRepoM, key: 'getSummary', value: () => 'SHOULD NOT BE USED' }
      ],
      () => {
        const out = enrich(new AgentSessionService(makeAdapter()), 32_000)
        assert.match(out, /## Previous Context\nRECONSTRUCTED/)
        assert.match(out, /## Current Request\nCURRENT/)
        assert.doesNotMatch(out, /SHOULD NOT BE USED/)
      }
    )
  })

  test('no reconstruction but summary present → uses S6 summary', () => {
    withPatched(
      [
        { obj: reconM, key: 'buildContextFromHistory', value: () => null },
        { obj: convRepoM, key: 'getSummary', value: () => 'THE SUMMARY' }
      ],
      () => {
        const out = enrich(new AgentSessionService(makeAdapter()), 32_000)
        assert.match(out, /## Previous Context\nTHE SUMMARY/)
        assert.match(out, /## Current Request\nCURRENT/)
      }
    )
  })

  test('no reconstruction and no summary → raw message unchanged', () => {
    withPatched(
      [
        { obj: reconM, key: 'buildContextFromHistory', value: () => null },
        { obj: convRepoM, key: 'getSummary', value: () => null }
      ],
      () => {
        const out = enrich(new AgentSessionService(makeAdapter()), 32_000)
        assert.equal(out, 'CURRENT')
      }
    )
  })
})

describe('AgentSessionService.compact — local LLM is unsupported', () => {
  test('emits exactly one compactNeeded with level=local-unsupported, isLocalProvider=true', async () => {
    const session = new AgentSessionService(makeAdapter())
    const s = session as unknown as Record<string, unknown>
    s.workspacePath = '/test/ws'
    s.currentConversationId = 'conv-1'
    s.llmProvider = 'local-llm'
    s.executorBackend = 'cli' // non-opencode
    s.lastContextTokens = 12_345

    const payloads: Array<Record<string, unknown>> = []
    session.on('compactNeeded', (p: unknown) => payloads.push(p as Record<string, unknown>))

    await session.compact()

    assert.equal(payloads.length, 1, 'exactly one compactNeeded emission')
    assert.equal(payloads[0].level, 'local-unsupported')
    assert.equal(payloads[0].isLocalProvider, true)
    assert.equal(payloads[0].inputTokens, 12_345)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

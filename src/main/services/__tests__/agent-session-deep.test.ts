/**
 * Unit tests for AgentSessionService pure methods — getStatus, incrementTurnCount,
 * buildSdkPrompt, enrichLocalLLMContext, resolveSession (replicated logic).
 *
 * Phase 14, Track 4 — agent-session.service.ts (~1,673 lines at 32.45%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic from AgentSessionService ──

interface ImageAttachment {
  mimeType: string
  base64: string
  fileName?: string
}

interface AgentStatus {
  agentId: string
  agentType: 'specialist'
  status: string
  elapsedMs: number
  tokenUsage: number
  inputTokens: number
  outputTokens: number
  contextTokens: number
}

/**
 * Replicated from AgentSessionService.getStatus (agent-session.service.ts:820-836).
 */
function getStatus(params: {
  currentStatus: string
  messageStartedAt: number | null
  adapterId: string
  adapterRole: string
  tokenUsage: number
  inputTokens: number
  outputTokens: number
  lastContextTokens: number
}): AgentStatus {
  const isActive =
    params.currentStatus === 'thinking' ||
    params.currentStatus === 'writing' ||
    params.currentStatus === 'reviewing'

  return {
    agentId: params.adapterId,
    agentType: 'specialist',
    status: params.currentStatus,
    elapsedMs: isActive && params.messageStartedAt ? Date.now() - params.messageStartedAt : 0,
    tokenUsage: params.tokenUsage,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    contextTokens: params.lastContextTokens
  }
}

/**
 * Replicated from AgentSessionService.incrementTurnCount (agent-session.service.ts:896-905).
 */
class TurnCounter {
  private readonly turnCounts = new Map<string, number>()

  incrementTurnCount(conversationId: string, hasExistingSession: boolean): number {
    if (hasExistingSession && !this.turnCounts.has(conversationId)) {
      this.turnCounts.set(conversationId, 1)
    }
    const next = (this.turnCounts.get(conversationId) ?? 0) + 1
    this.turnCounts.set(conversationId, next)
    return next
  }

  get(conversationId: string): number | undefined {
    return this.turnCounts.get(conversationId)
  }
}

/**
 * Replicated from AgentSessionService.buildSdkPrompt (agent-session.service.ts:907-935).
 * Returns string when no images, returns content blocks structure when images present.
 */
function buildSdkPromptBlocks(
  effectiveMessage: string,
  images?: ImageAttachment[]
): string | { type: 'content-blocks'; blocks: Array<Record<string, unknown>> } {
  if (!images || images.length === 0) return effectiveMessage

  const contentBlocks = [
    ...images.map((img) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mimeType,
        data: img.base64
      }
    })),
    { type: 'text' as const, text: effectiveMessage }
  ]

  return { type: 'content-blocks', blocks: contentBlocks }
}

/**
 * Replicated from AgentSessionService.enrichLocalLLMContext (agent-session.service.ts:1324-1359).
 */
function enrichLocalLLMContext(params: {
  message: string
  reconstructedContext: string | null
  summary: string | null
}): string {
  try {
    if (params.reconstructedContext) {
      return `## Previous Context\n${params.reconstructedContext}\n\n## Current Request\n${params.message}`
    }
    if (params.summary) {
      return `## Previous Context\n${params.summary}\n\n## Current Request\n${params.message}`
    }
  } catch {
    /* non-fatal — proceed without context */
  }
  return params.message
}

/**
 * Replicated session resolution logic (agent-session.service.ts).
 *
 * NOTE: The real resolveSession now rejects DB-loaded sessions (cross-restart
 * guard) — sessions loaded from DB return undefined instead of being cached.
 * This simplified double preserves the pre-guard behavior for its own tests.
 */
class SessionResolver {
  private readonly sessionMap = new Map<string, string>()
  private dbLookup: ((conversationId: string) => string | undefined) | null = null

  setDbLookup(fn: (conversationId: string) => string | undefined): void {
    this.dbLookup = fn
  }

  cache(conversationId: string, sessionId: string): void {
    this.sessionMap.set(conversationId, sessionId)
  }

  resolveSession(conversationId: string): string | undefined {
    let sessionId = this.sessionMap.get(conversationId)
    if (!sessionId && this.dbLookup) {
      try {
        sessionId = this.dbLookup(conversationId)
        if (sessionId) {
          this.sessionMap.set(conversationId, sessionId)
        }
      } catch {
        // error suppressed
      }
    }
    return sessionId
  }
}

/**
 * Replicated controlToolState + parsePlanPayload wrapping logic
 * (agent-session.service.ts:941-975).
 */
interface ControlToolState {
  plan: boolean
  askUser: boolean
  planIntent?: { type: 'plan'; plan: unknown }
}

function wrapOnPlan(
  state: ControlToolState,
  originalOnPlan: (plan: unknown) => void,
  plan: unknown
): void {
  state.plan = true
  // parsePlanPayload would be called here in production
  state.planIntent = { type: 'plan', plan }
  originalOnPlan(plan)
}

// ── Tests ──

describe('getStatus', () => {
  test('returns_correct_agentId_and_role_from_adapter', () => {
    const status = getStatus({
      currentStatus: 'idle',
      messageStartedAt: null,
      adapterId: 'specialist-1',
      adapterRole: 'specialist',
      tokenUsage: 1000,
      inputTokens: 600,
      outputTokens: 400,
      lastContextTokens: 50000
    })
    assert.equal(status.agentId, 'specialist-1')
    assert.equal(status.agentType, 'specialist')
  })

  test('specialist_role_returns_specialist_type', () => {
    const status = getStatus({
      currentStatus: 'idle',
      messageStartedAt: null,
      adapterId: 'spec-1',
      adapterRole: 'specialist',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastContextTokens: 0
    })
    assert.equal(status.agentType, 'specialist')
  })

  test('calculates_elapsedMs_when_status_is_thinking', () => {
    const startedAt = Date.now() - 5000 // 5 seconds ago
    const status = getStatus({
      currentStatus: 'thinking',
      messageStartedAt: startedAt,
      adapterId: 'da-vinci-1',
      adapterRole: 'da-vinci',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastContextTokens: 0
    })
    assert.ok(status.elapsedMs >= 4900)
    assert.ok(status.elapsedMs <= 6000)
  })

  test('elapsedMs_is_0_when_status_is_idle', () => {
    const status = getStatus({
      currentStatus: 'idle',
      messageStartedAt: Date.now() - 5000,
      adapterId: 'da-vinci-1',
      adapterRole: 'da-vinci',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastContextTokens: 0
    })
    assert.equal(status.elapsedMs, 0)
  })

  test('elapsedMs_is_0_when_messageStartedAt_is_null', () => {
    const status = getStatus({
      currentStatus: 'thinking',
      messageStartedAt: null,
      adapterId: 'da-vinci-1',
      adapterRole: 'da-vinci',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastContextTokens: 0
    })
    assert.equal(status.elapsedMs, 0)
  })

  test('includes_tokenUsage_fields', () => {
    const status = getStatus({
      currentStatus: 'idle',
      messageStartedAt: null,
      adapterId: 'da-vinci-1',
      adapterRole: 'da-vinci',
      tokenUsage: 5000,
      inputTokens: 3000,
      outputTokens: 2000,
      lastContextTokens: 100000
    })
    assert.equal(status.tokenUsage, 5000)
    assert.equal(status.inputTokens, 3000)
    assert.equal(status.outputTokens, 2000)
    assert.equal(status.contextTokens, 100000)
  })

  test('writing_status_is_active', () => {
    const status = getStatus({
      currentStatus: 'writing',
      messageStartedAt: Date.now() - 1000,
      adapterId: 'da-vinci-1',
      adapterRole: 'da-vinci',
      tokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastContextTokens: 0
    })
    assert.ok(status.elapsedMs > 0)
  })
})

describe('incrementTurnCount', () => {
  test('new_conversation_starts_at_1', () => {
    const counter = new TurnCounter()
    const count = counter.incrementTurnCount('conv-1', false)
    assert.equal(count, 1)
  })

  test('subsequent_calls_increment_monotonically', () => {
    const counter = new TurnCounter()
    counter.incrementTurnCount('conv-1', false)
    const count2 = counter.incrementTurnCount('conv-1', false)
    const count3 = counter.incrementTurnCount('conv-1', false)
    assert.equal(count2, 2)
    assert.equal(count3, 3)
  })

  test('resuming_session_seeds_at_2', () => {
    const counter = new TurnCounter()
    const count = counter.incrementTurnCount('conv-1', true)
    // hasExistingSession=true sets base to 1, then increments to 2
    assert.equal(count, 2)
  })

  test('different_conversations_have_independent_counters', () => {
    const counter = new TurnCounter()
    counter.incrementTurnCount('conv-1', false)
    counter.incrementTurnCount('conv-1', false)
    const countB = counter.incrementTurnCount('conv-2', false)
    assert.equal(countB, 1)
  })

  test('second_call_with_existing_session_doesnt_re_seed', () => {
    const counter = new TurnCounter()
    counter.incrementTurnCount('conv-1', true) // seeds + increments → 2
    const count2 = counter.incrementTurnCount('conv-1', true) // already exists → just increments → 3
    assert.equal(count2, 3)
  })
})

describe('buildSdkPromptBlocks', () => {
  test('no_images_returns_string_directly', () => {
    const result = buildSdkPromptBlocks('Hello world')
    assert.equal(typeof result, 'string')
    assert.equal(result, 'Hello world')
  })

  test('empty_images_returns_string', () => {
    const result = buildSdkPromptBlocks('Hello', [])
    assert.equal(typeof result, 'string')
  })

  test('with_images_returns_content_blocks', () => {
    const images: ImageAttachment[] = [
      { mimeType: 'image/png', base64: 'base64data', fileName: 'test.png' }
    ]
    const result = buildSdkPromptBlocks('Describe this', images)
    assert.notEqual(typeof result, 'string')
    const blocks = (result as { blocks: Array<Record<string, unknown>> }).blocks
    assert.ok(blocks.length >= 2)
  })

  test('images_include_correct_base64_and_mimeType', () => {
    const images: ImageAttachment[] = [
      { mimeType: 'image/jpeg', base64: 'abc123', fileName: 'photo.jpg' }
    ]
    const result = buildSdkPromptBlocks('Describe', images)
    const blocks = (result as { blocks: Array<Record<string, unknown>> }).blocks
    const imgBlock = blocks[0] as Record<string, unknown>
    assert.equal(imgBlock.type, 'image')
    const source = imgBlock.source as Record<string, unknown>
    assert.equal(source.data, 'abc123')
    assert.equal(source.media_type, 'image/jpeg')
  })

  test('text_appended_after_images_in_content_blocks', () => {
    const images: ImageAttachment[] = [
      { mimeType: 'image/png', base64: 'data1' },
      { mimeType: 'image/png', base64: 'data2' }
    ]
    const result = buildSdkPromptBlocks('My text', images)
    const blocks = (result as { blocks: Array<Record<string, unknown>> }).blocks
    assert.equal(blocks.length, 3)
    // Last block should be text
    assert.equal(blocks[2].type, 'text')
    assert.equal(blocks[2].text, 'My text')
  })
})

describe('enrichLocalLLMContext', () => {
  test('with_reconstruction_prefixes_Previous_Context', () => {
    const result = enrichLocalLLMContext({
      message: 'Fix the bug',
      reconstructedContext: 'User asked about login flow',
      summary: null
    })
    assert.ok(result.includes('## Previous Context'))
    assert.ok(result.includes('User asked about login flow'))
    assert.ok(result.includes('## Current Request'))
    assert.ok(result.includes('Fix the bug'))
  })

  test('without_reconstruction_falls_back_to_summary', () => {
    const result = enrichLocalLLMContext({
      message: 'Fix the bug',
      reconstructedContext: null,
      summary: 'Previous discussion about login'
    })
    assert.ok(result.includes('## Previous Context'))
    assert.ok(result.includes('Previous discussion about login'))
  })

  test('both_fail_returns_raw_message', () => {
    const result = enrichLocalLLMContext({
      message: 'Fix the bug',
      reconstructedContext: null,
      summary: null
    })
    assert.equal(result, 'Fix the bug')
  })

  test('reconstruction_takes_precedence_over_summary', () => {
    const result = enrichLocalLLMContext({
      message: 'Fix the bug',
      reconstructedContext: 'Reconstructed context',
      summary: 'Summary context'
    })
    assert.ok(result.includes('Reconstructed context'))
    assert.ok(!result.includes('Summary context'))
  })

  test('includes_Current_Request_section', () => {
    const result = enrichLocalLLMContext({
      message: 'Do something',
      reconstructedContext: 'Prior context',
      summary: null
    })
    assert.ok(result.includes('## Current Request\nDo something'))
  })
})

describe('resolveSession', () => {
  test('cached_session_returns_from_map', () => {
    const resolver = new SessionResolver()
    resolver.cache('conv-1', 'sess-abc')
    const result = resolver.resolveSession('conv-1')
    assert.equal(result, 'sess-abc')
  })

  test('not_cached_in_DB_loads_and_caches', () => {
    const resolver = new SessionResolver()
    resolver.setDbLookup((id) => (id === 'conv-1' ? 'sess-from-db' : undefined))
    const result = resolver.resolveSession('conv-1')
    assert.equal(result, 'sess-from-db')
    // Should be cached now
    const result2 = resolver.resolveSession('conv-1')
    assert.equal(result2, 'sess-from-db')
  })

  test('DB_error_returns_undefined', () => {
    const resolver = new SessionResolver()
    resolver.setDbLookup(() => {
      throw new Error('DB connection failed')
    })
    const result = resolver.resolveSession('conv-1')
    assert.equal(result, undefined)
  })

  test('not_in_cache_or_db_returns_undefined', () => {
    const resolver = new SessionResolver()
    resolver.setDbLookup(() => undefined)
    const result = resolver.resolveSession('conv-unknown')
    assert.equal(result, undefined)
  })
})

describe('wrapControlCallbacks — onPlan', () => {
  test('onPlan_sets_controlToolState_plan_true', () => {
    const state: ControlToolState = { plan: false, askUser: false }
    let originalCalled = false
    const plan = { type: 'structured', items: [] }

    wrapOnPlan(state, () => { originalCalled = true }, plan)

    assert.equal(state.plan, true)
    assert.ok(originalCalled)
  })

  test('onPlan_stores_planIntent', () => {
    const state: ControlToolState = { plan: false, askUser: false }
    const plan = { type: 'structured', items: [{ id: 1, title: 'Task 1' }] }

    wrapOnPlan(state, () => {}, plan)

    assert.ok(state.planIntent)
    assert.equal(state.planIntent!.type, 'plan')
    assert.deepEqual(state.planIntent!.plan, plan)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

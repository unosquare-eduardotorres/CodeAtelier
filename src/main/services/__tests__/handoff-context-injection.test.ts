/**
 * Handoff context injection — the blueprint→chat context that survives a deleted
 * composer draft.
 *
 * `conversations.handoff_context` was written by the handoff IPC and read by
 * nobody, so the context reached the agent only as the staged first message.
 * These tests pin the reader: cold start only, no double-injection, and never
 * fatal.
 *
 * Singletons are monkey-patched and restored synchronously WITHIN each test body
 * (via withPatched), matching local-compaction.test.ts — the harness runs
 * hook-bearing tests concurrently, so beforeEach mutation of shared module
 * singletons would race.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AgentSessionService } from '../agent-session.service'
import { conversationRepository } from '../../db/repositories'
import type {
  AgentRoleAdapter,
  AdapterMcpResult,
  AdapterPromptResult
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'

function makeAdapter(): AgentRoleAdapter {
  return {
    role: 'specialist',
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

const convRepoM = conversationRepository as unknown as Record<string, unknown>

type InjectFn = (p: { conversationId: string; message: string; sessionId?: string }) => string

function inject(message: string, sessionId?: string): string {
  const session = new AgentSessionService(makeAdapter())
  return (session as unknown as { injectHandoffContext: InjectFn }).injectHandoffContext({
    conversationId: 'conv-1',
    message,
    sessionId
  })
}

describe('AgentSessionService.injectHandoffContext', () => {
  test('cold start with stored context → prepends ## Handoff Context', () => {
    withPatched(
      [{ obj: convRepoM, key: 'getHandoffContext', value: () => 'FROM THE BLUEPRINT' }],
      () => {
        const out = inject('what did you just build?')
        assert.match(out, /## Handoff Context\nFROM THE BLUEPRINT/)
        assert.match(out, /## Current Request\nwhat did you just build\?/)
      }
    )
  })

  test('warm resume (sessionId present) → message unchanged, repository not read', () => {
    let reads = 0
    withPatched(
      [
        {
          obj: convRepoM,
          key: 'getHandoffContext',
          value: () => {
            reads++
            return 'FROM THE BLUEPRINT'
          }
        }
      ],
      () => {
        const out = inject('next step please', 'sess-abc')
        assert.equal(out, 'next step please')
        assert.equal(reads, 0, 'no DB read when a live session is being resumed')
      }
    )
  })

  test('message already carries the staged ## Handoff: render → no second copy', () => {
    withPatched(
      [{ obj: convRepoM, key: 'getHandoffContext', value: () => 'COMPACT ENVELOPE' }],
      () => {
        const staged = '## Handoff: blueprint → chat\n**Intent:** continue\nDo the thing.'
        assert.equal(inject(staged), staged)
      }
    )
  })

  test('no stored context → message unchanged', () => {
    withPatched([{ obj: convRepoM, key: 'getHandoffContext', value: () => null }], () => {
      assert.equal(inject('hello'), 'hello')
    })
  })

  test('repository throws → non-fatal, message unchanged', () => {
    withPatched(
      [
        {
          obj: convRepoM,
          key: 'getHandoffContext',
          value: () => {
            throw new Error('db is gone')
          }
        }
      ],
      () => {
        assert.equal(inject('hello'), 'hello')
      }
    )
  })

  test('injection composes with an already-enriched message rather than replacing it', () => {
    withPatched([{ obj: convRepoM, key: 'getHandoffContext', value: () => 'ORIGIN' }], () => {
      const out = inject('## Session Context\nPRIOR TURNS\n\n## Current Request\nkeep going')
      assert.match(out, /^## Handoff Context\nORIGIN/)
      assert.match(out, /PRIOR TURNS/)
      assert.match(out, /keep going/)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

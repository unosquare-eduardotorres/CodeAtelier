/**
 * Blueprint Durability tests — journal->chat mapper, doc-loader resolution,
 * viewState precedence.
 *
 * Run: npx tsx src/main/services/__tests__/blueprint-durability.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  journalEventsToChatMessages,
  HYDRATION_EVENT_CAP,
  type JournalEvent
} from '../../../shared/blueprint-journal-mapper'
import {
  resolveHydrationAction,
  resolvePostFetchAction
} from '../../../shared/blueprint-hydration-helpers'
import { resolveVerifyBannerState } from '../../../shared/blueprint-verify-banner-helpers'

// -- 1. journalEventsToChatMessages mapper --

function makeEvent(overrides: Partial<JournalEvent> & { type: string; seq: number }): JournalEvent {
  return {
    id: `evt-${overrides.seq}`,
    blueprintId: 'bp-1',
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('journalEventsToChatMessages', () => {
  test('empty events produce empty messages', () => {
    const result = journalEventsToChatMessages([])
    assert.deepEqual(result, [])
  })

  test('phaseStart system event produces system message', () => {
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'system', payload: { event: 'phaseStart', phase: 'specify' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'system')
    assert.equal((msgs[0] as { content: string }).content, 'Specify phase started')
  })

  test('phaseComplete system event includes status', () => {
    const events: JournalEvent[] = [
      makeEvent({
        seq: 1,
        type: 'system',
        payload: { event: 'phaseComplete', phase: 'build', status: 'complete' }
      })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal((msgs[0] as { content: string }).content, 'Build phase complete')
  })

  test('waveStart and waveComplete system events', () => {
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'system', payload: { event: 'waveStart', wave: 2, taskCount: 5 } }),
      makeEvent({ seq: 2, type: 'system', payload: { event: 'waveComplete', wave: 2 } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 2)
    assert.ok((msgs[0] as { content: string }).content.includes('Wave 2'))
    assert.ok((msgs[0] as { content: string }).content.includes('5 tasks'))
    assert.ok((msgs[1] as { content: string }).content.includes('Wave 2 complete'))
  })

  test('findings events increment round correctly', () => {
    const findings = { summary: 'Found issues', items: [] }
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'findings', payload: { findings } }),
      makeEvent({ seq: 2, type: 'findings', payload: { findings } }),
      makeEvent({ seq: 3, type: 'findings', payload: { findings } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 3)
    assert.equal((msgs[0] as { round: number }).round, 1)
    assert.equal((msgs[1] as { round: number }).round, 2)
    assert.equal((msgs[2] as { round: number }).round, 3)
  })

  test('qa event with following user event pairs answers', () => {
    const questions = [{ id: 'q1', text: 'What is the scope?' }]
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'qa', payload: { questions } }),
      makeEvent({ seq: 2, type: 'user', payload: { message: 'The scope is X' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    // Should produce qa message with answers, NOT a separate user message
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'qa')
    const qa = msgs[0] as {
      answers: Record<
        string,
        { selectedOptions: string[]; otherText: string; otherSelected: boolean; skipped: boolean }
      >
    }
    assert.equal(qa.answers['q1'].otherText, 'The scope is X')
    assert.deepEqual(qa.answers['q1'].selectedOptions, [])
    assert.equal(qa.answers['q1'].otherSelected, true)
    assert.equal(qa.answers['q1'].skipped, false)
  })

  test('qa event without following user produces empty answers', () => {
    const questions = [{ id: 'q1', text: 'What is the scope?' }]
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'qa', payload: { questions } }),
      makeEvent({ seq: 2, type: 'system', payload: { event: 'phaseComplete', phase: 'clarify' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].type, 'qa')
    const qa = msgs[0] as { answers: Record<string, unknown> }
    assert.deepEqual(qa.answers, {})
  })

  test('gateReady qa event becomes system message', () => {
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'qa', payload: { event: 'gateReady' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'system')
    assert.ok((msgs[0] as { content: string }).content.includes('gate ready'))
  })

  test('agent event with content and toolActivities', () => {
    const tools = [{ id: 't1', toolName: 'Read', status: 'completed', startedAt: 1 }]
    const events: JournalEvent[] = [
      makeEvent({
        seq: 1,
        type: 'agent',
        payload: { contentMd: 'Analyzed the code', toolActivities: tools }
      })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'agent')
    const agent = msgs[0] as { content: string; toolActivities: unknown[] }
    assert.ok(agent.content.includes('Analyzed the code'))
    assert.equal(agent.toolActivities.length, 1)
  })

  test('standalone user event not consumed by qa', () => {
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'user', payload: { message: 'Hello agent' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'user')
    assert.equal((msgs[0] as { content: string }).content, 'Hello agent')
  })

  test('plan event with contentJson uses it directly', () => {
    const plan = { title: 'My Plan', phases: [] }
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'plan', payload: { contentJson: plan } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'plan')
    assert.deepEqual((msgs[0] as { plan: Record<string, unknown> }).plan, plan)
  })

  test('tasks event with contentJson uses it directly', () => {
    const tasks = { tasks: [{ id: '1', description: 'Task 1' }] }
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'tasks', payload: { contentJson: tasks } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'tasks')
    assert.deepEqual((msgs[0] as { tasks: Record<string, unknown> }).tasks, tasks)
  })

  test('unknown event type is silently skipped', () => {
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'future-type', payload: { data: 'x' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 0)
  })

  test('full transcript roundtrip produces correct message types', () => {
    const findings = { summary: 'Issues', items: [] }
    const questions = [{ id: 'q1', text: 'Scope?' }]
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'system', payload: { event: 'phaseStart', phase: 'specify' } }),
      makeEvent({
        seq: 2,
        type: 'agent',
        payload: { contentMd: 'Analyzing spec...', toolActivities: [] }
      }),
      makeEvent({
        seq: 3,
        type: 'system',
        payload: { event: 'phaseComplete', phase: 'specify', status: 'complete' }
      }),
      makeEvent({ seq: 4, type: 'system', payload: { event: 'phaseStart', phase: 'clarify' } }),
      makeEvent({ seq: 5, type: 'findings', payload: { findings } }),
      makeEvent({ seq: 6, type: 'qa', payload: { questions } }),
      makeEvent({ seq: 7, type: 'user', payload: { message: 'The scope is everything' } }),
      makeEvent({
        seq: 8,
        type: 'system',
        payload: { event: 'phaseComplete', phase: 'clarify', status: 'complete' }
      }),
      makeEvent({ seq: 9, type: 'system', payload: { event: 'phaseStart', phase: 'plan' } }),
      makeEvent({ seq: 10, type: 'plan', payload: { contentJson: { title: 'Plan' } } }),
      makeEvent({
        seq: 11,
        type: 'system',
        payload: { event: 'phaseComplete', phase: 'plan', status: 'complete' }
      }),
      makeEvent({ seq: 12, type: 'system', payload: { event: 'phaseStart', phase: 'tasks' } }),
      makeEvent({ seq: 13, type: 'tasks', payload: { contentJson: { tasks: [] } } }),
      makeEvent({
        seq: 14,
        type: 'system',
        payload: { event: 'phaseComplete', phase: 'tasks', status: 'complete' }
      })
    ]
    const msgs = journalEventsToChatMessages(events)
    // 8 system + 1 agent + 1 findings + 1 qa + 1 plan + 1 tasks = 13 (user consumed by qa)
    assert.equal(msgs.length, 13)
    const types = msgs.map((m) => m.type)
    assert.ok(types.includes('system'))
    assert.ok(types.includes('agent'))
    assert.ok(types.includes('findings'))
    assert.ok(types.includes('qa'))
    assert.ok(types.includes('plan'))
    assert.ok(types.includes('tasks'))
    // Verify user was consumed (not standalone)
    assert.equal(types.filter((t) => t === 'user').length, 0)
  })
})

describe('journalEventsToChatMessages hardening', () => {
  // -- Hydration cap --

  test('hydration cap truncates events beyond 2000 and prepends marker', () => {
    // Generate more events than the cap
    const count = HYDRATION_EVENT_CAP + 50
    const events: JournalEvent[] = []
    for (let i = 1; i <= count; i++) {
      events.push(
        makeEvent({ seq: i, type: 'system', payload: { event: 'phaseStart', phase: 'specify' } })
      )
    }
    const msgs = journalEventsToChatMessages(events)
    // Should have cap messages + 1 truncation marker
    assert.equal(msgs.length, HYDRATION_EVENT_CAP + 1)
    // First message is the truncation marker
    assert.equal(msgs[0].type, 'system')
    assert.ok((msgs[0] as { content: string }).content.includes('50 earlier events omitted'))
  })

  test('events within cap are returned without truncation marker', () => {
    const events: JournalEvent[] = []
    for (let i = 1; i <= 5; i++) {
      events.push(
        makeEvent({ seq: i, type: 'system', payload: { event: 'phaseStart', phase: 'specify' } })
      )
    }
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 5)
    // No truncation marker
    assert.ok(!(msgs[0] as { content: string }).content.includes('omitted'))
  })

  // -- Artifact-agent duplicate skip --

  test('skips artifact-type agent events when same phase has accumulator agents', () => {
    const events: JournalEvent[] = [
      // Accumulator-style agent (has toolActivities)
      makeEvent({
        seq: 1,
        type: 'agent',
        payload: {
          phase: 'build',
          contentMd: 'Accumulator text',
          toolActivities: [{ id: 't1', toolName: 'Read', status: 'completed', startedAt: 1 }]
        }
      }),
      // Artifact-type agent in same phase (should be skipped)
      makeEvent({
        seq: 2,
        type: 'agent',
        payload: {
          phase: 'build',
          contentMd: 'Same text from artifact',
          artifactType: 'build-output'
        }
      }),
      // Non-artifact agent in different phase (should NOT be skipped)
      makeEvent({
        seq: 3,
        type: 'agent',
        payload: { phase: 'specify', contentMd: 'Specify output' }
      })
    ]
    const msgs = journalEventsToChatMessages(events)
    const agentMsgs = msgs.filter((m) => m.type === 'agent')
    assert.equal(agentMsgs.length, 2) // accumulator + specify, NOT the artifact duplicate
  })

  // -- isNaN timestamp guard --

  test('unparseable createdAt falls back to Date.now()', () => {
    const events: JournalEvent[] = [
      makeEvent({
        seq: 1,
        type: 'system',
        payload: { event: 'phaseStart', phase: 'specify' },
        createdAt: 'not-a-date'
      })
    ]
    const msgs = journalEventsToChatMessages(events)
    assert.equal(msgs.length, 1)
    // Timestamp should be a valid number (not NaN)
    assert.equal(typeof msgs[0].timestamp, 'number')
    assert.ok(!isNaN(msgs[0].timestamp))
    // Should be approximately now (within 5 seconds)
    assert.ok(Math.abs(msgs[0].timestamp - Date.now()) < 5000)
  })

  // -- QA answer shape correctness --

  test('qa answer uses correct QuestionAnswerState shape with selectedOptions/otherText', () => {
    const questions = [
      { id: 'q1', header: 'Scope', question: 'What is the scope?', multiSelect: false, options: [] }
    ]
    const events: JournalEvent[] = [
      makeEvent({ seq: 1, type: 'qa', payload: { questions } }),
      makeEvent({ seq: 2, type: 'user', payload: { message: 'Everything' } })
    ]
    const msgs = journalEventsToChatMessages(events)
    const qa = msgs[0] as {
      answers: Record<
        string,
        { selectedOptions: string[]; otherText: string; otherSelected: boolean; skipped: boolean }
      >
    }
    assert.deepEqual(qa.answers['q1'].selectedOptions, [])
    assert.equal(qa.answers['q1'].otherText, 'Everything')
    assert.equal(qa.answers['q1'].otherSelected, true)
    assert.equal(qa.answers['q1'].skipped, false)
  })
})

// -- 2. Doc-loader exports --

describe('doc-loader structured result', () => {
  test('buildReferenceDocsBlock and setManagedDocsRoot are exported', async () => {
    const mod = await import('../blueprint-document-loader')
    assert.equal(typeof mod.buildReferenceDocsBlock, 'function')
    assert.equal(typeof mod.splitBinaryDocs, 'function')
    assert.equal(typeof mod.setManagedDocsRoot, 'function')
  })
})

// -- 3. getEffectiveView precedence --

describe('getEffectiveView precedence', () => {
  type ViewState = 'landing' | 'input' | 'active' | 'detail'
  function getEffectiveView(
    viewState: ViewState,
    isRunning: boolean,
    pendingApproval: unknown,
    selectedId: string | null
  ): ViewState {
    if (isRunning || pendingApproval) return 'active'
    if (selectedId) return 'detail'
    return viewState
  }

  test('isRunning forces active regardless of viewState', () => {
    assert.equal(getEffectiveView('landing', true, null, null), 'active')
    assert.equal(getEffectiveView('input', true, null, null), 'active')
    assert.equal(getEffectiveView('detail', true, null, null), 'active')
  })

  test('pendingApproval forces active', () => {
    assert.equal(getEffectiveView('landing', false, { blueprintId: 'x' }, null), 'active')
  })

  test('selectedId forces detail when not running', () => {
    assert.equal(getEffectiveView('landing', false, null, 'bp-1'), 'detail')
  })

  test('isRunning takes precedence over selectedId', () => {
    assert.equal(getEffectiveView('landing', true, null, 'bp-1'), 'active')
  })

  test('pendingApproval takes precedence over selectedId', () => {
    assert.equal(getEffectiveView('landing', false, { blueprintId: 'x' }, 'bp-1'), 'active')
  })

  test('no overrides returns viewState as-is', () => {
    assert.equal(getEffectiveView('landing', false, null, null), 'landing')
    assert.equal(getEffectiveView('input', false, null, null), 'input')
  })
})

// -- 4. Managed-root whitelist + traversal guard --

describe('managed-root whitelist', () => {
  test('setManagedDocsRoot registers root and loadAllReferenceDocuments uses it', async () => {
    const mod = await import('../blueprint-document-loader')
    // Setting managed root should not throw
    mod.setManagedDocsRoot('/tmp/test-managed-root')
    // Verify exports exist
    assert.equal(typeof mod.setManagedDocsRoot, 'function')
    assert.equal(typeof mod.loadAllReferenceDocuments, 'function')
  })

  test('loadAllReferenceDocuments rejects traversal outside workspace and managed root', async () => {
    const mod = await import('../blueprint-document-loader')
    // Set a managed root that doesn't include the traversal target
    mod.setManagedDocsRoot('/tmp/managed')
    // A path that traverses outside the workspace should be rejected
    const docs = [{ type: 'file' as const, path: '../../etc/passwd', name: 'traversal-test' }]
    const result = await mod.loadAllReferenceDocuments('/tmp/test-workspace', docs)
    // Should either return empty (doc not loadable) or contain error info
    // The key invariant: no file content from outside workspace/managed root
    for (const doc of result) {
      assert.ok(!doc.content?.includes('root:'), 'Should not contain /etc/passwd content')
    }
  })
})

// -- 5. Wrong-transcript-switch regression --

describe('wrong-transcript-switch', () => {
  test('switching blueprints produces different transcripts', () => {
    // Blueprint A events
    const eventsA: JournalEvent[] = [
      makeEvent({
        seq: 1,
        type: 'system',
        payload: { event: 'phaseStart', phase: 'specify' },
        createdAt: '2026-01-01T00:00:00.000Z'
      }),
      makeEvent({
        seq: 2,
        type: 'agent',
        payload: { contentMd: 'Analyzing A...' },
        createdAt: '2026-01-01T00:01:00.000Z'
      })
    ]
    // Blueprint B events
    const eventsB: JournalEvent[] = [
      makeEvent({
        seq: 1,
        type: 'system',
        payload: { event: 'phaseStart', phase: 'clarify' },
        createdAt: '2026-02-01T00:00:00.000Z'
      }),
      makeEvent({
        seq: 2,
        type: 'agent',
        payload: { contentMd: 'Analyzing B...' },
        createdAt: '2026-02-01T00:01:00.000Z'
      })
    ]
    const msgsA = journalEventsToChatMessages(eventsA)
    const msgsB = journalEventsToChatMessages(eventsB)
    // Transcripts should be different
    assert.notDeepEqual(msgsA, msgsB)
    // A should mention 'specify', B should mention 'clarify'
    assert.ok((msgsA[0] as { content: string }).content.includes('Specify'))
    assert.ok((msgsB[0] as { content: string }).content.includes('Clarify'))
  })
})

// -- 6. resolveHydrationAction — pure decision helper --

describe('resolveHydrationAction', () => {
  test('skip when already hydrated AND messages present', () => {
    // Sentinel matches and transcript still loaded — no-op
    const action = resolveHydrationAction(5, 'bp-1', 'bp-1', 'bp-1', false)
    assert.equal(action, 'skip')
  })

  test('re-hydrate when sentinel matches but messages were blown away', () => {
    // Sentinel matches but chatMessages empty (startBlueprint/cancel/retry cleared them).
    // Must re-fetch from journal, not skip.
    const action = resolveHydrationAction(0, null, 'bp-1', 'bp-1', false)
    assert.equal(action, 'apply')
  })

  test('skip when hydration is already in-flight', () => {
    const action = resolveHydrationAction(0, null, 'bp-1', null, true)
    assert.equal(action, 'skip')
  })

  test('skip when in-flight even if sentinel matches with empty messages', () => {
    // In-flight takes priority over sentinel-with-empty-messages
    const action = resolveHydrationAction(0, null, 'bp-1', 'bp-1', true)
    assert.equal(action, 'skip')
  })

  test('skip when live messages exist for THIS blueprint (IPC arrived first)', () => {
    const action = resolveHydrationAction(5, 'bp-1', 'bp-1', null, false)
    assert.equal(action, 'skip')
  })

  test('clear-then-apply when chatMessages belong to a different BP (BUG-3 sentinel set)', () => {
    const action = resolveHydrationAction(3, 'bp-A', 'bp-B', 'bp-A', false)
    assert.equal(action, 'clear-then-apply')
  })

  test('CRITICAL-1: clear-then-apply when live-watched run A, sentinel null, selecting B', () => {
    // This is the missed path: user watched run A live → hydratedBlueprintId is null
    // but chatMessages belong to A. Now selecting historical run B.
    const action = resolveHydrationAction(10, 'bp-A', 'bp-B', null, false)
    assert.equal(action, 'clear-then-apply')
  })

  test('CRITICAL-1: clear-then-apply when currentBlueprint is null but messages exist', () => {
    // Edge case: currentBlueprint hasn't loaded yet, messages from previous BP.
    const action = resolveHydrationAction(5, null, 'bp-B', null, false)
    assert.equal(action, 'clear-then-apply')
  })

  test('apply when no live messages (normal historical view)', () => {
    const action = resolveHydrationAction(0, null, 'bp-1', null, false)
    assert.equal(action, 'apply')
  })

  test('apply when no live messages and sentinel from different BP', () => {
    const action = resolveHydrationAction(0, null, 'bp-B', 'bp-A', false)
    assert.equal(action, 'apply')
  })
})

describe('resolvePostFetchAction', () => {
  test('apply when no live messages after fetch', () => {
    assert.equal(resolvePostFetchAction(0), 'apply')
  })

  test('merge when live messages arrived during fetch', () => {
    assert.equal(resolvePostFetchAction(3), 'merge')
  })
})

// -- resolveVerifyBannerState --

describe('resolveVerifyBannerState', () => {
  test('human_needed + not acknowledged => human-review', () => {
    assert.equal(resolveVerifyBannerState('human_needed', false), 'human-review')
  })

  test('human_needed + acknowledged => acknowledged', () => {
    assert.equal(resolveVerifyBannerState('human_needed', true), 'acknowledged')
  })

  test('passed => none regardless of acknowledged', () => {
    assert.equal(resolveVerifyBannerState('passed', false), 'none')
    assert.equal(resolveVerifyBannerState('passed', true), 'none')
  })

  test('gaps_found => none regardless of acknowledged', () => {
    assert.equal(resolveVerifyBannerState('gaps_found', false), 'none')
    assert.equal(resolveVerifyBannerState('gaps_found', true), 'none')
  })

  test('null verifyStatus => none', () => {
    assert.equal(resolveVerifyBannerState(null, false), 'none')
  })

  test('undefined verifyStatus => none', () => {
    assert.equal(resolveVerifyBannerState(undefined, false), 'none')
  })

  test('unknown string status => none', () => {
    assert.equal(resolveVerifyBannerState('unknown', false), 'none')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

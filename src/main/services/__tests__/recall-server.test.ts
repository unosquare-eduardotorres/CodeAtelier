/**
 * Unit tests for the recall MCP server's pure helpers.
 *
 * Focus: the union/dedupe strategy (registry ∪ messages), ref parsing,
 * body-aware search, superseded ordering, window slicing, and truncation —
 * i.e. everything that decides whether a past plan is actually recoverable.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  deriveSummary,
  deriveTitle,
  entryFromMessage,
  entryFromPlanRecord,
  extractPlanBlock,
  formatConversationWindow,
  formatEntryList,
  formatPlanDetail,
  matchesQuery,
  mergePlanEntries,
  parsePlanBody,
  parseRecallRef,
  parseTs,
  sliceWindow,
  type RecallPlanEntry
} from '../../mcp-servers/recall-helpers'
import type { PlanRecord } from '../../../shared/types'

// ── Fixtures ──

function makePlanRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    workspaceId: 'ws-1',
    source: 'chat',
    sourceId: 'msg-1',
    title: 'Docker Windows containers',
    summary: 'Migrate CI to Windows containers',
    planType: 'investigation',
    structuredPlan: {
      title: 'Docker Windows containers',
      summary: 'Migrate CI to Windows containers',
      rootCause: 'The daemon runs in Linux container mode',
      verification: ['CI green on windows-2022']
    },
    sourcePlanJson: null,
    requirementDocument: null,
    status: 'saved',
    linkedConversationId: 'conv-1',
    linkedMpaRunId: null,
    linkedCouncilSessionId: null,
    fileCount: 0,
    phaseCount: 0,
    riskCount: 0,
    createdAt: '2026-07-01 10:00:00',
    updatedAt: '2026-07-01 10:00:00',
    completedAt: null,
    previousPlanId: null,
    ...overrides
  }
}

const PLAN_MESSAGE = [
  'Here is what I found.',
  '',
  '```plan',
  '# Docker Windows containers',
  '',
  'Switch the CI runner to Windows containers.',
  '',
  '## Steps',
  '- flip the daemon',
  '```',
  '',
  'Let me know.'
].join('\n')

// ── Ref parsing ──

describe('parseRecallRef', () => {
  test('parses_plan_ref', () => {
    assert.deepEqual(parseRecallRef('plan:abc-123'), { kind: 'plan', id: 'abc-123' })
  })

  test('parses_msg_ref', () => {
    assert.deepEqual(parseRecallRef('msg:m-9'), { kind: 'msg', id: 'm-9' })
  })

  test('bare_id_falls_back_to_auto', () => {
    assert.deepEqual(parseRecallRef('abc-123'), { kind: 'auto', id: 'abc-123' })
  })

  test('trims_whitespace', () => {
    assert.deepEqual(parseRecallRef('  plan: abc  '), { kind: 'plan', id: 'abc' })
  })

  test('empty_ref_returns_null', () => {
    assert.equal(parseRecallRef('   '), null)
  })
})

// ── Timestamps ──

describe('parseTs', () => {
  test('sqlite_timestamp_is_treated_as_utc', () => {
    assert.equal(parseTs('2026-07-01 10:00:00'), Date.parse('2026-07-01T10:00:00Z'))
  })

  test('iso_timestamp_passes_through', () => {
    assert.equal(parseTs('2026-07-01T10:00:00.000Z'), Date.parse('2026-07-01T10:00:00Z'))
  })

  test('empty_or_invalid_returns_zero', () => {
    assert.equal(parseTs(null), 0)
    assert.equal(parseTs('not-a-date'), 0)
  })
})

// ── Plan block extraction ──

describe('extractPlanBlock', () => {
  test('extracts_triple_backtick_block', () => {
    const body = extractPlanBlock(PLAN_MESSAGE)
    assert.ok(body)
    assert.ok(body.startsWith('# Docker Windows containers'))
    assert.ok(body.includes('flip the daemon'))
  })

  test('extracts_quad_backtick_block', () => {
    const body = extractPlanBlock('````plan\n# Quad\ncontent\n````')
    assert.equal(body, '# Quad\ncontent')
  })

  test('returns_null_without_plan_block', () => {
    assert.equal(extractPlanBlock('just a normal reply'), null)
  })
})

describe('deriveTitle / deriveSummary', () => {
  test('title_prefers_heading', () => {
    assert.equal(deriveTitle('# Docker plan\nbody text'), 'Docker plan')
  })

  test('title_falls_back_to_first_line', () => {
    assert.equal(deriveTitle('Fix the build\nmore'), 'Fix the build')
  })

  test('title_handles_empty_body', () => {
    assert.equal(deriveTitle('   \n  '), 'Untitled plan')
  })

  test('summary_skips_the_title_heading', () => {
    assert.equal(deriveSummary('# Docker plan\n\nSwitch the runner.'), 'Switch the runner.')
  })
})

// ── Entry construction ──

describe('parsePlanBody', () => {
  test('json_plan_blocks_use_their_structured_fields', () => {
    // emit_plan writes a JSON StructuredPlan into the ```plan block — without
    // this branch the title would be a raw JSON blob.
    const parsed = parsePlanBody(
      JSON.stringify({
        type: 'audit',
        title: 'Unify loading UI patterns',
        summary: 'Three loading variants coexist',
        verification: ['one spinner per scenario']
      })
    )
    assert.equal(parsed.title, 'Unify loading UI patterns')
    assert.equal(parsed.summary, 'Three loading variants coexist')
    assert.equal(parsed.planType, 'audit')
    assert.ok(parsed.rendered.includes('one spinner per scenario'))
    assert.ok(!parsed.rendered.startsWith('{'), 'JSON must be rendered, not dumped')
  })

  test('markdown_plan_blocks_fall_back_to_heuristics', () => {
    const parsed = parsePlanBody('# Docker plan\n\nSwitch the runner.')
    assert.equal(parsed.title, 'Docker plan')
    assert.equal(parsed.summary, 'Switch the runner.')
    assert.equal(parsed.planType, null)
  })

  test('malformed_json_does_not_throw', () => {
    const parsed = parsePlanBody('{ "title": broken')
    assert.ok(parsed.title.length > 0)
    assert.equal(parsed.planType, null)
  })
})

describe('entryFromMessage', () => {
  test('builds_msg_ref_entry', () => {
    const entry = entryFromMessage({
      id: 'm-1',
      conversationId: 'conv-1',
      conversationTitle: 'CI pipeline',
      createdAt: '2026-07-01 10:00:00',
      contentMd: PLAN_MESSAGE
    })
    assert.ok(entry)
    assert.equal(entry.ref, 'msg:m-1')
    assert.equal(entry.title, 'Docker Windows containers')
    assert.equal(entry.source, 'message')
    assert.equal(entry.status, null)
    assert.equal(entry.superseded, false)
    assert.equal(entry.conversationTitle, 'CI pipeline')
  })

  test('json_plan_block_yields_a_readable_title', () => {
    const entry = entryFromMessage({
      id: 'm-json',
      conversationId: 'conv-1',
      conversationTitle: 'UX UI fixes',
      createdAt: '2026-07-01 10:00:00',
      contentMd:
        'Here you go.\n\n```plan\n' +
        JSON.stringify({ type: 'audit', title: 'Unify loading UI', summary: 'Three variants' }) +
        '\n```'
    })
    assert.ok(entry)
    assert.equal(entry.title, 'Unify loading UI')
    assert.equal(entry.planType, 'audit')
  })

  test('returns_null_when_no_plan_block', () => {
    assert.equal(
      entryFromMessage({
        id: 'm-2',
        conversationId: 'conv-1',
        conversationTitle: null,
        createdAt: '2026-07-01 10:00:00',
        contentMd: 'no plan here'
      }),
      null
    )
  })
})

describe('entryFromPlanRecord', () => {
  test('builds_plan_ref_entry_with_rendered_body', () => {
    const entry = entryFromPlanRecord(makePlanRecord())
    assert.equal(entry.ref, 'plan:plan-1')
    assert.equal(entry.source, 'chat')
    assert.equal(entry.status, 'saved')
    assert.equal(entry.superseded, false)
    assert.ok(entry.body.includes('daemon runs in Linux container mode'))
    assert.ok(entry.body.includes('CI green on windows-2022'))
  })

  test('archived_plan_is_marked_superseded', () => {
    const entry = entryFromPlanRecord(makePlanRecord({ status: 'archived' }))
    assert.equal(entry.superseded, true)
  })
})

// ── Union + dedupe ──

describe('mergePlanEntries', () => {
  const registryEntry = entryFromPlanRecord(makePlanRecord())
  const sameMessage = entryFromMessage({
    id: 'm-1',
    conversationId: 'conv-1',
    conversationTitle: 'CI pipeline',
    createdAt: '2026-07-01 10:00:30', // 30s after the registry row
    contentMd: PLAN_MESSAGE
  })!

  test('collapses_registry_and_message_within_window', () => {
    const merged = mergePlanEntries([registryEntry], [sameMessage])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].ref, 'plan:plan-1', 'registry entry wins')
    assert.equal(merged[0].altRef, 'msg:m-1', 'message ref is carried alongside')
    assert.equal(merged[0].conversationTitle, 'CI pipeline', 'title borrowed from the message')
  })

  test('keeps_both_when_outside_the_time_window', () => {
    const later = { ...sameMessage, createdAt: '2026-07-01 10:05:00' }
    const merged = mergePlanEntries([registryEntry], [later])
    assert.equal(merged.length, 2)
  })

  test('keeps_both_when_conversations_differ', () => {
    const other = { ...sameMessage, conversationId: 'conv-2' }
    const merged = mergePlanEntries([registryEntry], [other])
    assert.equal(merged.length, 2)
  })

  test('empty_registry_still_returns_message_plans', () => {
    // The real-world case: plans table has 0 rows, messages carry the plans.
    const merged = mergePlanEntries([], [sameMessage])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].ref, 'msg:m-1')
  })

  test('does_not_mutate_the_input_entries', () => {
    mergePlanEntries([registryEntry], [sameMessage])
    assert.equal(registryEntry.altRef, undefined)
  })

  test('two_messages_do_not_both_claim_one_registry_row', () => {
    const second = { ...sameMessage, ref: 'msg:m-2', createdAt: '2026-07-01 10:00:45' }
    const merged = mergePlanEntries([registryEntry], [sameMessage, second])
    assert.equal(merged.length, 2)
    assert.equal(merged[0].altRef ?? merged[1].altRef, 'msg:m-1')
  })

  test('superseded_entries_rank_last', () => {
    const archived = entryFromPlanRecord(
      makePlanRecord({
        id: 'plan-old',
        status: 'archived',
        linkedConversationId: 'conv-9',
        createdAt: '2026-07-02 10:00:00'
      })
    )
    const merged = mergePlanEntries([archived, registryEntry], [])
    assert.equal(merged[0].ref, 'plan:plan-1')
    assert.equal(merged[1].ref, 'plan:plan-old')
  })

  test('current_entries_sort_newest_first', () => {
    const newer = entryFromPlanRecord(
      makePlanRecord({ id: 'plan-2', linkedConversationId: 'conv-3', createdAt: '2026-07-05 09:00:00' })
    )
    const merged = mergePlanEntries([registryEntry, newer], [])
    assert.equal(merged[0].ref, 'plan:plan-2')
  })
})

// ── Search ──

describe('matchesQuery', () => {
  const entry = entryFromPlanRecord(makePlanRecord())

  test('matches_title', () => {
    assert.equal(matchesQuery(entry, 'docker'), true)
  })

  test('matches_body_not_just_title_or_summary', () => {
    // "daemon" appears only inside the plan body — the registry SQL search
    // (title/summary only) would miss this.
    assert.equal(matchesQuery(entry, 'daemon'), true)
  })

  test('no_match_returns_false', () => {
    assert.equal(matchesQuery(entry, 'kubernetes'), false)
  })

  test('empty_query_matches_everything', () => {
    assert.equal(matchesQuery(entry, undefined), true)
    assert.equal(matchesQuery(entry, '   '), true)
  })
})

// ── Formatting ──

describe('formatEntryList', () => {
  test('empty_result_explains_the_search', () => {
    const text = formatEntryList([], 'docker')
    assert.ok(text.includes('No past plans matched "docker"'))
  })

  test('empty_result_without_query', () => {
    assert.ok(formatEntryList([]).includes('No past plans recorded'))
  })

  test('labels_superseded_entries_and_lists_refs', () => {
    const archived = entryFromPlanRecord(makePlanRecord({ status: 'archived' }))
    const text = formatEntryList([archived], 'docker')
    assert.ok(text.includes('[plan:plan-1]'))
    assert.ok(text.includes('[superseded]'))
    assert.ok(text.includes('recall_conversation'))
  })
})

describe('formatPlanDetail', () => {
  test('includes_lineage_and_supersede_warning', () => {
    const entry = entryFromPlanRecord(makePlanRecord({ status: 'archived' }))
    const superseding = entryFromPlanRecord(
      makePlanRecord({ id: 'plan-2', title: 'Docker plan v2' })
    )
    const text = formatPlanDetail(entry, { superseding, previous: null })
    assert.ok(text.includes('# Docker Windows containers'))
    assert.ok(text.includes('superseded'))
    assert.ok(text.includes('plan:plan-2'))
  })

  test('handles_entry_without_body', () => {
    const entry: RecallPlanEntry = {
      ref: 'msg:m-3',
      title: 'Bare',
      summary: '',
      source: 'message',
      status: null,
      conversationId: null,
      createdAt: '2026-07-01 10:00:00',
      superseded: false,
      body: ''
    }
    assert.ok(formatPlanDetail(entry).includes('(empty plan body)'))
  })
})

// ── Conversation window ──

describe('sliceWindow', () => {
  const messages = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  test('includes_anchor_and_both_sides', () => {
    const { window, startIndex } = sliceWindow(messages, 3, 2, 2)
    assert.deepEqual(window, ['b', 'c', 'd', 'e', 'f'])
    assert.equal(startIndex, 1)
  })

  test('clamps_at_the_start', () => {
    const { window, startIndex } = sliceWindow(messages, 0, 5, 1)
    assert.deepEqual(window, ['a', 'b'])
    assert.equal(startIndex, 0)
  })

  test('clamps_at_the_end', () => {
    const { window } = sliceWindow(messages, 6, 1, 5)
    assert.deepEqual(window, ['f', 'g'])
  })
})

describe('formatConversationWindow', () => {
  test('marks_the_anchor_and_truncates_long_messages', () => {
    const long = 'x'.repeat(4000)
    const text = formatConversationWindow({
      conversationTitle: 'CI pipeline',
      anchorRef: 'msg:m-1',
      anchorId: 'm-1',
      messages: [
        { id: 'm-0', role: 'user', createdAt: '2026-07-01 09:59:00', contentMd: 'why is CI red?' },
        { id: 'm-1', role: 'specialist', createdAt: '2026-07-01 10:00:00', contentMd: long }
      ],
      totalInConversation: 12
    })
    assert.ok(text.includes('← plan'))
    assert.ok(text.includes('why is CI red?'))
    assert.ok(text.includes('[…truncated]'))
    assert.ok(text.length < long.length, 'long message must be capped')
    assert.ok(text.includes('2 of 12 messages'))
  })

  test('empty_window_is_explained', () => {
    const text = formatConversationWindow({
      conversationTitle: null,
      anchorRef: 'plan:plan-1',
      anchorId: null,
      messages: [],
      totalInConversation: 0
    })
    assert.ok(text.includes('No messages found'))
  })
})

// Run standalone
const thisFile = new URL(import.meta.url).pathname
if (process.argv[1] && thisFile.endsWith(process.argv[1].replace(/.*\//, ''))) {
  void summaryAsync()
}

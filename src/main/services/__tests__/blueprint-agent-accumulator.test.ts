/**
 * Blueprint Agent Accumulator tests — flush boundaries, caps, cancel cleanup,
 * taskId key isolation.
 *
 * Run: npx tsx src/main/services/__tests__/blueprint-agent-accumulator.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  createAccumulator,
  AGENT_ENTRY_CHAR_CAP,
  AGENT_PHASE_CHAR_CAP,
  type JournalAppendFn
} from '../blueprint-agent-accumulator'

// ── Helpers ──

interface JournalEntry {
  blueprintId: string
  type: string
  payload: Record<string, unknown>
}

function createTestAccumulator() {
  const journal: JournalEntry[] = []
  const appendFn: JournalAppendFn = (blueprintId, type, payload) => {
    journal.push({ blueprintId, type, payload })
  }
  const acc = createAccumulator(appendFn)
  return { acc, journal }
}

// ── Tests ──

describe('createAccumulator', () => {
  // ── Text accumulation + flush ──

  test('text chunks accumulate until flush', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'specify', undefined, 'Hello ')
    acc.handleChunk('bp-1', 'specify', undefined, 'world')
    assert.equal(journal.length, 0, 'No flush yet')

    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 1)
    assert.equal(journal[0].payload.content, 'Hello world')
    assert.equal(journal[0].payload.phase, 'specify')
    assert.equal(journal[0].type, 'agent')
  })

  // ── Text-boundary flush on tool event ──

  test('tool event flushes accumulated text first', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'build', undefined, 'Some analysis...')
    acc.handleChunk('bp-1', 'build', 'tool', undefined, { toolName: 'Read', id: 't1' })

    // Text should have been flushed
    assert.equal(journal.length, 1)
    assert.equal(journal[0].payload.content, 'Some analysis...')
    // Tool activity should be in the accumulator (not yet flushed)
    const accState = acc.getAccumulator('bp-1', 'build')
    assert.equal(accState.toolActivities.length, 1)
  })

  test('tool event with no prior text does not flush', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'build', 'tool', undefined, { toolName: 'Read', id: 't1' })
    assert.equal(journal.length, 0, 'No flush for tool-only')
    // But tool activity is recorded
    const accState = acc.getAccumulator('bp-1', 'build')
    assert.equal(accState.toolActivities.length, 1)
  })

  test('flush includes tool activities accumulated after text flush', () => {
    const { acc, journal } = createTestAccumulator()
    // Text → tool (flushes text) → more text → flush
    acc.handleChunk('bp-1', 'build', undefined, 'Analysis text')
    acc.handleChunk('bp-1', 'build', 'tool', undefined, { toolName: 'Read', id: 't1' })
    // journal[0] = text flush
    acc.handleChunk('bp-1', 'build', undefined, 'More analysis')
    acc.flush('bp-1', 'build')
    // journal[1] = second flush with tool activity from prior boundary
    assert.equal(journal.length, 2)
    assert.equal(journal[1].payload.content, 'More analysis')
    assert.deepEqual(journal[1].payload.toolActivities, [{ toolName: 'Read', id: 't1' }])
  })

  // ── 32KB entry cap ──

  test('entry text is capped at AGENT_ENTRY_CHAR_CAP', () => {
    const { acc, journal } = createTestAccumulator()
    const bigText = 'X'.repeat(AGENT_ENTRY_CHAR_CAP + 1000)
    acc.handleChunk('bp-1', 'specify', undefined, bigText)
    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 1)
    const content = journal[0].payload.content as string
    assert.ok(content.length <= AGENT_ENTRY_CHAR_CAP + 100, 'Content should be capped near entry limit')
    assert.ok(content.includes('[… truncated at 32KB]'), 'Should include truncation marker')
  })

  // ── 1MB phase cap ──

  test('entries exceeding phase cap are silently dropped', () => {
    const { acc, journal } = createTestAccumulator()
    // Fill up to phase cap
    const chunkSize = AGENT_ENTRY_CHAR_CAP // 32KB per flush
    const numFlushes = Math.ceil(AGENT_PHASE_CHAR_CAP / chunkSize) + 5 // exceed cap
    for (let i = 0; i < numFlushes; i++) {
      acc.handleChunk('bp-1', 'build', undefined, 'A'.repeat(chunkSize))
      acc.flush('bp-1', 'build')
    }
    // Should have fewer entries than numFlushes (some dropped by cap)
    const totalChars = journal.reduce((sum, e) => sum + ((e.payload.content as string)?.length ?? 0), 0)
    assert.ok(totalChars <= AGENT_PHASE_CHAR_CAP + AGENT_ENTRY_CHAR_CAP,
      `Total chars (${totalChars}) should not greatly exceed phase cap`)
  })

  // ── flushAllForBlueprint (cancel cleanup) ──

  test('flushAllForBlueprint flushes all keys for a blueprint', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'build', undefined, 'text-1', undefined, 'task-A')
    acc.handleChunk('bp-1', 'build', undefined, 'text-2', undefined, 'task-B')
    acc.handleChunk('bp-1', 'verify', undefined, 'verify-text')
    acc.handleChunk('bp-2', 'build', undefined, 'other-bp') // different blueprint

    acc.flushAllForBlueprint('bp-1')
    // Should flush 3 entries for bp-1
    assert.equal(journal.length, 3)
    assert.ok(journal.every(e => e.blueprintId === 'bp-1'), 'All entries should be for bp-1')
    // bp-2 accumulator should still exist
    const bp2Acc = acc.getAccumulator('bp-2', 'build')
    assert.equal(bp2Acc.text, 'other-bp')
  })

  // ── taskId key isolation ──

  test('different taskIds maintain separate accumulators', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'build', undefined, 'task-A content', undefined, 'task-A')
    acc.handleChunk('bp-1', 'build', undefined, 'task-B content', undefined, 'task-B')

    acc.flush('bp-1', 'build', 'task-A')
    assert.equal(journal.length, 1)
    assert.equal(journal[0].payload.content, 'task-A content')
    assert.equal(journal[0].payload.taskId, 'task-A')

    acc.flush('bp-1', 'build', 'task-B')
    assert.equal(journal.length, 2)
    assert.equal(journal[1].payload.content, 'task-B content')
    assert.equal(journal[1].payload.taskId, 'task-B')
  })

  test('flush without taskId does not include taskId in payload', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'specify', undefined, 'no-task content')
    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 1)
    assert.equal(journal[0].payload.taskId, undefined)
  })

  // ── flushAllForPhase ──

  test('flushAllForPhase flushes all taskId variants for a phase', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'build', undefined, 'lane-1', undefined, 'task-1')
    acc.handleChunk('bp-1', 'build', undefined, 'lane-2', undefined, 'task-2')
    acc.handleChunk('bp-1', 'build', undefined, 'no-task')
    acc.handleChunk('bp-1', 'verify', undefined, 'verify-text') // different phase

    acc.flushAllForPhase('bp-1', 'build')
    assert.equal(journal.length, 3) // 3 build entries
    assert.ok(journal.every(e => e.payload.phase === 'build'))

    // verify accumulator should still have content
    const verifyAcc = acc.getAccumulator('bp-1', 'verify')
    assert.equal(verifyAcc.text, 'verify-text')
  })

  // ── Empty accumulator flush is a no-op ──

  test('flushing empty accumulator produces no journal entry', () => {
    const { acc, journal } = createTestAccumulator()
    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 0)
  })

  test('flushing whitespace-only text with no tools produces no journal entry', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'specify', undefined, '   \n  ')
    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 0)
  })

  test('flushing whitespace-only text WITH tools DOES produce journal entry', () => {
    const { acc, journal } = createTestAccumulator()
    acc.handleChunk('bp-1', 'specify', 'tool', undefined, { toolName: 'Read', id: 't1' })
    acc.flush('bp-1', 'specify')
    assert.equal(journal.length, 1)
    assert.deepEqual(journal[0].payload.toolActivities, [{ toolName: 'Read', id: 't1' }])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

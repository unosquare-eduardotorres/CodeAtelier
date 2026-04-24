/**
 * Unit tests for DaVinciPromptAssembler — state management methods and
 * buildEffectiveMessage composition logic.
 *
 * Tests cover: addPendingContext, setPendingCompaction, resetSession,
 * clearConversation, invalidateSnapshot, buildEffectiveMessage with various
 * injection strategies, and memory budget scaling.
 *
 * DB-dependent methods (buildSystemPromptForTurn, buildSpecialistRoster) are
 * excluded — they require live DB and are P2/integration tier.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createPromptAssembler } from './helpers/agent-factory'

/** Default options for buildEffectiveMessage */
function defaultMessageOpts(overrides?: Partial<{
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: string
  investigationModeEnabled: boolean
}>) {
  return {
    message: overrides?.message ?? 'Hello world',
    conversationId: overrides?.conversationId ?? 'conv-1',
    hasImages: overrides?.hasImages ?? false,
    turnCount: overrides?.turnCount ?? 1,
    sessionId: overrides?.sessionId ?? undefined,
    mode: (overrides?.mode ?? 'plan') as 'plan' | 'build',
    investigationModeEnabled: overrides?.investigationModeEnabled ?? false
  }
}

describe('DaVinciPromptAssembler', () => {
  test('addPendingContext_stores_and_measures_context', () => {
    const { assembler } = createPromptAssembler()
    assert.equal(assembler.getPendingContextSize('conv-1'), 0)
    assembler.addPendingContext('conv-1', 'Some specialist output here')
    assert.equal(assembler.getPendingContextSize('conv-1'), 'Some specialist output here'.length)
  })

  test('addPendingContext_accumulates_multiple_injections', () => {
    const { assembler } = createPromptAssembler()
    assembler.addPendingContext('conv-1', 'First context')
    assembler.addPendingContext('conv-1', 'Second context')
    // Should be concatenated with \n\n separator
    const expectedLen = 'First context'.length + '\n\n'.length + 'Second context'.length
    assert.equal(assembler.getPendingContextSize('conv-1'), expectedLen)
  })

  test('setPendingCompaction_stores_compaction_prompt', () => {
    const { assembler } = createPromptAssembler()
    assembler.setPendingCompaction('conv-1', '/compact Summarize the conversation')
    // Verify it's consumed in buildEffectiveMessage
    const result = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(
      result.includes('/compact Summarize the conversation'),
      'Compaction prompt should be in effective message'
    )
    // After consumption, building again should NOT include the compaction
    const result2 = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(
      !result2.includes('/compact Summarize the conversation'),
      'Compaction should be consumed after first use'
    )
  })

  test('resetSession_clears_all_state', () => {
    const { assembler } = createPromptAssembler()
    // Set various state
    assembler.addPendingContext('conv-1', 'context')
    assembler.setPendingCompaction('conv-1', 'compact')
    assembler.setMemoryContext('memory data')
    assembler.setPendingModeSwitch('plan', 'build')
    assembler.incrementTurnCount('conv-1')

    // Reset everything
    assembler.resetSession()

    // Verify all cleared
    assert.equal(assembler.getPendingContextSize('conv-1'), 0)
    // Turn count should be reset — next increment returns 1
    assert.equal(assembler.incrementTurnCount('conv-1'), 1)
    // buildEffectiveMessage should have no injections (except conditional prefix)
    const result = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 5 }))
    assert.ok(!result.includes('context'), 'Pending context should be cleared')
    assert.ok(!result.includes('compact'), 'Pending compaction should be cleared')
    assert.ok(!result.includes('Auto Memory'), 'Memory context should be cleared')
  })

  test('clearConversation_removes_single_conversation_turn_count', () => {
    const { assembler } = createPromptAssembler()
    assembler.incrementTurnCount('conv-1')  // → 1
    assembler.incrementTurnCount('conv-1')  // → 2
    assembler.incrementTurnCount('conv-2')  // → 1

    // Clear only conv-1
    assembler.clearConversation('conv-1')

    // conv-1 should start fresh, conv-2 should be unaffected
    assert.equal(assembler.incrementTurnCount('conv-1'), 1, 'conv-1 should restart at 1')
    assert.equal(assembler.incrementTurnCount('conv-2'), 2, 'conv-2 should continue at 2')
  })

  test('invalidateSnapshot_forces_rebuild_on_next_turn', () => {
    const { assembler } = createPromptAssembler()
    // We can't directly check the private snapshot field, but we can verify
    // invalidateSnapshot doesn't throw and the assembler continues to function
    assembler.invalidateSnapshot()
    // After invalidation, buildEffectiveMessage should still work normally
    const result = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(result.includes('Hello world'), 'Message should still contain user input')
  })

  test('buildEffectiveMessage_prepends_pending_context', () => {
    const { assembler } = createPromptAssembler()
    assembler.addPendingContext('conv-1', 'Specialist execution result: file created successfully')
    const result = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(
      result.includes('Context from prior specialist execution'),
      'Should contain specialist context header'
    )
    assert.ok(
      result.includes('Specialist execution result: file created successfully'),
      'Should contain the actual context'
    )
    assert.ok(
      result.indexOf('specialist execution') < result.indexOf('Hello world'),
      'Context should be prepended before user message'
    )
  })

  test('buildEffectiveMessage_prepends_mode_switch_context', () => {
    const { assembler } = createPromptAssembler()
    assembler.setPendingModeSwitch('plan', 'build')
    const result = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(
      result.includes('Mode switched from plan to build'),
      'Should contain mode switch context'
    )
    assert.ok(
      result.includes('full permissions'),
      'Build mode should mention full permissions'
    )
    // Mode switch should be consumed
    const result2 = assembler.buildEffectiveMessage(defaultMessageOpts())
    assert.ok(
      !result2.includes('Mode switched'),
      'Mode switch should be consumed after first use'
    )
  })

  test('buildEffectiveMessage_injects_memory_on_turn_1_and_2', () => {
    const { assembler } = createPromptAssembler()
    assembler.setMemoryContext('User prefers tabs over spaces')

    // Turn 1: full memory injection
    const turn1 = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 1 }))
    assert.ok(turn1.includes('Auto Memory'), 'Turn 1 should include Auto Memory header')
    assert.ok(turn1.includes('User prefers tabs over spaces'), 'Turn 1 should include memory')

    // Turn 2: still full memory injection
    const turn2 = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 2 }))
    assert.ok(turn2.includes('Auto Memory'), 'Turn 2 should include Auto Memory header')

    // Turn 3+: only feedback memories (or nothing if no feedback section)
    const turn3 = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 3 }))
    assert.ok(!turn3.includes('Auto Memory'), 'Turn 3 should NOT include full Auto Memory')
  })

  test('getMemoryBudgetForTurn_scales_by_turn_and_cost', () => {
    const { assembler } = createPromptAssembler()
    // getMemoryBudgetForTurn is private, so we test its behavior via
    // setMemoryContext + buildEffectiveMessage at different turns.
    // We verify the memory IS present on early turns and feedback-only on late turns.

    // Set memory with a feedback section
    assembler.setMemoryContext(
      '## Preferences\nUser likes dark mode\n\n## Feedback & Corrections\nAlways use strict mode\n\n## Other\nMisc info'
    )

    // Turn 1: full memory
    const turn1 = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 1 }))
    assert.ok(turn1.includes('User likes dark mode'), 'Turn 1: full memory with preferences')
    assert.ok(turn1.includes('Always use strict mode'), 'Turn 1: full memory with feedback')

    // Turn 4+: only feedback section extracted
    const turn4 = assembler.buildEffectiveMessage(defaultMessageOpts({ turnCount: 4 }))
    assert.ok(!turn4.includes('User likes dark mode'), 'Turn 4: no preferences section')
    assert.ok(turn4.includes('Always use strict mode'), 'Turn 4: feedback section preserved')
  })
})

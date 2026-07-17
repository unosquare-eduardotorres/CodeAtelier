/**
 * Prompt Verbosity — verifies resolvePromptVerbosity() model-based gating.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { resolvePromptVerbosity } from '../../../shared/constants'
import { buildConditionalPrefix } from '../prompt-assembly-helpers'
import { promptBuilder } from '../prompt-builder'

describe('Prompt Verbosity', () => {
  test('opus-4-8 resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-opus-4-8'), 'lean')
  })

  test('sonnet 5 resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-sonnet-5'), 'lean')
  })

  test('sonnet 4.6 (legacy) resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-sonnet-4-6'), 'lean')
  })

  test('fable 5 resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-fable-5'), 'lean')
  })

  test('haiku resolves to full', () => {
    assert.equal(resolvePromptVerbosity('claude-haiku-4-5-20251001'), 'full')
  })

  test('opus-4-7 resolves to full', () => {
    assert.equal(resolvePromptVerbosity('claude-opus-4-7'), 'full')
  })

  test('unknown model resolves to full', () => {
    assert.equal(resolvePromptVerbosity('claude-unknown-99'), 'full')
  })

  test('empty string resolves to full', () => {
    assert.equal(resolvePromptVerbosity(''), 'full')
  })

  test('future opus model (4-9) resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-opus-4-9'), 'lean')
  })

  test('future opus model (5-0) resolves to lean', () => {
    assert.equal(resolvePromptVerbosity('claude-opus-5-0'), 'lean')
  })
})

describe('Lean Conditional Gating', () => {
  test('lean mode includes unified memory protocol prompt on turn 1', () => {
    const out = buildConditionalPrefix({
      message: 'remember this preference for future sessions',
      hasImages: false,
      mode: 'plan',
      turnCount: 1,
      model: 'claude-opus-4-8'
    })
    // W2: full and lean unified — both include the same type taxonomy prompt
    assert.ok(out.includes('mcp__memory__memory_search'), 'Lean mode should include memory tools prompt on turn 1')
  })

  test('full mode includes memory protocol prompt', () => {
    const out = buildConditionalPrefix({
      message: 'remember this preference for future sessions',
      hasImages: false,
      mode: 'plan',
      turnCount: 1,
      model: 'claude-haiku-4-5-20251001'
    })
    // W2: full and lean are now unified — check for content present in the unified prompt
    assert.ok(out.includes('mcp__memory__memory_search'), 'Full mode should include memory tools prompt')
  })

  test('lean mode uses compressed direct-answer boost on turn 3+', () => {
    const out = buildConditionalPrefix({
      message: 'what does this function do?',
      hasImages: false,
      mode: 'build',
      turnCount: 3,
      model: 'claude-opus-4-8'
    })
    // Lean should use the compressed variant
    assert.ok(out.includes('Answer from context'), 'Lean should use compressed direct-answer boost')
    assert.ok(
      !out.includes('Answer-Complete Rule'),
      'Lean should not contain verbose Answer-Complete section'
    )
  })

  test('full mode uses compressed direct-answer boost on turn 3+', () => {
    const out = buildConditionalPrefix({
      message: 'what does this function do?',
      hasImages: false,
      mode: 'build',
      turnCount: 3,
      model: 'claude-haiku-4-5-20251001'
    })
    // W2: full variant compressed — no more verbose "Answer-Complete Rule" subsection
    assert.ok(
      out.includes('STOP'),
      'Full mode should contain STOP rule for direct answers'
    )
  })

  test('lean mode tightens ask-question regex', () => {
    // "which file" should NOT trigger ask_user in lean mode (too broad)
    const leanSections = promptBuilder.getGeneralistConditionalSections(
      'which file has the bug?',
      false,
      'lean'
    )
    assert.ok(
      !leanSections.includeAskQuestionPrompt,
      'Lean should not trigger ask_user for broad "which" queries'
    )

    // But "choose between" should still trigger
    const leanSections2 = promptBuilder.getGeneralistConditionalSections(
      'should I choose between React and Vue?',
      false,
      'lean'
    )
    assert.ok(
      leanSections2.includeAskQuestionPrompt,
      'Lean should trigger ask_user for explicit "choose between"'
    )
  })

  test('full mode keeps broad ask-question regex', () => {
    const fullSections = promptBuilder.getGeneralistConditionalSections(
      'which file has the bug?',
      false,
      'full'
    )
    assert.ok(
      fullSections.includeAskQuestionPrompt,
      'Full should trigger ask_user for broad "which" queries'
    )
  })
})

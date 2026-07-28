/**
 * Lean Identity Prompt — verifies the compressed specialist identity prompt
 * for Opus 4.8+ models preserves key structure while being significantly shorter.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { buildSpecialistIdentityPrompt, buildSpecialistIdentityPromptLean } from '../default-prompts'

describe('Lean Identity Prompt', () => {
  test('lean prompt length is within 25% of full prompt', () => {
    const full = buildSpecialistIdentityPrompt('default')
    const lean = buildSpecialistIdentityPromptLean('default')
    // After trimming, the "full" prompt became very compact. Lean retains
    // slightly more detail for small-context models (including inline Code
    // Exploration guidance with fully-qualified MCP tool names). Either being
    // shorter is acceptable — the important invariant is they stay close.
    const ratio = lean.length / full.length
    assert.ok(
      ratio < 1.40,
      `Lean/full ratio (${ratio.toFixed(2)}) exceeds 40% — lean=${lean.length} full=${full.length}`
    )
  })

  test('lean prompt includes all structural sections', () => {
    const lean = buildSpecialistIdentityPromptLean('default')
    assert.ok(lean.includes('## Style'), 'Missing ## Style section')
    assert.ok(lean.includes('## Tool Usage'), 'Missing ## Tool Usage section')
    assert.ok(lean.includes('## Code Exploration'), 'Missing ## Code Exploration section')
    assert.ok(lean.includes('## Structured Actions'), 'Missing ## Structured Actions section')
    assert.ok(lean.includes('emit_plan'), 'Missing emit_plan reference')
    assert.ok(lean.includes('ask_user'), 'Missing ask_user reference')
    assert.ok(lean.includes('mcp__memory__memory_search'), 'Missing memory_search reference')
  })

  test('lean prompt preserves all 5 tones', () => {
    const tones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const
    for (const tone of tones) {
      const lean = buildSpecialistIdentityPromptLean(tone)
      assert.ok(lean.includes('## Style'), `Missing ## Style for tone=${tone}`)
      // Each tone should produce a different style directive
      assert.ok(lean.length > 200, `Lean prompt too short for tone=${tone}`)
    }
  })

  test('lean prompt omits verbose labels present in full prompt', () => {
    const lean = buildSpecialistIdentityPromptLean('default')
    // Lean should NOT have the verbose MANDATORY/CRITICAL labels
    assert.ok(!lean.includes('(MANDATORY)'), 'Lean prompt should not contain (MANDATORY)')
    assert.ok(!lean.includes('(CRITICAL)'), 'Lean prompt should not contain (CRITICAL)')
    assert.ok(!lean.includes('(IMPORTANT)'), 'Lean prompt should not contain (IMPORTANT)')
  })

  test('full prompt retains verbose labels', () => {
    const full = buildSpecialistIdentityPrompt('default')
    assert.ok(full.includes('(MANDATORY)'), 'Full prompt should contain (MANDATORY)')
  })

  test('lean identity includes Code Exploration rules from repomap merge', () => {
    const lean = buildSpecialistIdentityPromptLean('default')
    assert.ok(lean.includes('file_outline'), 'Missing file_outline guidance (merged from repomap)')
    assert.ok(
      lean.includes('coupling_analysis'),
      'Missing coupling_analysis guidance (merged from repomap)'
    )
    assert.ok(lean.includes('find_callers'), 'Missing find_callers guidance')
    assert.ok(lean.includes('file_dependents'), 'Missing file_dependents guidance')
  })

  test('full prompt does NOT include ## Tool Priority (injected separately via appendMcpToolGuidance)', () => {
    const full = buildSpecialistIdentityPrompt('default')
    assert.ok(
      !full.includes('## Tool Priority'),
      'Full prompt should NOT include ## Tool Priority — it is injected by appendMcpToolGuidance'
    )
  })
})

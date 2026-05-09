/**
 * Unit tests for prompt-assembly-helpers.
 *
 * Verifies that both stateless helpers emit the expected content AND do NOT
 * leak any stale handoff/delegation vocabulary (per the unification plan).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { appendMcpToolGuidance, buildConditionalPrefix } from '../prompt-assembly-helpers'

describe('appendMcpToolGuidance', () => {
  test('no-op after turn 1', () => {
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: true
    })
    assert.equal(out, 'BASE')
  })

  test('appends only flagged blocks on turn 1', () => {
    const allOff = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      githubConfigured: false
    })
    // Git + checkpoint always mount.
    assert.ok(allOff.includes('## Git Context Tools'))
    assert.ok(allOff.includes('## Checkpoint Tools'))
    // Repomap / Semantic / GitHub require flags.
    assert.ok(!allOff.includes('## Code Graph Tools'))
    assert.ok(!allOff.includes('## Semantic Search'))
    assert.ok(!allOff.includes('## GitHub Tools'))

    const allOn = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: true
    })
    assert.ok(allOn.includes('## Code Graph Tools'))
    assert.ok(allOn.includes('## Semantic Search'))
    assert.ok(allOn.includes('## GitHub Tools'))
  })

  test('idempotent when block already present in base prompt', () => {
    const base = 'BASE\n\n## Code Graph Tools\n(already here)'
    const out = appendMcpToolGuidance(base, 1, {
      repomapEnabled: true,
      semanticSearchEnabled: false,
      githubConfigured: false
    })
    // Should not duplicate the Code Graph section.
    const matches = out.match(/## Code Graph Tools/g) ?? []
    assert.equal(matches.length, 1)
  })
})

describe('buildConditionalPrefix', () => {
  test('plan-mode adds emit_plan reminder for non-question messages', () => {
    const out = buildConditionalPrefix({
      message: 'just a chat message',
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    assert.ok(out.includes('emit_plan'))
  })

  test('build-mode skips emit_plan reminder for plain chat', () => {
    const out = buildConditionalPrefix({
      message: 'just a chat message',
      hasImages: false,
      mode: 'build',
      turnCount: 1
    })
    // For a non-plan-requesting build-mode message with no triggers, prefix
    // may be empty — but crucially should NOT include a plan reminder.
    assert.ok(!out.includes('emit_plan'))
  })

  test('build-mode adds emit_plan reminder when user asks for a plan', () => {
    const out = buildConditionalPrefix({
      message: 'Can you draft a plan for the new feature?',
      hasImages: false,
      mode: 'build',
      turnCount: 1
    })
    assert.ok(out.includes('emit_plan'))
  })

  test('plan-mode skips emit_plan reminder for simple questions', () => {
    const out = buildConditionalPrefix({
      message: 'why do we have string as IDs?',
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    // The plan *reminder* must be absent — but the direct-answer signal may
    // mention "emit_plan" in a "Do NOT call emit_plan" context, so we check
    // for the specific reminder wording rather than any mention of "emit_plan".
    assert.ok(
      !out.includes('Reminder: Use the emit_plan tool'),
      'Simple question in plan mode should NOT get plan reminder'
    )
  })

  test('plan-mode adds emit_plan reminder when question has mutation intent', () => {
    const out = buildConditionalPrefix({
      message: 'why is authentication broken and fix it',
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    assert.ok(out.includes('emit_plan'), 'Mutation intent should override question pattern')
  })

  test('plan-mode adds emit_plan reminder for investigation keywords', () => {
    const out = buildConditionalPrefix({
      message: 'investigate why the tests are failing',
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    assert.ok(out.includes('emit_plan'), 'isPlanGenerationRequest should override isSimpleQuestion')
  })

  test('plan-mode injects direct-answer signal on turn 1 for questions', () => {
    const out = buildConditionalPrefix({
      message: 'what does the workspace store contain?',
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    assert.ok(
      out.includes('answer it directly'),
      'Plan-mode question on turn 1 should get lightweight direct-answer signal'
    )
    // Check for absence of the plan *reminder* specifically (the direct-answer
    // signal may reference "emit_plan" in a "Do NOT call" context).
    assert.ok(
      !out.includes('Reminder: Use the emit_plan tool'),
      'Should NOT get plan reminder'
    )
  })

  test('plan-mode does NOT inject direct-answer signal for long messages', () => {
    // Messages > 300 chars suppress includeDirectAnswerBoost → plan reminder fires
    const longMessage = 'why '.repeat(100) // 400 chars
    const out = buildConditionalPrefix({
      message: longMessage,
      hasImages: false,
      mode: 'plan',
      turnCount: 1
    })
    assert.ok(out.includes('emit_plan'), 'Long messages should not be classified as simple questions')
  })

  test('build-mode question behavior unchanged', () => {
    const out = buildConditionalPrefix({
      message: 'why do we have string as IDs?',
      hasImages: false,
      mode: 'build',
      turnCount: 1
    })
    // Build mode with no isPlanGenerationRequest match → no plan reminder (existing behavior)
    assert.ok(!out.includes('emit_plan'))
  })

  test('no stale handoff vocabulary in any prefix variant', () => {
    // Exercise every flag combination with a message packed with triggers,
    // then assert handoff/delegation words NEVER appear.
    const variants = [
      { mode: 'plan' as const, turn: 1 },
      { mode: 'plan' as const, turn: 5 },
      { mode: 'build' as const, turn: 1 },
      { mode: 'build' as const, turn: 5 }
    ]
    for (const v of variants) {
      const out = buildConditionalPrefix({
        message:
          'Which option should I pick? remember this preference. draft a plan and investigate.',
        hasImages: true,
        mode: v.mode,
        turnCount: v.turn
      })
      assert.ok(!/hand[\s-]?off/i.test(out), `handoff leaked for ${v.mode}@${v.turn}: ${out}`)
      assert.ok(!/delegat/i.test(out), `delegation leaked for ${v.mode}@${v.turn}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

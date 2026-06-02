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
  test('turn 2+ appends compact tool priority reminder for non-lean models with repomap', () => {
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: true
    })
    assert.ok(out.includes('Tool Priority'), 'Should include compact tool priority reminder')
    assert.ok(out.includes('search_identifiers'), 'Should mention search_identifiers')
    assert.ok(out.includes('emit_plan'), 'Should include lean plan output guidance')
    // Should NOT include the full guidance blocks
    assert.ok(!out.includes('## Code Graph'), 'Should NOT include full Code Graph guidance')
    assert.ok(
      !out.includes('## Semantic Search'),
      'Should NOT include full Semantic Search guidance'
    )
  })

  test('turn 2+ is no-op for lean models', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      2,
      {
        repomapEnabled: true,
        semanticSearchEnabled: true,
        githubConfigured: true
      },
      'claude-opus-4-8'
    )
    assert.equal(out, 'BASE')
  })

  test('turn 2+ is no-op when repomap disabled', () => {
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: false,
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
    assert.ok(allOff.includes('## Git Context'), 'Git context guidance should be appended')
    assert.ok(allOff.includes('## Checkpoint Tools'), 'Checkpoint guidance should be appended')
    // Repomap / Semantic / GitHub require flags.
    assert.ok(!allOff.includes('## Code Graph'), 'Code Graph should not be appended when disabled')
    assert.ok(
      !allOff.includes('## Semantic Search'),
      'Semantic Search should not be appended when disabled'
    )
    assert.ok(!allOff.includes('## GitHub Tools'), 'GitHub should not be appended when disabled')

    const allOn = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: true
    })
    assert.ok(allOn.includes('## Code Graph'), 'Code Graph should be appended when enabled')
    assert.ok(
      allOn.includes('## Semantic Search'),
      'Semantic Search should be appended when enabled'
    )
    assert.ok(allOn.includes('## GitHub Tools'), 'GitHub should be appended when enabled')
  })

  test('lean mode injects compressed REPOMAP_GUIDANCE when base lacks ## Code Exploration', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: true,
        semanticSearchEnabled: true,
        githubConfigured: false
      },
      'claude-opus-4-8'
    )
    // Specialist/evaluation adapters have no ## Code Exploration — they get the lean guidance.
    assert.ok(
      out.includes('## Code Graph'),
      'Lean non-DaVinci should get compressed Code Graph guidance'
    )
    // But semantic search should still be present
    assert.ok(out.includes('## Semantic Search'), 'Semantic search should still be injected')
  })

  test('lean mode skips REPOMAP_GUIDANCE when base already has ## Code Exploration (DaVinci)', () => {
    const out = appendMcpToolGuidance(
      'BASE\n\n## Code Exploration\nbuilt-in',
      1,
      {
        repomapEnabled: true,
        semanticSearchEnabled: false,
        githubConfigured: false
      },
      'claude-opus-4-8'
    )
    // DaVinci lean identity already covers Code Graph rules — avoid duplication.
    assert.ok(
      !out.includes('## Code Graph'),
      'DaVinci lean should not duplicate Code Graph guidance'
    )
  })

  test('full mode includes REPOMAP_GUIDANCE on turn 1', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: true,
        semanticSearchEnabled: false,
        githubConfigured: false
      },
      'claude-sonnet-4-6'
    )
    assert.ok(out.includes('## Code Graph'), 'Full mode should include REPOMAP_GUIDANCE')
  })

  test('lean mode uses compressed Maestro guidance', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        externalMcpActive: { maestro: true }
      },
      'claude-opus-4-8'
    )
    assert.ok(out.includes('## Maestro'), 'Should include Maestro guidance')
    // Lean Maestro is shorter — no ### subsections
    assert.ok(!out.includes('### Workflow'), 'Lean Maestro should not have ### Workflow subsection')
    assert.ok(out.includes('list_devices'), 'Lean Maestro should mention list_devices')
  })

  test('full mode uses verbose Maestro guidance', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        externalMcpActive: { maestro: true }
      },
      'claude-sonnet-4-6'
    )
    assert.ok(out.includes('### Workflow'), 'Full mode should have ### Workflow subsection')
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
    assert.ok(!out.includes('Reminder: Use the emit_plan tool'), 'Should NOT get plan reminder')
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
    assert.ok(
      out.includes('emit_plan'),
      'Long messages should not be classified as simple questions'
    )
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

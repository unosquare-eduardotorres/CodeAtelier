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
  test('plan-mode always adds emit_plan reminder', () => {
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

/**
 * Unit tests for prompt-assembly-helpers.
 *
 * Verifies that both stateless helpers emit the expected content AND do NOT
 * leak any stale handoff/delegation vocabulary (per the unification plan).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  appendMcpToolGuidance,
  buildConditionalPrefix,
  buildModeContextPrefix
} from '../prompt-assembly-helpers'

describe('appendMcpToolGuidance', () => {
  test('turn 2+ appends compact tool priority reminder for non-lean models with repomap', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      2,
      {
        repomapEnabled: true,
        semanticSearchEnabled: true,
        githubConfigured: true
      },
      'claude-haiku-4-5-20251001'
    )
    assert.ok(out.includes('Tool Priority'), 'Should include compact tool priority reminder')
    assert.ok(out.includes('search_identifiers'), 'Should mention search_identifiers')
    // emit_plan guidance removed — mode-context already carries the full emit_plan workflow
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

  test('turn 2+ still reminds when only semantic search is enabled', () => {
    // Regression: the gate used to read repomapEnabled alone, so a
    // semantic-search-only workspace got no tool-priority reminder at all.
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: false,
      semanticSearchEnabled: true,
      githubConfigured: true
    })
    assert.ok(out.includes('## Tool Priority'), 'semantic-search-only must still get the reminder')
  })

  test('turn 2+ is no-op when both code intelligence features are disabled', () => {
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      githubConfigured: true
    })
    assert.equal(out, 'BASE')
  })

  test('turn 2+ reminder is a routing table with an escape hatch', () => {
    const out = appendMcpToolGuidance('BASE', 2, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false
    })
    assert.ok(out.includes('| Question shape | First tool | Fallback |'), 'routing table header')
    assert.ok(
      out.includes('Skip all of the above when the answer is already in context'),
      'escape hatch keeps the table credible — without it the model discounts the block'
    )
  })

  test('appends only flagged blocks on turn 1', () => {
    const allOff = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      githubConfigured: false
    })
    // Git always mounts.
    assert.ok(allOff.includes('## Git Context'), 'Git context guidance should be appended')
    // Repomap / Semantic require flags.
    assert.ok(!allOff.includes('## Code Graph'), 'Code Graph should not be appended when disabled')
    assert.ok(
      !allOff.includes('## Semantic Search'),
      'Semantic Search should not be appended when disabled'
    )

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
  })

  test('enabled-but-unindexed swaps in the unindexed note, not the full guidance', () => {
    const out = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      repomapIndexed: false,
      semanticSearchIndexed: false,
      githubConfigured: false
    })
    // Tools stay mounted, so the block must still appear — silence invites blind calls.
    assert.ok(out.includes('## Code Graph'), 'Code Graph header still present')
    assert.ok(out.includes('## Semantic Search'), 'Semantic Search header still present')
    assert.ok(out.includes('no index yet'), 'Code Graph unindexed note')
    assert.ok(out.includes('no embedding index yet'), 'Semantic Search unindexed note')
    assert.ok(
      !out.includes('Typical chain:'),
      'full semantic-search routing guidance must be replaced, not appended'
    )
  })

  test('unknown index state is treated as indexed (fail open)', () => {
    const out = appendMcpToolGuidance('BASE', 1, {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false
    })
    assert.ok(out.includes('Typical chain:'), 'undefined index state keeps the full guidance')
    assert.ok(!out.includes('no index yet'), 'must not claim the workspace is unindexed')
  })

  test('unindexed note wins over the lean variant', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: false,
        semanticSearchEnabled: true,
        semanticSearchIndexed: false,
        githubConfigured: false
      },
      'claude-opus-4-8'
    )
    assert.ok(out.includes('no embedding index yet'), 'lean models still need the index warning')
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
      'Lean non-specialist should get compressed Code Graph guidance'
    )
    // But semantic search should still be present
    assert.ok(out.includes('## Semantic Search'), 'Semantic search should still be injected')
  })

  test('lean mode skips REPOMAP_GUIDANCE when base already has ## Code Exploration (specialist)', () => {
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
    // Specialist lean identity already covers Code Graph rules — avoid duplication.
    assert.ok(
      !out.includes('## Code Graph'),
      'Specialist lean should not duplicate Code Graph guidance'
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
      'claude-haiku-4-5-20251001'
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

  test('full mode uses Maestro guidance (now same as lean)', () => {
    const out = appendMcpToolGuidance(
      'BASE',
      1,
      {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        externalMcpActive: { maestro: true }
      },
      'claude-haiku-4-5-20251001'
    )
    assert.ok(out.includes('## Maestro'), 'Full mode should include Maestro guidance')
    assert.ok(out.includes('list_devices'), 'Full Maestro should mention list_devices')
  })

  test('Jira guidance follows the jira integration toggle', () => {
    const flags = {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      githubConfigured: false
    }
    const on = appendMcpToolGuidance('BASE', 1, {
      ...flags,
      externalMcpActive: { jira: true }
    })
    assert.ok(on.includes('## Jira'), 'an active Jira integration should carry its guidance')
    assert.ok(on.includes('mcp__jira__add_comment'))

    // The tools are not mounted, so describing them would invent a capability.
    const off = appendMcpToolGuidance('BASE', 1, { ...flags, externalMcpActive: { jira: false } })
    assert.ok(!off.includes('## Jira'))
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

describe('buildModeContextPrefix', () => {
  test('turn 1 includes full Mermaid diagram reference in plan mode', () => {
    const out = buildModeContextPrefix('plan', undefined, 1)
    assert.ok(out.includes('<mode-context>'), 'Should wrap in mode-context tags')
    assert.ok(out.includes('classDef decision'), 'Should include full Mermaid classDef block')
    assert.ok(out.includes('Icon reference:'), 'Should include icon reference')
    assert.ok(out.includes('lucide:bot'), 'Should include example icons')
  })

  test('turn 2+ strips Mermaid diagram reference in plan mode', () => {
    const out = buildModeContextPrefix('plan', undefined, 3, 'just a follow-up question')
    assert.ok(out.includes('<mode-context>'), 'Should wrap in mode-context tags')
    assert.ok(!out.includes('classDef decision'), 'Should NOT include full Mermaid classDef block')
    assert.ok(!out.includes('Icon reference:'), 'Should NOT include icon reference')
    assert.ok(
      out.includes('See diagram reference from turn 1'),
      'Should include compact diagram back-reference'
    )
  })

  test('turn 2+ re-injects Mermaid when user message contains diagram keywords', () => {
    const keywords = ['create a diagram', 'add a mermaid chart', 'draw a flowchart', 'stateDiagram']
    for (const msg of keywords) {
      const out = buildModeContextPrefix('plan', undefined, 5, msg)
      assert.ok(
        out.includes('classDef decision'),
        `Diagram keyword "${msg}" should trigger full diagram block re-injection`
      )
    }
  })

  test('turn 2+ in build mode does NOT use compact (build has no diagram block)', () => {
    const out = buildModeContextPrefix('build', undefined, 3, 'implement the feature')
    assert.ok(out.includes('Mode: Build'), 'Should include build mode section')
    // Build mode never had a diagram block, so compact is irrelevant
    assert.ok(!out.includes('See diagram reference'), 'Build mode should not have diagram back-ref')
  })

  test('lean plan mode turn 2+ also strips Mermaid', () => {
    const out = buildModeContextPrefix('plan', 'claude-opus-4-8', 2, 'continue please')
    assert.ok(!out.includes('classDef decision'), 'Lean plan turn 2+ should strip diagram block')
    assert.ok(
      out.includes('See diagram reference from turn 1'),
      'Should include compact back-reference'
    )
  })

  test('unknown turnCount defaults to full mode context', () => {
    const out = buildModeContextPrefix('plan')
    assert.ok(out.includes('classDef decision'), 'Should include full diagram block by default')
  })

  test('all modes always wrapped in mode-context tags', () => {
    for (const mode of ['plan', 'build', 'danger'] as const) {
      const out = buildModeContextPrefix(mode, undefined, 1)
      assert.ok(out.startsWith('<mode-context>'), `${mode} should start with mode-context tag`)
      assert.ok(out.endsWith('</mode-context>'), `${mode} should end with mode-context tag`)
    }
  })
})

describe('buildConditionalPrefix — memory protocol re-emission', () => {
  // Message must hit the memory-protocol heuristic ("remember", "prefer", …).
  const MEMORY_MSG = 'Please remember that I prefer tabs over spaces'

  test('memory protocol is present on turn 1', () => {
    const out = buildConditionalPrefix({
      message: MEMORY_MSG,
      hasImages: false,
      mode: 'build',
      turnCount: 1
    })
    assert.ok(out.includes('memory_record'), 'turn 1 carries the memory protocol')
  })

  test('memory protocol is dropped on turn 2+ without compaction', () => {
    const out = buildConditionalPrefix({
      message: MEMORY_MSG,
      hasImages: false,
      mode: 'build',
      turnCount: 5
    })
    assert.ok(!out.includes('memory_record'), 'already in history — not repeated')
  })

  test('memory protocol is re-emitted on a compaction turn', () => {
    const out = buildConditionalPrefix({
      message: MEMORY_MSG,
      hasImages: false,
      mode: 'build',
      turnCount: 5,
      postCompaction: true
    })
    assert.ok(
      out.includes('memory_record'),
      'compaction discards the turn-1 copy, so it must be re-sent'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

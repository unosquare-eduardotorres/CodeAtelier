/**
 * Tests for extracted grill prompt builder functions.
 *
 * Validates:
 * - buildWorkspaceGrillPrompt: workspace grill system prompt assembly
 * - buildGreenfieldGrillPrompt: greenfield grill system prompt assembly
 *
 * Both are pure string assembly — no I/O, no DB, no mocks needed.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildWorkspaceGrillPrompt,
  buildGreenfieldGrillPrompt
} from '../role-adapters/grill-prompt-builders'
import { GRILL_TRACKS } from '../../../shared/constants'

// ── Fixtures ──

const requirementsTrack = GRILL_TRACKS['requirements']
const architectureTrack = GRILL_TRACKS['architecture']

function wsParams(overrides: Record<string, unknown> = {}) {
  return {
    track: requirementsTrack,
    trackId: 'requirements' as const,
    ideaTitle: 'Build a payment gateway',
    ideaDescription: 'Integration with Stripe for recurring billing.',
    ...overrides
  }
}

function gfParams(overrides: Record<string, unknown> = {}) {
  return {
    track: requirementsTrack,
    trackId: 'requirements' as const,
    projectName: 'TaskFlow Pro',
    projectDescription: 'A project management tool for remote teams.',
    ...overrides
  }
}

// ── buildWorkspaceGrillPrompt — full (non-lean) mode ──

describe('buildWorkspaceGrillPrompt — full mode', () => {
  test('contains "Grill Analyst" role preamble', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('You are a Grill Analyst'), 'missing role preamble')
  })

  test('contains track name in task description', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('**Requirements** track'), 'missing track name')
  })

  test('contains scoring focus criteria from track', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    for (const focus of requirementsTrack.scoringFocus) {
      assert.ok(result.includes(focus), `missing scoring focus: ${focus}`)
    }
  })

  test('contains sanitized idea title and description', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('Build a payment gateway'), 'missing idea title')
    assert.ok(result.includes('Integration with Stripe'), 'missing idea description')
  })

  test('uses full evaluation schema (grill-evaluation JSON block)', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('```grill-evaluation'), 'missing grill-evaluation code fence')
    assert.ok(result.includes('"trackId": "requirements"'), 'missing trackId in schema')
  })

  test('uses full instructions with tool guidance', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('**Narrate your process.**'), 'missing full narration instruction')
    assert.ok(
      result.includes('Code Graph, Code Analysis') || result.includes('Code Graph'),
      'missing tool guidance'
    )
  })

  test('uses full question quality rules', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('## Question Quality Rules'), 'missing full question rules heading')
    assert.ok(result.includes('EDGE CASES or FAILURE MODES'), 'missing edge case rule')
  })

  test('uses full scoring rules', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(result.includes('## Rules'), 'missing rules heading')
    assert.ok(result.includes('Perfectly Grilled'), 'missing score band')
  })
})

// ── buildWorkspaceGrillPrompt — lean mode ──

describe('buildWorkspaceGrillPrompt — lean mode', () => {
  const leanModel = 'claude-opus-4-8'

  test('uses lean evaluation schema (no JSON block)', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ model: leanModel }))
    assert.ok(
      !result.includes('```grill-evaluation'),
      'should not have full grill-evaluation fence'
    )
    assert.ok(result.includes('Emit one `grill-evaluation` JSON block'), 'missing lean schema')
  })

  test('uses compressed instructions', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ model: leanModel }))
    assert.ok(
      result.includes('Narrate your process —') || result.includes('Narrate your process —'),
      'missing lean narration'
    )
    assert.ok(
      !result.includes('**Narrate your process.**'),
      'should not have full instruction style'
    )
  })

  test('uses lean question quality rules', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ model: leanModel }))
    assert.ok(result.includes('## Question Quality'), 'missing lean question quality heading')
    assert.ok(!result.includes('## Question Quality Rules'), 'should not have full heading')
  })

  test('uses lean scoring rules', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ model: leanModel }))
    assert.ok(result.includes('Score bands:'), 'missing lean score bands')
  })
})

// ── buildWorkspaceGrillPrompt — re-evaluation context ──

describe('buildWorkspaceGrillPrompt — re-evaluation', () => {
  test('no previousScore → no re-eval block', () => {
    const result = buildWorkspaceGrillPrompt(wsParams())
    assert.ok(!result.includes('## Re-evaluation Context'), 'should not have re-eval block')
  })

  test('previousScore = 72 → re-eval block with score', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ previousScore: 72 }))
    assert.ok(result.includes('## Re-evaluation Context'), 'missing re-eval heading')
    assert.ok(result.includes('72/100'), 'missing score value')
  })

  test('previousScore = 0 → re-eval block with zero', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ previousScore: 0 }))
    assert.ok(result.includes('0/100'), 'missing zero score')
  })
})

// ── buildWorkspaceGrillPrompt — input sanitization ──

describe('buildWorkspaceGrillPrompt — sanitization', () => {
  test('handles empty description → "No description provided."', () => {
    const result = buildWorkspaceGrillPrompt(wsParams({ ideaDescription: '' }))
    assert.ok(result.includes('No description provided.'), 'missing fallback description')
  })

  test('different track interpolation (architecture)', () => {
    const result = buildWorkspaceGrillPrompt(
      wsParams({ track: architectureTrack, trackId: 'architecture' })
    )
    assert.ok(result.includes('**Architecture** track'), 'missing architecture track name')
    assert.ok(result.includes('Module boundaries'), 'missing architecture scoring focus')
  })
})

// ── buildGreenfieldGrillPrompt — full mode ──

describe('buildGreenfieldGrillPrompt — full mode', () => {
  test('contains "NEW project idea" preamble', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('for a NEW project idea'), 'missing greenfield preamble')
  })

  test('contains context section about no codebase', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('There is no code to analyze yet'), 'missing no-code context')
  })

  test('contains track name in task', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('**Requirements** track'), 'missing track name')
  })

  test('contains project name and description', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('TaskFlow Pro'), 'missing project name')
    assert.ok(result.includes('project management tool'), 'missing project description')
  })

  test('uses full evaluation schema', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('```grill-evaluation'), 'missing grill-evaluation fence')
  })

  test('includes GREENFIELD_EXTRA rule in full mode', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(result.includes('DESIGN CHOICES'), 'missing greenfield extra rule')
  })

  test('uses narrate reasoning instruction (not narrate process)', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(
      result.includes('**Narrate your reasoning.**'),
      'missing greenfield reasoning instruction'
    )
  })

  test('does NOT contain Code Graph tool instructions', () => {
    const result = buildGreenfieldGrillPrompt(gfParams())
    assert.ok(
      !result.includes('Code Graph + Code Analysis tools FIRST'),
      'should not have workspace tool instructions'
    )
  })
})

// ── buildGreenfieldGrillPrompt — lean mode ──

describe('buildGreenfieldGrillPrompt — lean mode', () => {
  const leanModel = 'claude-opus-4-8'

  test('uses lean schema', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ model: leanModel }))
    assert.ok(!result.includes('```grill-evaluation'), 'should not have full fence')
    assert.ok(result.includes('Emit one `grill-evaluation` JSON block'), 'missing lean schema')
  })

  test('uses lean question quality rules', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ model: leanModel }))
    assert.ok(result.includes('## Question Quality'), 'missing lean heading')
    // In lean mode, greenfield extra rule should NOT be appended
    assert.ok(!result.includes('DESIGN CHOICES'), 'lean should not have greenfield extra')
  })

  test('uses lean scoring rules', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ model: leanModel }))
    assert.ok(result.includes('Score bands:'), 'missing lean score bands')
  })

  test('still contains greenfield context block', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ model: leanModel }))
    assert.ok(result.includes('There is no code to analyze yet'), 'missing context even in lean')
  })
})

// ── buildGreenfieldGrillPrompt — re-evaluation + edge cases ──

describe('buildGreenfieldGrillPrompt — re-evaluation + edge cases', () => {
  test('previousScore = 45 → re-eval block', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ previousScore: 45 }))
    assert.ok(result.includes('45/100'), 'missing score in re-eval')
    assert.ok(result.includes('ANCHOR your new score'), 'missing anchor instruction')
  })

  test('empty description → "No description provided."', () => {
    const result = buildGreenfieldGrillPrompt(gfParams({ projectDescription: '' }))
    assert.ok(result.includes('No description provided.'), 'missing fallback')
  })

  test('architecture track → correct scoring focus', () => {
    const result = buildGreenfieldGrillPrompt(
      gfParams({ track: architectureTrack, trackId: 'architecture' })
    )
    assert.ok(result.includes('**Architecture** track'), 'wrong track name')
    assert.ok(result.includes('API/IPC channel design'), 'missing arch focus')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Unit tests for the Project Specialist prompt template.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { PROMPT_SLOTS, renderTemplate } from '../project-specialist-prompt-template'

describe('project-specialist-prompt-template', () => {
  test('exports_all_expected_slots', () => {
    // Trimmed in v3 from 3 → 2: stackSummary removed because CLAUDE.md
    // is injected at runtime — the skeleton no longer needs tech names.
    const expected = ['workspaceName', 'enabledSkills']
    assert.equal(PROMPT_SLOTS.length, expected.length)
    for (const slot of expected) {
      assert.ok(PROMPT_SLOTS.includes(slot as never), `expected slot ${slot}`)
    }
  })

  test('renderTemplate_substitutes_known_slots', () => {
    const out = renderTemplate({
      workspaceName: 'Acme',
      enabledSkills: 'ui-ux-pro-max'
    })
    assert.ok(out.includes('Acme Specialist'))
    assert.ok(out.includes('ui-ux-pro-max'))
  })

  test('renderTemplate_missing_slots_become_empty_strings', () => {
    const out = renderTemplate({ workspaceName: 'Acme' })
    assert.ok(!out.includes('{{'))
    assert.ok(!out.includes('}}'))
    assert.ok(out.includes('Acme Specialist'))
  })

  test('renderTemplate_unknown_tokens_are_stripped', () => {
    // Not testing an injection vector, just verifying the template itself
    // doesn't contain unknown {{tokens}} after render.
    const out = renderTemplate({})
    assert.equal(out.match(/\{\{[a-zA-Z]+\}\}/g), null)
  })

  test('rendered_prompt_contains_identity_framing', () => {
    // Mode framing (Plan / Build) is appended at runtime by the adapter via
    // PLAN_MODE_SECTION / BUILD_MODE_SECTION, not baked into the template.
    // The template is just role identity + skills slot.
    const out = renderTemplate({ workspaceName: 'Acme' })
    assert.ok(out.includes('Acme Specialist'))
    assert.ok(out.toLowerCase().includes('your identity'))
    assert.ok(out.toLowerCase().includes('sole implementer'))
  })

  test('rendered_skeleton_does_not_duplicate_CLAUDE_md_sections', () => {
    // The trimmed template must NOT carry sections that live in CLAUDE.md and
    // are now injected at runtime by the adapter — otherwise we'd duplicate
    // them on every turn.
    const out = renderTemplate({
      workspaceName: 'Acme',
      enabledSkills: 'general-dev'
    })
    assert.ok(
      !/##\s+Project Structure/i.test(out),
      'skeleton must not declare a Project Structure section'
    )
    assert.ok(
      !/##\s+Common commands/i.test(out),
      'skeleton must not declare a Common commands section'
    )
    assert.ok(
      !/##\s+Anti-patterns/i.test(out),
      'skeleton must not declare an Anti-patterns section'
    )
    assert.ok(
      !/##\s+Tech.stack stance/i.test(out),
      'skeleton must not declare a Tech-stack stance section'
    )
  })

  test('rendered_skeleton_contains_judgment_sections', () => {
    const out = renderTemplate({ workspaceName: 'Acme' })
    assert.ok(out.toLowerCase().includes('decision heuristics'), 'must have Decision heuristics')
    assert.ok(
      out.toLowerCase().includes('architecture instincts'),
      'must have Architecture instincts'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

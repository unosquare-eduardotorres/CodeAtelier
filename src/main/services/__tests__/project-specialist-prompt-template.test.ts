/**
 * Unit tests for the Project Specialist prompt template.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  PROMPT_SLOTS,
  renderTemplate
} from '../project-specialist-prompt-template'

describe('project-specialist-prompt-template', () => {
  test('exports_all_expected_slots', () => {
    for (const expected of [
      'workspaceName',
      'stackSummary',
      'claudeMdDigest',
      'enabledSkills',
      'commonCommands',
      'antiPatterns'
    ]) {
      assert.ok(PROMPT_SLOTS.includes(expected as never))
    }
  })

  test('renderTemplate_substitutes_known_slots', () => {
    const out = renderTemplate({
      workspaceName: 'Acme',
      stackSummary: 'react + typescript',
      claudeMdDigest: 'use 2-space indent',
      enabledSkills: 'ui-ux-pro-max',
      commonCommands: 'npm run dev',
      antiPatterns: 'no any types'
    })

    assert.ok(out.includes('Acme Specialist'))
    assert.ok(out.includes('react + typescript'))
    assert.ok(out.includes('use 2-space indent'))
    assert.ok(out.includes('ui-ux-pro-max'))
    assert.ok(out.includes('npm run dev'))
    assert.ok(out.includes('no any types'))
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

  test('rendered_prompt_contains_operating_modes_framing', () => {
    const out = renderTemplate({})
    assert.ok(out.toLowerCase().includes('plan mode'))
    assert.ok(out.toLowerCase().includes('build mode'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

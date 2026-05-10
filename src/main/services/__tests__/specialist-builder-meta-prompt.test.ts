/**
 * Regression guard for the SpecialistBuilder meta-prompt.
 *
 * After the v2 rewrite, the meta-prompt sent to `claude -p` must be a
 * "distill, don't enrich" persona builder — first-person, under 400 words,
 * with explicit DETECTED STACK, REFERENCE-only CLAUDE.md, and a HARD RULES
 * block. This test pins those requirements so the prompt can't silently
 * drift back to the old "Enriches the project-specific sections" wording.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SpecialistBuilderService } from '../specialist-builder.service'

describe('SpecialistBuilder meta-prompt', () => {
  const builder = new SpecialistBuilderService()
  const sample = builder.buildMetaPrompt({
    workspaceName: 'Acme',
    detectedTechs: ['react', 'typescript'],
    claudeMdReference: '# Project: Acme\n\nReference content here.',
    skeleton:
      'You are the **Acme Specialist** — a senior engineer embedded in this codebase.\n\n## Your identity\n…'
  })

  test('contains_distillation_directives', () => {
    assert.ok(
      sample.includes('DO NOT quote'),
      'meta-prompt must instruct the LLM not to quote the reference'
    )
    assert.ok(
      sample.includes('FIRST PERSON'),
      'meta-prompt must require FIRST PERSON identity wording'
    )
    assert.ok(sample.includes('Under 400 words'), 'meta-prompt must impose the 400-word cap')
    assert.ok(sample.includes('HARD RULES'), 'meta-prompt must include the HARD RULES block')
    assert.ok(
      sample.includes('DETECTED STACK'),
      'meta-prompt must surface the detected stack to the LLM'
    )
    assert.ok(
      sample.includes('REFERENCE'),
      'meta-prompt must label the CLAUDE.md excerpt as REFERENCE'
    )
  })

  test('rejects_legacy_enriches_vocabulary', () => {
    // The previous meta-prompt told the LLM to "Enrich the project-specific sections" —
    // that wording produced bloated, structure-mirroring outputs and is now banned.
    assert.ok(
      !/Enriches the project-specific sections/i.test(sample),
      'legacy "Enriches the project-specific sections" wording must be gone'
    )
    assert.ok(
      !/SKELETON prompt for a workspace/i.test(sample),
      'legacy "SKELETON prompt for a workspace" wording must be gone'
    )
  })

  test('substitutes_workspace_name_and_techs', () => {
    assert.ok(sample.includes('Acme'), 'must include the workspace name')
    assert.ok(sample.includes('react, typescript'), 'must include detected techs joined')
  })

  test('falls_back_to_none_detected_when_techs_empty', () => {
    const empty = builder.buildMetaPrompt({
      workspaceName: 'Acme',
      detectedTechs: [],
      claudeMdReference: '',
      skeleton: 'skeleton'
    })
    assert.ok(
      empty.includes('(none detected)'),
      'must produce "(none detected)" when no techs are detected'
    )
  })

  test('mandatory_section_list_is_in_order', () => {
    // The meta-prompt asks for EXACTLY these sections, in order. Pin them so the
    // shape can't drift without an explicit test update.
    const idxIdentity = sample.indexOf('## Your identity')
    const idxStance = sample.indexOf('## Your tech-stack stance')
    const idxDomain = sample.indexOf('## Domain context')
    const idxOutput = sample.indexOf('## Output style')
    assert.ok(idxIdentity >= 0, 'must mention ## Your identity')
    assert.ok(idxStance > idxIdentity, '## Your tech-stack stance must come after identity')
    assert.ok(idxDomain > idxStance, '## Domain context must come after stance')
    assert.ok(idxOutput > idxDomain, '## Output style must come after domain')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

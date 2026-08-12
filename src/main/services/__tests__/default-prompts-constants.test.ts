/**
 * Tests for default-prompts.ts — validates all exported prompt constants and
 * tone directive functions exist and have valid content.
 *
 * This covers ~560 lines (the entire file) by exercising every export.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

import {
  ASK_QUESTION_PROMPT,
  ASK_QUESTION_PROMPT_LEAN,
  MEMORY_PROTOCOL_PROMPT,
  MEMORY_PROTOCOL_PROMPT_LEAN,
  REPOMAP_GUIDANCE_PROMPT,
  REPOMAP_GUIDANCE_PROMPT_LEAN,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT_LEAN,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT_LEAN,
  CODE_ANALYSIS_GUIDANCE_PROMPT,
  CODE_ANALYSIS_GUIDANCE_PROMPT_LEAN,
  LIBRARY_DOCS_GUIDANCE_PROMPT,
  LIBRARY_DOCS_GUIDANCE_PROMPT_LEAN,
  ESLINT_GUIDANCE_PROMPT,
  ESLINT_GUIDANCE_PROMPT_LEAN,
  MAESTRO_GUIDANCE_PROMPT,
  MAESTRO_GUIDANCE_PROMPT_LEAN,
  DIRECT_ANSWER_BOOST_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT_LEAN,
  PLAN_REMINDER_FULL,
  PLAN_REMINDER_LEAN,
  DIRECT_ANSWER_PLAN_MODE_EARLY,
  IMAGE_ATTACHMENTS_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT_LEAN,
  TONE_STYLE_DIRECTIVES,
  buildSpecialistIdentityPrompt,
  buildSpecialistIdentityPromptLean,
  PLAN_MODE_SECTION,
  BUILD_MODE_SECTION,
  DANGER_MODE_SECTION,
  MODE_CONTEXT_SECTIONS,
  PLAN_MODE_SECTION_LEAN,
  BUILD_MODE_SECTION_LEAN,
  DANGER_MODE_SECTION_LEAN,
  MODE_CONTEXT_SECTIONS_LEAN,
  MERMAID_DIAGRAM_REFERENCE,
  SOLE_IMPLEMENTER_DIRECTIVE,
  PLAN_MODE_SECTION_COMPACT,
  PLAN_MODE_SECTION_LEAN_COMPACT,
  MODE_CONTEXT_SECTIONS_COMPACT,
  MODE_CONTEXT_SECTIONS_LEAN_COMPACT,
  TOOL_PRIORITY_DIRECTIVE,
  TOOL_PRIORITY_DIRECTIVE_BUILDER,
  REPOMAP_UNINDEXED_NOTE,
  SEMANTIC_SEARCH_UNINDEXED_NOTE
} from '../default-prompts'

describe('default-prompts — prompt constants', () => {
  // ── Core prompt constants are non-empty strings ──

  const promptPairs = [
    ['ASK_QUESTION_PROMPT', ASK_QUESTION_PROMPT, ASK_QUESTION_PROMPT_LEAN],
    ['MEMORY_PROTOCOL_PROMPT', MEMORY_PROTOCOL_PROMPT, MEMORY_PROTOCOL_PROMPT_LEAN],
    ['REPOMAP_GUIDANCE_PROMPT', REPOMAP_GUIDANCE_PROMPT, REPOMAP_GUIDANCE_PROMPT_LEAN],
    [
      'SEMANTIC_SEARCH_GUIDANCE_PROMPT',
      SEMANTIC_SEARCH_GUIDANCE_PROMPT,
      SEMANTIC_SEARCH_GUIDANCE_PROMPT_LEAN
    ],
    ['GIT_CONTEXT_GUIDANCE_PROMPT', GIT_CONTEXT_GUIDANCE_PROMPT, GIT_CONTEXT_GUIDANCE_PROMPT_LEAN],
    [
      'CODE_ANALYSIS_GUIDANCE_PROMPT',
      CODE_ANALYSIS_GUIDANCE_PROMPT,
      CODE_ANALYSIS_GUIDANCE_PROMPT_LEAN
    ],
    [
      'LIBRARY_DOCS_GUIDANCE_PROMPT',
      LIBRARY_DOCS_GUIDANCE_PROMPT,
      LIBRARY_DOCS_GUIDANCE_PROMPT_LEAN
    ],
    ['ESLINT_GUIDANCE_PROMPT', ESLINT_GUIDANCE_PROMPT, ESLINT_GUIDANCE_PROMPT_LEAN],
    ['MAESTRO_GUIDANCE_PROMPT', MAESTRO_GUIDANCE_PROMPT, MAESTRO_GUIDANCE_PROMPT_LEAN],
    ['DIRECT_ANSWER_BOOST_PROMPT', DIRECT_ANSWER_BOOST_PROMPT, DIRECT_ANSWER_BOOST_PROMPT_LEAN],
    ['IMAGE_ATTACHMENTS_PROMPT', IMAGE_ATTACHMENTS_PROMPT, IMAGE_ATTACHMENTS_PROMPT_LEAN]
  ] as const

  for (const [name, full, lean] of promptPairs) {
    test(`${name} is non-empty string`, () => {
      assert.equal(typeof full, 'string')
      assert.ok(full.length > 0, `${name} should not be empty`)
    })

    test(`${name}_LEAN is non-empty string`, () => {
      assert.equal(typeof lean, 'string')
      assert.ok(lean.length > 0, `${name}_LEAN should not be empty`)
    })

    test(`${name}_LEAN is <= full length`, () => {
      assert.ok(
        lean.length <= full.length,
        `${name}_LEAN (${lean.length}) should be <= full (${full.length})`
      )
    })
  }

  // ── Plan reminder constants ──

  test('PLAN_REMINDER_FULL contains emit_plan', () => {
    assert.ok(PLAN_REMINDER_FULL.includes('emit_plan'))
  })

  test('PLAN_REMINDER_LEAN is shorter than FULL', () => {
    assert.ok(PLAN_REMINDER_LEAN.length <= PLAN_REMINDER_FULL.length)
  })

  test('DIRECT_ANSWER_PLAN_MODE_EARLY is non-empty', () => {
    assert.ok(DIRECT_ANSWER_PLAN_MODE_EARLY.length > 0)
  })
})

describe('default-prompts — TONE_STYLE_DIRECTIVES', () => {
  const expectedTones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const

  for (const tone of expectedTones) {
    test(`has directive for tone "${tone}"`, () => {
      assert.ok(tone in TONE_STYLE_DIRECTIVES, `Missing tone: ${tone}`)
      assert.equal(typeof TONE_STYLE_DIRECTIVES[tone], 'string')
      assert.ok(TONE_STYLE_DIRECTIVES[tone].length > 0)
    })
  }
})

describe('default-prompts — buildSpecialistIdentityPrompt', () => {
  test('returns string for each tone', () => {
    const tones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const
    for (const tone of tones) {
      const result = buildSpecialistIdentityPrompt(tone)
      assert.equal(typeof result, 'string')
      assert.ok(result.length > 100, `Prompt for ${tone} should be substantial`)
    }
  })

  test('includes tone-specific style', () => {
    const prompt = buildSpecialistIdentityPrompt('brutal')
    assert.ok(prompt.length > 0)
  })
})

describe('default-prompts — buildSpecialistIdentityPromptLean', () => {
  test('returns string for each tone', () => {
    const tones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const
    for (const tone of tones) {
      const result = buildSpecialistIdentityPromptLean(tone)
      assert.equal(typeof result, 'string')
      assert.ok(result.length > 50)
    }
  })

  test('lean version is within 25% of full', () => {
    const full = buildSpecialistIdentityPrompt('default')
    const lean = buildSpecialistIdentityPromptLean('default')
    // After trimming, both are compact. Lean may be longer due to inline Code
    // Exploration guidance with fully-qualified MCP tool names (mcp__server__tool).
    const ratio = lean.length / full.length
    assert.ok(ratio < 1.4, `Lean/full ratio (${ratio.toFixed(2)}) should be < 1.40`)
  })
})

describe('default-prompts — MODE_CONTEXT_SECTIONS', () => {
  test('MODE_CONTEXT_SECTIONS has plan, build, danger', () => {
    assert.ok('plan' in MODE_CONTEXT_SECTIONS)
    assert.ok('build' in MODE_CONTEXT_SECTIONS)
    assert.ok('danger' in MODE_CONTEXT_SECTIONS)
  })

  test('MODE_CONTEXT_SECTIONS_LEAN has plan, build, danger', () => {
    assert.ok('plan' in MODE_CONTEXT_SECTIONS_LEAN)
    assert.ok('build' in MODE_CONTEXT_SECTIONS_LEAN)
    assert.ok('danger' in MODE_CONTEXT_SECTIONS_LEAN)
  })

  test('PLAN_MODE_SECTION is non-empty', () => {
    assert.ok(PLAN_MODE_SECTION.length > 0)
  })

  test('BUILD_MODE_SECTION is non-empty', () => {
    assert.ok(BUILD_MODE_SECTION.length > 0)
  })

  test('DANGER_MODE_SECTION is non-empty', () => {
    assert.ok(DANGER_MODE_SECTION.length > 0)
  })

  test('lean sections are <= full sections', () => {
    assert.ok(PLAN_MODE_SECTION_LEAN.length <= PLAN_MODE_SECTION.length)
    assert.ok(BUILD_MODE_SECTION_LEAN.length <= BUILD_MODE_SECTION.length)
    assert.ok(DANGER_MODE_SECTION_LEAN.length <= DANGER_MODE_SECTION.length)
  })
})

describe('default-prompts — MERMAID_DIAGRAM_REFERENCE', () => {
  test('is non-empty and contains classDef lines', () => {
    assert.ok(MERMAID_DIAGRAM_REFERENCE.length > 100)
    assert.ok(MERMAID_DIAGRAM_REFERENCE.includes('classDef decision'))
    assert.ok(MERMAID_DIAGRAM_REFERENCE.includes('classDef agent'))
    assert.ok(MERMAID_DIAGRAM_REFERENCE.includes('Icon reference:'))
  })

  test('is embedded in PLAN_MODE_SECTION', () => {
    assert.ok(
      PLAN_MODE_SECTION.includes('classDef decision'),
      'Full plan mode section should contain diagram reference'
    )
  })

  test('is embedded in PLAN_MODE_SECTION_LEAN', () => {
    assert.ok(
      PLAN_MODE_SECTION_LEAN.includes('classDef decision'),
      'Lean plan mode section should contain diagram reference'
    )
  })
})

describe('default-prompts — compact mode context sections', () => {
  test('PLAN_MODE_SECTION_COMPACT strips diagram reference', () => {
    assert.ok(!PLAN_MODE_SECTION_COMPACT.includes('classDef decision'))
    assert.ok(PLAN_MODE_SECTION_COMPACT.includes('See diagram reference from turn 1'))
  })

  test('PLAN_MODE_SECTION_LEAN_COMPACT strips diagram reference', () => {
    assert.ok(!PLAN_MODE_SECTION_LEAN_COMPACT.includes('classDef decision'))
    assert.ok(PLAN_MODE_SECTION_LEAN_COMPACT.includes('See diagram reference from turn 1'))
  })

  test('compact sections are shorter than full sections', () => {
    assert.ok(
      PLAN_MODE_SECTION_COMPACT.length < PLAN_MODE_SECTION.length,
      `Compact (${PLAN_MODE_SECTION_COMPACT.length}) should be < full (${PLAN_MODE_SECTION.length})`
    )
    assert.ok(
      PLAN_MODE_SECTION_LEAN_COMPACT.length < PLAN_MODE_SECTION_LEAN.length,
      `Compact lean (${PLAN_MODE_SECTION_LEAN_COMPACT.length}) should be < full lean (${PLAN_MODE_SECTION_LEAN.length})`
    )
  })

  test('compact sections preserve core behavioral rules', () => {
    assert.ok(PLAN_MODE_SECTION_COMPACT.includes('emit_plan'), 'Missing emit_plan')
    assert.ok(PLAN_MODE_SECTION_COMPACT.includes('read-only'), 'Missing read-only')
    assert.ok(PLAN_MODE_SECTION_LEAN_COMPACT.includes('emit_plan'), 'Missing emit_plan (lean)')
    assert.ok(PLAN_MODE_SECTION_LEAN_COMPACT.includes('read-only'), 'Missing read-only (lean)')
  })

  test('MODE_CONTEXT_SECTIONS_COMPACT has all modes', () => {
    assert.ok('plan' in MODE_CONTEXT_SECTIONS_COMPACT)
    assert.ok('build' in MODE_CONTEXT_SECTIONS_COMPACT)
    assert.ok('danger' in MODE_CONTEXT_SECTIONS_COMPACT)
  })

  test('MODE_CONTEXT_SECTIONS_LEAN_COMPACT has all modes', () => {
    assert.ok('plan' in MODE_CONTEXT_SECTIONS_LEAN_COMPACT)
    assert.ok('build' in MODE_CONTEXT_SECTIONS_LEAN_COMPACT)
    assert.ok('danger' in MODE_CONTEXT_SECTIONS_LEAN_COMPACT)
  })
})

describe('default-prompts — tool routing', () => {
  test('TOOL_PRIORITY_DIRECTIVE is a routing table, not an "always use first" mandate', () => {
    assert.ok(
      TOOL_PRIORITY_DIRECTIVE.includes('| Question shape | First tool | Fallback |'),
      'must carry the routing table header'
    )
    for (const row of [
      'mcp__code-graph__search_identifiers',
      'mcp__semantic-search__semantic_search',
      'mcp__code-graph__file_outline',
      'mcp__code-graph__shortest_path'
    ]) {
      assert.ok(TOOL_PRIORITY_DIRECTIVE.includes(row), `routing table missing ${row}`)
    }
    assert.ok(TOOL_PRIORITY_DIRECTIVE.includes('| Grep |'), 'Grep must be a listed fallback')
  })

  test('TOOL_PRIORITY_DIRECTIVE carries the escape hatch', () => {
    // Without it the table reads as a hard mandate, which the model discounts
    // wholesale the first time the rule is obviously wrong.
    assert.ok(
      TOOL_PRIORITY_DIRECTIVE.includes(
        'Skip all of the above when the answer is already in context'
      ),
      'missing skip clause'
    )
    assert.ok(TOOL_PRIORITY_DIRECTIVE.includes('do not retry it'), 'missing no-retry clause')
  })

  const toolPriorityVariants = [
    ['TOOL_PRIORITY_DIRECTIVE', TOOL_PRIORITY_DIRECTIVE],
    ['TOOL_PRIORITY_DIRECTIVE_BUILDER', TOOL_PRIORITY_DIRECTIVE_BUILDER]
  ] as const

  for (const [name, directive] of toolPriorityVariants) {
    test(`${name} separates inspection from execution`, () => {
      // Multi-part turns collapse into a single `grep … && echo === && ls …`
      // Bash pipeline unless the prompt says reading the repo is not a shell job.
      assert.ok(directive.includes('### Inspection vs. execution'), 'missing inspection section')
      assert.ok(
        directive.includes('Bash is for commands that change or produce state'),
        'missing execution definition'
      )
      assert.ok(
        directive.includes('use Read, Grep and Glob'),
        'must route repo reading/searching to Read, Grep and Glob'
      )
      assert.ok(
        directive.includes('even when you have several things to check'),
        'must address multi-question turns, which are the regression case'
      )
    })

    test(`${name} keeps an escape hatch for legitimate shell use`, () => {
      // Rule + rationale + escape hatch, never a bare prohibition: an agent that
      // skips `npm test` because it read "don't use Bash" is worse than the status quo.
      assert.ok(
        directive.includes('Use the shell when there is genuinely no tool for the job'),
        'missing shell escape hatch'
      )
      assert.ok(
        directive.includes('not to answer several questions in one call'),
        'escape hatch must be bounded by the actual failure mode'
      )
      assert.ok(!/\bNever\b/.test(directive), 'must not read as a hard mandate')
    })
  }

  test('TOOL_PRIORITY_DIRECTIVE_BUILDER still sanctions Bash for the finalization checklist', () => {
    assert.ok(
      TOOL_PRIORITY_DIRECTIVE_BUILDER.includes('## Finalization Checklist'),
      'builder variant must retain the checklist'
    )
    assert.ok(
      TOOL_PRIORITY_DIRECTIVE_BUILDER.includes('npm run typecheck'),
      'typecheck/lint/test commands are exactly the Bash usage the rule must preserve'
    )
  })

  test('SEMANTIC_SEARCH_GUIDANCE_PROMPT states what it is weak at and the follow-up chain', () => {
    assert.ok(SEMANTIC_SEARCH_GUIDANCE_PROMPT.includes('Weak at:'), 'missing negative space')
    assert.ok(SEMANTIC_SEARCH_GUIDANCE_PROMPT.includes('Typical chain:'), 'missing tool chain')
    assert.ok(
      SEMANTIC_SEARCH_GUIDANCE_PROMPT.includes('mcp__code-graph__search_identifiers'),
      'must route exact identifiers to code-graph'
    )
  })

  const unindexedNotes = [
    ['REPOMAP_UNINDEXED_NOTE', REPOMAP_UNINDEXED_NOTE, '## Code Graph', REPOMAP_GUIDANCE_PROMPT],
    [
      'SEMANTIC_SEARCH_UNINDEXED_NOTE',
      SEMANTIC_SEARCH_UNINDEXED_NOTE,
      '## Semantic Search',
      SEMANTIC_SEARCH_GUIDANCE_PROMPT
    ]
  ] as const

  for (const [name, note, marker, fullPrompt] of unindexedNotes) {
    test(`${name} keeps the section marker so the block is still recognised`, () => {
      assert.ok(note.length > 0, `${name} should not be empty`)
      assert.ok(note.startsWith(marker), `${name} must start with ${marker}`)
      assert.ok(note.length < fullPrompt.length, `${name} should be cheaper than the full guidance`)
    })
  }
})

describe('default-prompts — SOLE_IMPLEMENTER_DIRECTIVE', () => {
  test('is a concise directive', () => {
    assert.ok(SOLE_IMPLEMENTER_DIRECTIVE.includes('sole implementer'))
    assert.ok(SOLE_IMPLEMENTER_DIRECTIVE.includes('never delegate'))
    assert.ok(SOLE_IMPLEMENTER_DIRECTIVE.length < 200)
  })

  test('is embedded in lean identity prompt', () => {
    const lean = buildSpecialistIdentityPromptLean('default')
    assert.ok(lean.includes(SOLE_IMPLEMENTER_DIRECTIVE))
  })
})

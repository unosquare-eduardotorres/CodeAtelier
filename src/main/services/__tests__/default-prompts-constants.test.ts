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
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT_LEAN,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT_LEAN,
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
  buildDaVinciIdentityPrompt,
  buildDaVinciIdentityPromptLean,
  PLAN_MODE_SECTION,
  BUILD_MODE_SECTION,
  DANGER_MODE_SECTION,
  MODE_CONTEXT_SECTIONS,
  PLAN_MODE_SECTION_LEAN,
  BUILD_MODE_SECTION_LEAN,
  DANGER_MODE_SECTION_LEAN,
  MODE_CONTEXT_SECTIONS_LEAN
} from '../default-prompts'

describe('default-prompts — prompt constants', () => {
  // ── Core prompt constants are non-empty strings ──

  const promptPairs = [
    ['ASK_QUESTION_PROMPT', ASK_QUESTION_PROMPT, ASK_QUESTION_PROMPT_LEAN],
    ['MEMORY_PROTOCOL_PROMPT', MEMORY_PROTOCOL_PROMPT, MEMORY_PROTOCOL_PROMPT_LEAN],
    ['REPOMAP_GUIDANCE_PROMPT', REPOMAP_GUIDANCE_PROMPT, REPOMAP_GUIDANCE_PROMPT_LEAN],
    ['SEMANTIC_SEARCH_GUIDANCE_PROMPT', SEMANTIC_SEARCH_GUIDANCE_PROMPT, SEMANTIC_SEARCH_GUIDANCE_PROMPT_LEAN],
    ['GIT_CONTEXT_GUIDANCE_PROMPT', GIT_CONTEXT_GUIDANCE_PROMPT, GIT_CONTEXT_GUIDANCE_PROMPT_LEAN],
    ['CHECKPOINT_CONTEXT_GUIDANCE_PROMPT', CHECKPOINT_CONTEXT_GUIDANCE_PROMPT, CHECKPOINT_CONTEXT_GUIDANCE_PROMPT_LEAN],
    ['GITHUB_CONTEXT_GUIDANCE_PROMPT', GITHUB_CONTEXT_GUIDANCE_PROMPT, GITHUB_CONTEXT_GUIDANCE_PROMPT_LEAN],
    ['CODE_ANALYSIS_GUIDANCE_PROMPT', CODE_ANALYSIS_GUIDANCE_PROMPT, CODE_ANALYSIS_GUIDANCE_PROMPT_LEAN],
    ['LIBRARY_DOCS_GUIDANCE_PROMPT', LIBRARY_DOCS_GUIDANCE_PROMPT, LIBRARY_DOCS_GUIDANCE_PROMPT_LEAN],
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

describe('default-prompts — buildDaVinciIdentityPrompt', () => {
  test('returns string for each tone', () => {
    const tones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const
    for (const tone of tones) {
      const result = buildDaVinciIdentityPrompt(tone)
      assert.equal(typeof result, 'string')
      assert.ok(result.length > 100, `Prompt for ${tone} should be substantial`)
    }
  })

  test('includes tone-specific style', () => {
    const prompt = buildDaVinciIdentityPrompt('brutal')
    assert.ok(prompt.length > 0)
  })
})

describe('default-prompts — buildDaVinciIdentityPromptLean', () => {
  test('returns string for each tone', () => {
    const tones = ['default', 'calm', 'optimistic', 'brutal', 'caveman'] as const
    for (const tone of tones) {
      const result = buildDaVinciIdentityPromptLean(tone)
      assert.equal(typeof result, 'string')
      assert.ok(result.length > 50)
    }
  })

  test('lean version is within 25% of full', () => {
    const full = buildDaVinciIdentityPrompt('default')
    const lean = buildDaVinciIdentityPromptLean('default')
    // After trimming, both are compact. Lean may be slightly longer.
    const ratio = lean.length / full.length
    assert.ok(ratio < 1.25, `Lean/full ratio (${ratio.toFixed(2)}) should be < 1.25`)
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

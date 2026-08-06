/**
 * Unit tests for prompt-builder.ts — local LLM prompt assembly + section extraction.
 *
 * Phase 6A Coverage Improvement — lines 442-476 (buildLocalPrompt), 523-541 (extractEssentialSections).
 * These are pure string-assembly methods with no filesystem or DB dependencies when
 * workspacePath is empty/missing.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { PromptBuilder } from '../prompt-builder'

const builder = new PromptBuilder()

// ── extractEssentialSections (private, accessed via any) ──

describe('PromptBuilder.extractEssentialSections', () => {
  const extract = (prompt: string): string => (builder as any).extractEssentialSections(prompt)

  test('keeps identity section', () => {
    const prompt = '## Identity\nYou are a coding assistant.\n\n## Skills\nList of skills...'
    const result = extract(prompt)
    assert.ok(result.includes('## Identity'))
    assert.ok(result.includes('coding assistant'))
  })

  test('keeps mode section', () => {
    const prompt = '## Mode\nBuild mode rules.\n\n## Design System\nColors and typography...'
    const result = extract(prompt)
    assert.ok(result.includes('## Mode'))
    assert.ok(result.includes('Build mode rules'))
  })

  test('keeps conventions section', () => {
    const prompt = '## Conventions\nUse TypeScript strict.\n\n## Architecture Notes\nDeep dive...'
    const result = extract(prompt)
    assert.ok(result.includes('## Conventions'))
    assert.ok(!result.includes('Architecture Notes'))
  })

  // 'guidelines' was dropped from essentialHeaders in 80d7a73, one day after
  // this case was written -- prompt-builder.ts:653-660 now keeps only identity,
  // mode, conventions, key commands, what not to do, error handling.
  test('strips guidelines section', () => {
    const prompt = '## Guidelines\n1. Be concise.\n\n## Agents\nSubagent config...'
    const result = extract(prompt)
    assert.ok(!result.includes('## Guidelines'))
    assert.ok(!result.includes('Agents'))
  })

  test('strips skills, design system, architecture, agents', () => {
    const prompt = [
      '## Identity\nI am assistant.',
      '## Skills\nSkill 1...',
      '## Design System\nColors...',
      '## Architecture Notes\nDeep details...',
      '## Agents\nSubagent config...',
      '## Error Handling\nAlways retry.'
    ].join('\n\n')
    const result = extract(prompt)
    assert.ok(result.includes('## Identity'))
    assert.ok(result.includes('## Error Handling'))
    assert.ok(!result.includes('## Skills'))
    assert.ok(!result.includes('## Design System'))
    assert.ok(!result.includes('## Architecture'))
    assert.ok(!result.includes('## Agents'))
  })

  test('empty prompt → empty string', () => {
    assert.equal(extract(''), '')
  })

  test('prompt with no essential sections → empty string', () => {
    const prompt = '## Skills\nOnly skills here.\n\n## Agents\nSubagent only.'
    assert.equal(extract(prompt), '')
  })
})

// ── buildLocalPlanDirective (Phase 6A: tier-based tool budget) ──
// (complements existing tests in prompt-builder.test.ts)

describe('PromptBuilder.buildLocalPlanDirective — output structure', () => {
  test('small tier → directive mentions budget of 5', () => {
    const result = builder.buildLocalPlanDirective('small')
    assert.ok(result.includes('Maximum 5 tool calls'))
    assert.ok(result.includes('## Plan Mode — Strict Workflow'))
    assert.ok(result.includes('emit_plan'))
  })

  test('medium tier → directive mentions budget of 8', () => {
    const result = builder.buildLocalPlanDirective('medium')
    assert.ok(result.includes('Maximum 8 tool calls'))
  })

  test('large tier → directive mentions budget of 15', () => {
    const result = builder.buildLocalPlanDirective('large')
    assert.ok(result.includes('Maximum 15 tool calls'))
  })

  test('directive includes ordered workflow steps', () => {
    const result = builder.buildLocalPlanDirective('small')
    assert.ok(result.includes('1. PARSE'))
    assert.ok(result.includes('2. LOCATE'))
    assert.ok(result.includes('3. READ'))
    assert.ok(result.includes('4. EMIT THE PLAN'))
  })

  test('directive includes fallback format', () => {
    const result = builder.buildLocalPlanDirective('medium')
    assert.ok(result.includes('Fallback (if emit_plan unavailable)'))
  })
})

// ── extractGeneralistClaudeMdSections (private) ──

describe('PromptBuilder.extractGeneralistClaudeMdSections', () => {
  const extractGen = (content: string, mode: string): string =>
    (builder as any).extractGeneralistClaudeMdSections(content, mode)

  test('plan mode → only tech stack, key commands, conventions, what not to do', () => {
    const content = [
      '## Overview\nProject overview...',
      '## Tech Stack\nNode.js, TypeScript',
      '## Key Commands\nnpm run build',
      '## Conventions\nAlways lint.',
      '## What Not To Do\nNo force push.',
      '## Error Handling\nRetry 3 times.'
    ].join('\n\n')
    const result = extractGen(content, 'plan')
    assert.ok(result.includes('Tech Stack'))
    assert.ok(result.includes('Key Commands'))
    assert.ok(result.includes('Conventions'))
    assert.ok(result.includes('What Not To Do'))
    assert.ok(!result.includes('Overview'), 'overview excluded in plan mode')
  })

  test('build mode → includes overview, project structure, error handling', () => {
    const content = [
      '## Overview\nProject overview...',
      '## Project Structure\nsrc/ layout',
      '## Tech Stack\nNode.js',
      '## Error Handling\nRetry logic.'
    ].join('\n\n')
    const result = extractGen(content, 'build')
    assert.ok(result.includes('Overview'))
    assert.ok(result.includes('Project Structure'))
    assert.ok(result.includes('Error Handling'))
  })

  test('skills section → always skipped', () => {
    const content = '## Skills\nSkill list...\n\n## Tech Stack\nNode.js'
    const resultPlan = extractGen(content, 'plan')
    const resultBuild = extractGen(content, 'build')
    assert.ok(!resultPlan.includes('Skills'))
    assert.ok(!resultBuild.includes('Skills'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

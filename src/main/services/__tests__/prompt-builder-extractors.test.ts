/**
 * Extended edge-case tests for prompt-builder.ts private section extractors.
 *
 * Supplements prompt-builder.test.ts with additional coverage for:
 *  - extractClaudeMdSections: empty/no-heading content, multi-section interactions
 *  - extractGeneralistClaudeMdSections: explicit negative tests for plan-only exclusions
 *  - extractEssentialSections: all 7 essential header types, multi-section extraction
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { PromptBuilder } from '../prompt-builder'

const builder = new PromptBuilder()
const extract = (content: string, essential: string[], skip: string[], keepUnmatched: boolean) =>
  (builder as any).extractClaudeMdSections(content, essential, skip, keepUnmatched)
const extractGeneralist = (content: string, mode: string) =>
  (builder as any).extractGeneralistClaudeMdSections(content, mode)
const extractEssential = (prompt: string) => (builder as any).extractEssentialSections(prompt)

// ── extractClaudeMdSections — additional edge cases ──

describe('extractClaudeMdSections — edge cases', () => {
  test('empty content → empty string', () => {
    const result = extract('', ['tech stack'], [], false)
    assert.equal(result, '')
  })

  test('no ## headings → returns full content (all preamble)', () => {
    const content = 'This is plain text.\nNo headings at all.\nJust content.'
    const result = extract(content, ['anything'], [], false)
    assert.ok(result.includes('This is plain text.'))
    assert.ok(result.includes('No headings at all.'))
    assert.ok(result.includes('Just content.'))
  })

  test('multiple essential headings kept in order', () => {
    const content = [
      '## First Essential',
      'Content A.',
      '## Skipped Section',
      'Content B.',
      '## Second Essential',
      'Content C.'
    ].join('\n')
    const result = extract(content, ['first essential', 'second essential'], ['skipped'], false)
    assert.ok(result.includes('## First Essential'))
    assert.ok(result.includes('Content A.'))
    assert.ok(!result.includes('## Skipped Section'))
    assert.ok(!result.includes('Content B.'))
    assert.ok(result.includes('## Second Essential'))
    assert.ok(result.includes('Content C.'))
  })

  test('### sub-headings are NOT treated as section boundaries', () => {
    const content = [
      '## Essential Section',
      'Main content.',
      '### Sub-heading',
      'Sub-heading content.',
      '## Skipped Section',
      'Should be excluded.'
    ].join('\n')
    const result = extract(content, ['essential section'], ['skipped section'], false)
    assert.ok(result.includes('### Sub-heading'), 'sub-heading inside essential section is kept')
    assert.ok(result.includes('Sub-heading content.'))
    assert.ok(!result.includes('Should be excluded.'))
  })

  test('content between skipped sections is not leaked', () => {
    const content = [
      '## Skip A',
      'Skip A content.',
      '## Skip B',
      'Skip B content.',
      '## Essential',
      'Essential content.'
    ].join('\n')
    const result = extract(content, ['essential'], ['skip a', 'skip b'], false)
    assert.ok(!result.includes('Skip A content.'))
    assert.ok(!result.includes('Skip B content.'))
    assert.ok(result.includes('Essential content.'))
  })
})

// ── extractGeneralistClaudeMdSections — additional edge cases ──

describe('extractGeneralistClaudeMdSections — extended coverage', () => {
  const fullContent = [
    '# My Project',
    'Preamble.',
    '',
    '## Overview',
    'Project overview.',
    '',
    '## Project Structure',
    'src/ and lib/ layout.',
    '',
    '## Error Handling',
    'Use Result types.',
    '',
    '## Tech Stack',
    'TypeScript, Node.',
    '',
    '## Deprecation Notes',
    'Old patterns.',
    '',
    '## Electron Documentation',
    'Electron-specific docs.',
    '',
    '## Agents',
    'Agent architecture.',
    '',
    '## Available Skills',
    'Skill catalog.'
  ].join('\n')

  test('plan mode excludes "project structure" (build-only heading)', () => {
    const result = extractGeneralist(fullContent, 'plan')
    assert.ok(!result.includes('## Project Structure'), 'project structure excluded in plan')
  })

  test('plan mode excludes "error handling" (build-only heading)', () => {
    const result = extractGeneralist(fullContent, 'plan')
    assert.ok(!result.includes('## Error Handling'), 'error handling excluded in plan')
  })

  test('build mode keeps "error handling"', () => {
    const result = extractGeneralist(fullContent, 'build')
    assert.ok(result.includes('## Error Handling'), 'error handling kept in build')
    assert.ok(result.includes('Use Result types.'))
  })

  test('build mode keeps "project structure"', () => {
    const result = extractGeneralist(fullContent, 'build')
    assert.ok(result.includes('## Project Structure'), 'project structure kept in build')
  })

  test('both modes exclude "deprecation notes"', () => {
    for (const mode of ['plan', 'build']) {
      const result = extractGeneralist(fullContent, mode)
      assert.ok(!result.includes('## Deprecation Notes'), `deprecation notes skipped in ${mode}`)
    }
  })

  test('both modes exclude "agents" section', () => {
    for (const mode of ['plan', 'build']) {
      const result = extractGeneralist(fullContent, mode)
      assert.ok(!result.includes('## Agents'), `agents skipped in ${mode}`)
    }
  })

  test('both modes exclude "available skills"', () => {
    for (const mode of ['plan', 'build']) {
      const result = extractGeneralist(fullContent, mode)
      assert.ok(!result.includes('## Available Skills'), `available skills skipped in ${mode}`)
    }
  })

  test('both modes exclude "electron documentation"', () => {
    for (const mode of ['plan', 'build']) {
      const result = extractGeneralist(fullContent, mode)
      assert.ok(
        !result.includes('## Electron Documentation'),
        `electron documentation skipped in ${mode}`
      )
    }
  })
})

// ── extractEssentialSections — extended coverage ──

describe('extractEssentialSections — all essential headers', () => {
  test('extracts "key commands" section', () => {
    const prompt = '## Key Commands\nnpm test\nnpm run build\n\n## Skills\nMany skills.'
    const result = extractEssential(prompt)
    assert.ok(result.includes('Key Commands'))
    assert.ok(result.includes('npm test'))
    assert.ok(!result.includes('Skills'))
  })

  test('extracts "what not to do" section', () => {
    const prompt = '## What Not To Do\nNever mutate.\n\n## Design System\nColors.'
    const result = extractEssential(prompt)
    assert.ok(result.includes('What Not To Do'))
    assert.ok(!result.includes('Design System'))
  })

  test('extracts "error handling" section', () => {
    const prompt = '## Error Handling\nUse try/catch.\n\n## Architecture\nMVC pattern.'
    const result = extractEssential(prompt)
    assert.ok(result.includes('Error Handling'))
    assert.ok(!result.includes('Architecture'))
  })

  test('extracts multiple essential sections in one prompt', () => {
    const prompt = [
      '## Identity',
      'I am an AI.',
      '',
      '## Mode',
      'Build mode.',
      '',
      '## Conventions',
      'Use strict.',
      '',
      '## Key Commands',
      'npm test.',
      '',
      '## Guidelines',
      'Follow rules.',
      '',
      '## Skills',
      'Many skills.',
      '',
      '## Design System',
      'Colors.'
    ].join('\n')
    const result = extractEssential(prompt)
    assert.ok(result.includes('Identity'))
    assert.ok(result.includes('Mode'))
    assert.ok(result.includes('Conventions'))
    assert.ok(result.includes('Key Commands'))
    // Guidelines is no longer essential -- removed from essentialHeaders in
    // 80d7a73, a day after this case was written.
    assert.ok(!result.includes('Guidelines'))
    assert.ok(!result.includes('Skills'))
    assert.ok(!result.includes('Design System'))
  })

  test('no essential sections → empty string', () => {
    const prompt = '## Skills\nMany.\n\n## Design System\nPretty.'
    const result = extractEssential(prompt)
    assert.equal(result, '')
  })

  test('content before ## headings is NOT preserved (no preamble)', () => {
    // extractEssentialSections splits on ^## and only keeps matching sections
    // Unlike extractClaudeMdSections, there's no preamble preservation
    const prompt = 'Preamble text.\n\n## Identity\nAgent.\n\n## Skills\nNope.'
    const result = extractEssential(prompt)
    // The preamble is in sections[0] which won't match any essentialHeader
    assert.ok(!result.includes('Preamble text.'))
    assert.ok(result.includes('Identity'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

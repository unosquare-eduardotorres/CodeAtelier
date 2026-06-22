/**
 * Unit tests for parseSkillTiers — pure markdown parser for skill tier extraction.
 *
 * Source: src/main/services/skill.service.ts (exported function).
 * 100% pure — no I/O, no dependencies, no stubs needed.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseSkillTiers } from '../skill.service'

describe('parseSkillTiers', () => {
  // ── Empty / minimal input ──

  test('empty_content_returns_valid_tier_structure', () => {
    const result = parseSkillTiers('test-skill', 'A test skill', '')
    assert.ok(result.tier1Json, 'tier1Json should be non-empty')
    assert.equal(typeof result.tier2Instructions, 'string')
  })

  test('tier1Json_is_valid_JSON', () => {
    const result = parseSkillTiers('test-skill', 'A test skill', '# Test\nSome content')
    const parsed = JSON.parse(result.tier1Json)
    assert.equal(parsed.name, 'test-skill')
    assert.ok(Array.isArray(parsed.keywords))
  })

  test('name_and_description_appear_in_tier1Json', () => {
    const result = parseSkillTiers('my-skill', 'Does something useful', '# Title\nContent.')
    const parsed = JSON.parse(result.tier1Json)
    assert.equal(parsed.name, 'my-skill')
    assert.equal(parsed.description, 'Does something useful')
  })

  // ── Keyword extraction from headings ──

  test('extracts_keywords_from_headings', () => {
    const content = '# Title\n\n## Authentication Setup\n\nSome instructions.\n\n## Database Config\n\nMore.'
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.includes('authentication'))
    assert.ok(parsed.keywords.includes('setup'))
    assert.ok(parsed.keywords.includes('database'))
    assert.ok(parsed.keywords.includes('config'))
  })

  test('headings_filter_stop_words', () => {
    const content = '# Title\n\n## How to Handle the Request\n\nDetails.'
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    // "how", "the" should be filtered
    assert.ok(!parsed.keywords.includes('how'))
    assert.ok(!parsed.keywords.includes('the'))
    // "handle" and "request" should remain
    assert.ok(parsed.keywords.includes('handle'))
    assert.ok(parsed.keywords.includes('request'))
  })

  // ── Keyword extraction from bold terms ──

  test('extracts_keywords_from_bold_terms', () => {
    const content = '# Title\n\nUse **dependency injection** for all **service constructors**.'
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.includes('dependency'))
    assert.ok(parsed.keywords.includes('injection'))
    assert.ok(parsed.keywords.includes('service'))
    assert.ok(parsed.keywords.includes('constructors'))
  })

  // ── Keyword extraction from name ──

  test('extracts_keywords_from_name', () => {
    const result = parseSkillTiers('react-testing-library', 'desc', '# Skill\nContent.')
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.includes('react'))
    assert.ok(parsed.keywords.includes('testing'))
    assert.ok(parsed.keywords.includes('library'))
  })

  // ── Keyword extraction from explicit keyword lines ──

  test('extracts_keywords_from_explicit_keyword_line', () => {
    const content = '# Test Skill\n\nKeywords: caching, redis, performance\n\nMore content.'
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.includes('caching'))
    assert.ok(parsed.keywords.includes('redis'))
    assert.ok(parsed.keywords.includes('performance'))
  })

  test('extracts_keywords_from_trigger_terms_line', () => {
    const content = '# Test Skill\n\nTrigger terms: deployment, docker, kubernetes\n\nContent.'
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.includes('deployment'))
    assert.ok(parsed.keywords.includes('docker'))
    assert.ok(parsed.keywords.includes('kubernetes'))
  })

  // ── Deduplication and cap ──

  test('keyword_deduplication', () => {
    // "testing" appears in name and heading — should appear only once
    const content = '# Test Skill\n\n## Testing Guide\n\nUse **testing** patterns.'
    const result = parseSkillTiers('testing-skill', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    const count = parsed.keywords.filter((k: string) => k === 'testing').length
    assert.equal(count, 1, 'Duplicate keywords should be removed')
  })

  test('keyword_cap_at_30', () => {
    // Generate 50 unique keywords from headings
    const headings = Array.from({ length: 50 }, (_, i) => `## keyword${String(i).padStart(3, '0')} section`).join('\n\n')
    const content = `# Title\n\n${headings}`
    const result = parseSkillTiers('test', 'desc', content)
    const parsed = JSON.parse(result.tier1Json)
    assert.ok(parsed.keywords.length <= 30, `Expected <=30, got ${parsed.keywords.length}`)
  })

  // ── Tier 2 extraction ──

  test('tier2_contains_first_section_content', () => {
    const content = [
      '# My Skill',
      '',
      '## Core Instructions',
      '',
      'Always use dependency injection.',
      'Prefer composition over inheritance.',
      '',
      '## Advanced Topics',
      '',
      'This should not be in tier2.'
    ].join('\n')
    const result = parseSkillTiers('test', 'desc', content)
    assert.ok(result.tier2Instructions.includes('dependency injection'))
    assert.ok(result.tier2Instructions.includes('composition over inheritance'))
  })

  test('tier2_uses_description_when_content_empty', () => {
    const result = parseSkillTiers('test', 'Fallback description', '')
    assert.equal(result.tier2Instructions, 'Fallback description')
  })

  test('tier2_truncation_at_2000_chars', () => {
    const longSection = 'A'.repeat(3000)
    const content = `# Title\n\n## Instructions\n\n${longSection}\n\n## End`
    const result = parseSkillTiers('test', 'desc', content)
    assert.ok(result.tier2Instructions.length <= 2100, 'Tier2 should be capped near 2000 chars')
    assert.ok(result.tier2Instructions.includes('[... see full skill for details]'))
  })

  // ── Edge cases ──

  test('content_with_no_headings', () => {
    const content = 'Just some text without any markdown headings or bold.'
    const result = parseSkillTiers('test', 'desc', content)
    assert.ok(result.tier1Json)
    assert.ok(result.tier2Instructions.length > 0)
  })

  test('special_characters_in_content_no_crash', () => {
    const content = '# Title\n\n## Règles spéciales\n\n**café** with `regex: /[^a-z]/g`\n\n$special & <tags>'
    const result = parseSkillTiers('test', 'desc', content)
    assert.ok(result.tier1Json)
    assert.ok(result.tier2Instructions)
  })

  test('short_words_filtered_from_keywords', () => {
    const content = '# A\n\n## In Of\n\nUse **go** to do **it**.'
    const result = parseSkillTiers('ab', 'cd', content)
    const parsed = JSON.parse(result.tier1Json)
    // All words are <=2 chars, should be filtered
    assert.ok(!parsed.keywords.includes('in'))
    assert.ok(!parsed.keywords.includes('of'))
    assert.ok(!parsed.keywords.includes('go'))
    assert.ok(!parsed.keywords.includes('it'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

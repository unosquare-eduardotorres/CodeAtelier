/**
 * Unit tests for parseSkillTiers() — pure skill markdown parser.
 *
 * Covers keyword extraction (explicit lines, name splitting, headings, bold terms),
 * tier 1 JSON structure, tier 2 content extraction, truncation, and edge cases.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseSkillTiers } from '../skill.service'

// ── Test Data ──

const SKILL_WITH_KEYWORDS = `# React Hooks Expert

Keywords: useState, useEffect, custom hooks, memoization

## When to Use

Use this skill for React component optimization.

## Performance

Always prefer useMemo for expensive calculations.
`

const SKILL_WITH_TRIGGER_TERMS = `# API Gateway

Trigger terms: rate limiting, throttling, circuit breaker

## Overview

Build resilient API gateways.
`

const SKILL_WITH_ACTIVATION_KEYWORDS = `# Docker Pro

activation keywords: containerization, orchestration, docker-compose

## Setup

Configure your Docker environment.
`

const SKILL_WITH_HEADINGS = `# My Feature

## Error Handling Strategy

Handle errors gracefully.

## Performance Optimization

Optimize for speed.

## Data Validation Rules

Validate all inputs.
`

const SKILL_WITH_BOLD = `# Testing Skill

Use **async/await** patterns with **dependency injection** for testable code.

## Rules

Follow **test-driven** development.
`

const LONG_SKILL = `# Big Skill

This is the intro paragraph.

## Core Instructions

${'Line of instruction content here.\n'.repeat(100)}

## Advanced Topics

This should not be in tier 2.
`

const SIMPLE_SKILL = `# Simple Skill

Just a plain skill with no sections.
No headings, no keywords, no bold terms.
Just simple content that goes on.
`

const EMPTY_CONTENT_SKILL = ``

const NO_HEADINGS_SKILL = `Just raw text with no markdown headings.
This is the entire content.
Nothing fancy here.`

// ── Keyword Extraction: Explicit Lines ──

describe('parseSkillTiers — keyword extraction: explicit lines', () => {
  test('extracts from "Keywords:" line', () => {
    const result = parseSkillTiers('react-hooks', 'React hooks expert', SKILL_WITH_KEYWORDS)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.includes('usestate'), `Expected usestate in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('useeffect'), `Expected useeffect in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('custom hooks'), `Expected "custom hooks" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('memoization'), `Expected memoization in ${JSON.stringify(tier1.keywords)}`)
  })

  test('extracts from "Trigger terms:" line', () => {
    const result = parseSkillTiers('api-gateway', 'API Gateway skill', SKILL_WITH_TRIGGER_TERMS)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.includes('rate limiting'), `Expected "rate limiting" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('throttling'), `Expected throttling in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('circuit breaker'))
  })

  test('extracts from "activation keywords:" line', () => {
    const result = parseSkillTiers('docker-pro', 'Docker skill', SKILL_WITH_ACTIVATION_KEYWORDS)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.includes('containerization'))
    assert.ok(tier1.keywords.includes('orchestration'))
    assert.ok(tier1.keywords.includes('docker-compose'))
  })
})

// ── Keyword Extraction: Name Splitting ──

describe('parseSkillTiers — keyword extraction: name splitting', () => {
  test('splits hyphenated name into individual words', () => {
    const result = parseSkillTiers('async-io', 'Async IO operations', '')
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.includes('async'), `Expected "async" in ${JSON.stringify(tier1.keywords)}`)
  })

  test('filters out short words (<=2 chars) from name', () => {
    const result = parseSkillTiers('go-is-ok', 'A language', '')
    const tier1 = JSON.parse(result.tier1Json)
    // "go" and "is" and "ok" are all <=2 chars → filtered
    // only keyword should come from name parts > 2 chars (none here from name alone)
    for (const kw of tier1.keywords) {
      assert.ok(kw.length > 2, `Keyword "${kw}" should be longer than 2 chars`)
    }
  })
})

// ── Keyword Extraction: Headings ──

describe('parseSkillTiers — keyword extraction: headings', () => {
  test('extracts words from ## headings', () => {
    const result = parseSkillTiers('feature', 'A feature', SKILL_WITH_HEADINGS)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.includes('error'), `Expected "error" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('handling'), `Expected "handling" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('performance'), `Expected "performance" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('optimization'), `Expected "optimization" in ${JSON.stringify(tier1.keywords)}`)
  })

  test('removes stop words from heading keywords', () => {
    const content = `# Skill\n\n## How the Widget Works\n\nContent here.`
    const result = parseSkillTiers('skill', 'desc', content)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(!tier1.keywords.includes('the'), 'Stop word "the" should be removed')
    assert.ok(!tier1.keywords.includes('how'), 'Stop word "how" should be removed')
    assert.ok(tier1.keywords.includes('widget'), `Expected "widget" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('works'), `Expected "works" in ${JSON.stringify(tier1.keywords)}`)
  })

  test('extracts from multiple headings without duplicates', () => {
    const content = `# Skill\n\n## Error Handling\n\nContent.\n\n## Error Recovery\n\nMore content.`
    const result = parseSkillTiers('skill', 'desc', content)
    const tier1 = JSON.parse(result.tier1Json)
    // "error" should appear only once despite being in two headings
    const errorCount = tier1.keywords.filter((k: string) => k === 'error').length
    assert.equal(errorCount, 1, 'Duplicate keyword "error" should be deduped')
  })
})

// ── Keyword Extraction: Bold Terms ──

describe('parseSkillTiers — keyword extraction: bold terms', () => {
  test('extracts words from **bold** terms', () => {
    const result = parseSkillTiers('testing', 'Testing skill', SKILL_WITH_BOLD)
    const tier1 = JSON.parse(result.tier1Json)
    // Bold text splits on [\s-]+ only — "async/await" stays as one token
    assert.ok(tier1.keywords.includes('async/await'), `Expected "async/await" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('dependency'), `Expected "dependency" in ${JSON.stringify(tier1.keywords)}`)
    assert.ok(tier1.keywords.includes('injection'), `Expected "injection" in ${JSON.stringify(tier1.keywords)}`)
  })

  test('only scans first 2000 chars for bold terms', () => {
    // Create content with bold beyond 2000 chars
    const padding = 'x'.repeat(2100)
    const content = `# Skill\n\n${padding}\n\n**latebold** should not appear`
    const result = parseSkillTiers('skill', 'desc', content)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(!tier1.keywords.includes('latebold'), 'Bold term beyond 2000 chars should be ignored')
  })
})

// ── Keyword Limits ──

describe('parseSkillTiers — keyword limits', () => {
  test('caps keywords at 30', () => {
    // Generate content with many unique keywords
    const manyKeywords = Array.from({ length: 40 }, (_, i) => `keyword${i}`).join(', ')
    const content = `# Skill\n\nKeywords: ${manyKeywords}\n`
    const result = parseSkillTiers('skill', 'desc', content)
    const tier1 = JSON.parse(result.tier1Json)
    assert.ok(tier1.keywords.length <= 30, `Expected <= 30 keywords, got ${tier1.keywords.length}`)
  })

  test('filters keywords shorter than 3 chars and deduplicates', () => {
    const content = `# Skill\n\nKeywords: go, ok, ab, testing, testing, development\n`
    const result = parseSkillTiers('skill', 'desc', content)
    const tier1 = JSON.parse(result.tier1Json)
    // "go", "ok", "ab" are <=2 chars → filtered
    for (const kw of tier1.keywords) {
      assert.ok(kw.length > 2, `Keyword "${kw}" should be > 2 chars`)
    }
    const testingCount = tier1.keywords.filter((k: string) => k === 'testing').length
    assert.equal(testingCount, 1, 'Duplicate "testing" should be deduped')
  })
})

// ── Tier 1 JSON Structure ──

describe('parseSkillTiers — tier 1 JSON structure', () => {
  test('tier1Json has correct shape with name, description, keywords', () => {
    const result = parseSkillTiers('my-skill', 'A helpful skill', SKILL_WITH_KEYWORDS)
    const tier1 = JSON.parse(result.tier1Json)
    assert.equal(tier1.name, 'my-skill')
    assert.equal(typeof tier1.description, 'string')
    assert.ok(Array.isArray(tier1.keywords))
  })

  test('description capped at 200 chars in tier1', () => {
    const longDesc = 'A'.repeat(300)
    const result = parseSkillTiers('skill', longDesc, '')
    const tier1 = JSON.parse(result.tier1Json)
    assert.equal(tier1.description.length, 200, 'Description should be capped at 200 chars')
  })
})

// ── Tier 2 Extraction ──

describe('parseSkillTiers — tier 2 extraction', () => {
  test('extracts content between title and second ## heading', () => {
    const content = `# Main Title\n\nPreamble text.\n\n## First Section\n\nFirst section content.\n\n## Second Section\n\nSecond section content.`
    const result = parseSkillTiers('skill', 'desc', content)
    assert.ok(result.tier2Instructions.includes('First Section'), 'Should include first section heading')
    assert.ok(result.tier2Instructions.includes('First section content'), 'Should include first section content')
  })

  test('includes first section content up to second ## heading', () => {
    const content = `# Title\n\nIntro.\n\n## Setup\n\nSetup instructions here.\n\n## Advanced\n\nAdvanced content here.`
    const result = parseSkillTiers('skill', 'desc', content)
    assert.ok(result.tier2Instructions.includes('Setup instructions'), 'Should include Setup section')
    assert.ok(!result.tier2Instructions.includes('Advanced content'), 'Should NOT include Advanced section')
  })

  test('falls back to full content when only one ## heading exists', () => {
    const content = `# Title\n\nIntro text.\n\n## Only Section\n\nThis is the only section with content.`
    const result = parseSkillTiers('skill', 'desc', content)
    // With only one ## heading and no second ##, tier2End stays capped at ~40 lines
    assert.ok(result.tier2Instructions.includes('Only Section'))
    assert.ok(result.tier2Instructions.includes('only section with content'))
  })
})

// ── Tier 2 Truncation ──

describe('parseSkillTiers — tier 2 truncation', () => {
  test('truncates tier 2 at 2000 chars with notice', () => {
    const result = parseSkillTiers('big-skill', 'A big skill', LONG_SKILL)
    if (result.tier2Instructions.length > 2000) {
      assert.ok(
        result.tier2Instructions.includes('[... see full skill for details]'),
        'Truncated tier 2 should include truncation notice'
      )
    }
    // Either way, should not exceed 2000 + notice length
    assert.ok(
      result.tier2Instructions.length <= 2100,
      `Tier 2 too long: ${result.tier2Instructions.length}`
    )
  })

  test('empty tier 2 falls back to description', () => {
    // Content with only a title and nothing after
    const content = `# Empty Skill`
    const result = parseSkillTiers('empty', 'Fallback description', content)
    assert.equal(result.tier2Instructions, 'Fallback description')
  })
})

// ── Edge Cases ──

describe('parseSkillTiers — edge cases', () => {
  test('handles content with no headings', () => {
    const result = parseSkillTiers('plain', 'Plain skill', NO_HEADINGS_SKILL)
    // Should not throw — tier2 should contain the raw content
    assert.ok(result.tier1Json.length > 0)
    assert.ok(result.tier2Instructions.length > 0)
    assert.ok(result.tier2Instructions.includes('raw text'))
  })

  test('handles empty content', () => {
    const result = parseSkillTiers('empty', 'Empty description', EMPTY_CONTENT_SKILL)
    assert.ok(result.tier1Json.length > 0)
    const tier1 = JSON.parse(result.tier1Json)
    assert.equal(tier1.name, 'empty')
    // Empty content → tier2 falls back to description
    assert.equal(result.tier2Instructions, 'Empty description')
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

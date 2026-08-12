/**
 * Phase 27 — workspace-deploy/parsing-utils.ts pure function tests.
 *
 * 3 exported functions, all pure string parsers — no deps, no mocks.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import {
  parseAgentYaml,
  parseSkillMdFrontmatter,
  extractLastUpdated
} from '../workspace-deploy/parsing-utils'

// ── parseAgentYaml ──

describe('parseAgentYaml — frontmatter parsing', () => {
  test('parses simple key-value pairs', () => {
    const content = `---
name: DaVinci
model: claude-sonnet-4
temperature: 0.7
---

# Body content`
    const result = parseAgentYaml(content)
    assert.equal(result.frontmatter.name, 'DaVinci')
    assert.equal(result.frontmatter.model, 'claude-sonnet-4')
    assert.equal(result.frontmatter.temperature, '0.7')
    assert.ok(result.body.includes('# Body content'))
  })

  test('handles inline arrays', () => {
    const content = `---
name: Test
tools: [Read, Write, Edit]
---

Body`
    const result = parseAgentYaml(content)
    assert.ok(Array.isArray(result.frontmatter.tools))
    const tools = result.frontmatter.tools as string[]
    assert.equal(tools.length, 3)
    assert.equal(tools[0], 'Read')
    assert.equal(tools[1], 'Write')
    assert.equal(tools[2], 'Edit')
  })

  test('handles multiline values with pipe (|)', () => {
    const content = `---
name: Test
description: |
  This is a long
  multiline description
color: blue
---

Body`
    const result = parseAgentYaml(content)
    assert.ok(typeof result.frontmatter.description === 'string')
    assert.ok((result.frontmatter.description as string).includes('multiline'))
    assert.equal(result.frontmatter.color, 'blue')
  })

  test('handles multiline values with fold (>)', () => {
    const content = `---
name: Test
summary: >
  A folded
  summary line
mode: primary
---

Body`
    const result = parseAgentYaml(content)
    assert.ok(typeof result.frontmatter.summary === 'string')
    assert.equal(result.frontmatter.mode, 'primary')
  })

  test('returns empty frontmatter when no delimiters', () => {
    const content = 'Just plain body text'
    const result = parseAgentYaml(content)
    assert.deepEqual(result.frontmatter, {})
    assert.equal(result.body, content)
  })

  test('handles empty frontmatter', () => {
    const content = `---
---

Body`
    const result = parseAgentYaml(content)
    assert.ok(result.body.includes('Body'))
  })

  test('handles keys with hyphens', () => {
    const content = `---
max-turns: 50
---

Body`
    const result = parseAgentYaml(content)
    // Parser regex uses \w[\w-]* so max-turns should match
    assert.equal(result.frontmatter['max-turns'], '50')
  })

  test('handles multiline at end of frontmatter', () => {
    const content = `---
name: Test
notes: |
  Final multiline
  value at end
---

Body`
    const result = parseAgentYaml(content)
    assert.ok(typeof result.frontmatter.notes === 'string')
  })

  test('handles empty body', () => {
    const content = `---
name: Test
---
`
    const result = parseAgentYaml(content)
    assert.equal(result.frontmatter.name, 'Test')
  })
})

// ── parseSkillMdFrontmatter ──

describe('parseSkillMdFrontmatter — skill metadata extraction', () => {
  test('extracts name and description from frontmatter', () => {
    const content = `---
name: Code Review
description: Performs code review with best practices
---

# Code Review Skill

Instructions here.`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.equal(result!.name, 'Code Review')
    assert.equal(result!.description, 'Performs code review with best practices')
  })

  test('returns null when no frontmatter', () => {
    const content = 'Just plain text with no frontmatter'
    const result = parseSkillMdFrontmatter(content)
    assert.equal(result, null)
  })

  test('handles multiline name with pipe', () => {
    const content = `---
name: |
  Long Skill Name
description: Short desc
---

Body`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.ok(result!.name!.includes('Long Skill Name'))
  })

  test('handles multiline description with fold', () => {
    const content = `---
name: Test
description: >
  A very long
  folded description
---

Body`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.ok(result!.description!.includes('description'))
  })

  test('only extracts name and description fields', () => {
    const content = `---
name: Test
description: Test skill
model: claude-sonnet-4
temperature: 0.7
---

Body`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.equal(result!.name, 'Test')
    assert.equal(result!.description, 'Test skill')
    // model and temperature should not be in result
    assert.equal((result as any).model, undefined)
  })

  test('handles frontmatter with only name', () => {
    const content = `---
name: OnlyName
---

Body`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.equal(result!.name, 'OnlyName')
    assert.equal(result!.description, undefined)
  })

  test('handles multiline description at end of frontmatter', () => {
    const content = `---
name: Test
description: |
  This is the last
  field in frontmatter
---

Body`
    const result = parseSkillMdFrontmatter(content)
    assert.ok(result !== null)
    assert.ok(result!.description!.includes('last'))
  })
})

// ── extractLastUpdated ──

describe('extractLastUpdated — date extraction', () => {
  test('extracts date from content', () => {
    const content = 'Some text\nLast updated: 2024-03-15\nMore text'
    const result = extractLastUpdated(content)
    assert.equal(result, '2024-03-15')
  })

  test('handles case insensitivity', () => {
    const content = 'last updated: 2024-01-01'
    const result = extractLastUpdated(content)
    assert.equal(result, '2024-01-01')
  })

  test('returns null when no date found', () => {
    const content = 'No date here'
    const result = extractLastUpdated(content)
    assert.equal(result, null)
  })

  test('extracts first matching date', () => {
    const content = 'Last updated: 2024-06-01\nLast updated: 2024-07-01'
    const result = extractLastUpdated(content)
    assert.equal(result, '2024-06-01')
  })

  test('handles various spacing', () => {
    const content = 'Last updated:   2024-12-25'
    const result = extractLastUpdated(content)
    assert.equal(result, '2024-12-25')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}

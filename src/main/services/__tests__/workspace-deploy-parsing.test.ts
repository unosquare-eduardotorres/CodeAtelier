/**
 * Unit tests for workspace-deploy/parsing-utils — pure string/YAML parsers.
 *
 * Zero class dependencies, stateless functions.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  parseAgentYaml,
  parseSkillMdFrontmatter,
  extractLastUpdated
} from '../workspace-deploy/parsing-utils'

// ── parseAgentYaml ───────────────────────────────────────────────────────────

describe('parseAgentYaml', () => {
  test('parses frontmatter with key-value pairs', () => {
    const content = `---
name: MyAgent
version: 1.0
---
Body content here.`
    const result = parseAgentYaml(content)
    assert.equal(result.frontmatter.name, 'MyAgent')
    assert.equal(result.frontmatter.version, '1.0')
    assert.equal(result.body, 'Body content here.')
  })

  test('handles content without frontmatter', () => {
    const content = 'Just plain text, no frontmatter.'
    const result = parseAgentYaml(content)
    assert.deepEqual(result.frontmatter, {})
    assert.equal(result.body, content)
  })

  test('parses multiline values with | indicator', () => {
    const content = `---
description: |
  This is a long
  multiline description
name: Test
---
Body`
    const result = parseAgentYaml(content)
    assert.ok(
      (result.frontmatter.description as string).includes('This is a long'),
      'should capture multiline content'
    )
    assert.ok(
      (result.frontmatter.description as string).includes('multiline description'),
      'should capture second line'
    )
    assert.equal(result.frontmatter.name, 'Test')
  })

  test('parses multiline values with > indicator', () => {
    const content = `---
summary: >
  Folded text
  continues here
name: Folded
---
Body`
    const result = parseAgentYaml(content)
    assert.ok((result.frontmatter.summary as string).includes('Folded text'))
    assert.ok((result.frontmatter.summary as string).includes('continues here'))
  })

  test('parses inline arrays [a, b]', () => {
    const content = `---
tags: [coding, review, deploy]
---
`
    const result = parseAgentYaml(content)
    assert.deepEqual(result.frontmatter.tags, ['coding', 'review', 'deploy'])
  })

  test('handles empty inline array', () => {
    const content = `---
tags: []
---
Body`
    const result = parseAgentYaml(content)
    assert.deepEqual(result.frontmatter.tags, [])
  })

  test('body extraction trims whitespace', () => {
    const content = `---
name: Test
---

  Body with surrounding whitespace  
`
    const result = parseAgentYaml(content)
    assert.equal(result.body, 'Body with surrounding whitespace')
  })

  test('handles multiline value at end of frontmatter', () => {
    const content = `---
notes: |
  Last multiline field
  with extra lines
---
End`
    const result = parseAgentYaml(content)
    assert.ok((result.frontmatter.notes as string).includes('Last multiline field'))
  })
})

// ── parseSkillMdFrontmatter ──────────────────────────────────────────────────

describe('parseSkillMdFrontmatter', () => {
  test('extracts name and description from valid frontmatter', () => {
    const content = `---
name: Code Review
description: Automated code review skill
---
# Skill Content`
    const result = parseSkillMdFrontmatter(content)
    assert.notEqual(result, null)
    assert.equal(result!.name, 'Code Review')
    assert.equal(result!.description, 'Automated code review skill')
  })

  test('returns null when no frontmatter is found', () => {
    const content = '# Just a heading\n\nSome content.'
    assert.equal(parseSkillMdFrontmatter(content), null)
  })

  test('handles multiline values in skill frontmatter', () => {
    const content = `---
name: Complex Skill
description: |
  A skill with a
  multi-line description
---
Content`
    const result = parseSkillMdFrontmatter(content)
    assert.notEqual(result, null)
    assert.equal(result!.name, 'Complex Skill')
    assert.ok(result!.description?.includes('multi-line description'))
  })

  test('returns partial result when only name is present', () => {
    const content = `---
name: NameOnly
other: ignored
---
Content`
    const result = parseSkillMdFrontmatter(content)
    assert.notEqual(result, null)
    assert.equal(result!.name, 'NameOnly')
    assert.equal(result!.description, undefined)
  })

  test('handles multiline description at end of frontmatter', () => {
    const content = `---
name: EndMultiline
description: >
  Folded description
  that continues
---
Body`
    const result = parseSkillMdFrontmatter(content)
    assert.notEqual(result, null)
    assert.ok(result!.description?.includes('Folded description'))
  })
})

// ── extractLastUpdated ───────────────────────────────────────────────────────

describe('extractLastUpdated', () => {
  test('extracts valid date pattern', () => {
    const content = 'Some text\nLast updated: 2024-03-15\nMore text'
    assert.equal(extractLastUpdated(content), '2024-03-15')
  })

  test('returns null when no date pattern is found', () => {
    const content = 'No date here.'
    assert.equal(extractLastUpdated(content), null)
  })

  test('case-insensitive matching', () => {
    const content = 'last UPDATED: 2023-12-01'
    assert.equal(extractLastUpdated(content), '2023-12-01')
  })

  test('handles extra whitespace around the date', () => {
    const content = 'Last updated:   2024-06-30'
    assert.equal(extractLastUpdated(content), '2024-06-30')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

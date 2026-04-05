/**
 * Unit tests for skill-summary.service.ts — deterministic semantic summary extraction.
 * Tests frontmatter parsing, section splitting, tiered summary generation, and staleness detection.
 */
import assert from 'node:assert/strict'
import {
  parseFrontmatter,
  splitSections,
  firstParagraph,
  isHighSignalSection,
  SkillSummaryService
} from '../skill-summary.service'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── Test Data ──

const SAMPLE_SKILL = `---
name: electron-pro
description: Use this skill for ANY Electron desktop application work.
---

# Electron Pro

> **Skill version**: 2.1

Build secure, performant, cross-platform desktop applications with Electron 28+.

## Before you start

1. Check the project's Electron version.
2. Identify the target platforms.

## Key rules

These are non-negotiable:

- Never disable contextIsolation
- Always use contextBridge
- Never use remote module

## Project structure

Always scaffold Electron projects with clear process separation:

\`\`\`
my-app/
  src/
    main/
    preload/
    renderer/
\`\`\`

## Security

Critical security requirements:

- Validate all IPC inputs
- Never expose raw ipcRenderer
- Use CSP headers
`

const SIMPLE_SKILL = `---
name: simple-skill
description: A simple test skill.
---

# Simple Skill

This is a simple skill with no fancy sections.
`

const NO_FRONTMATTER_SKILL = `# No Frontmatter Skill

Just a plain markdown file with content.

## Section One

Some content here.
`

// ── Tests ──

describe('parseFrontmatter', () => {
  test('extracts name and description from YAML frontmatter', () => {
    const result = parseFrontmatter(SAMPLE_SKILL)
    assert.equal(result.name, 'electron-pro')
    assert.equal(result.description, 'Use this skill for ANY Electron desktop application work.')
    assert.ok(result.body.includes('# Electron Pro'))
  })

  test('handles missing frontmatter', () => {
    const result = parseFrontmatter(NO_FRONTMATTER_SKILL)
    assert.equal(result.name, '')
    assert.equal(result.description, '')
    assert.ok(result.body.includes('# No Frontmatter Skill'))
  })

  test('handles multi-line description with > block scalar', () => {
    const content = `---
name: test-skill
description: >
  This is a multi-line
  description that spans
  several lines.
---

# Test
`
    const result = parseFrontmatter(content)
    assert.equal(result.name, 'test-skill')
    assert.ok(result.description.includes('This is a multi-line'))
    assert.ok(result.description.includes('description that spans'))
  })
})

describe('splitSections', () => {
  test('splits body into sections by ## headings', () => {
    const { body } = parseFrontmatter(SAMPLE_SKILL)
    const sections = splitSections(body)

    // Should have preamble + 4 sections (Before you start, Key rules, Project structure, Security)
    assert.ok(sections.length >= 4, `Expected >= 4 sections, got ${sections.length}`)

    // First section should be preamble (no header)
    assert.equal(sections[0].header, '')
    assert.ok(sections[0].content.includes('Electron Pro'))

    // Verify section headers
    const headers = sections.filter((s) => s.header).map((s) => s.header)
    assert.ok(headers.some((h) => h.includes('Before you start')))
    assert.ok(headers.some((h) => h.includes('Key rules')))
    assert.ok(headers.some((h) => h.includes('Security')))
  })

  test('handles content with no headings', () => {
    const sections = splitSections('Just plain text\nwith no headings')
    assert.equal(sections.length, 1)
    assert.equal(sections[0].header, '')
    assert.ok(sections[0].content.includes('Just plain text'))
  })
})

describe('firstParagraph', () => {
  test('extracts first paragraph before blank line', () => {
    const content = 'First paragraph line 1.\nFirst paragraph line 2.\n\nSecond paragraph.'
    const result = firstParagraph(content)
    assert.equal(result, 'First paragraph line 1.\nFirst paragraph line 2.')
  })

  test('handles content with no blank lines', () => {
    const content = 'Single paragraph\nstill going.'
    const result = firstParagraph(content)
    assert.equal(result, 'Single paragraph\nstill going.')
  })

  test('skips leading blank lines', () => {
    const content = '\n\n  \nActual first paragraph.'
    const result = firstParagraph(content)
    assert.equal(result, 'Actual first paragraph.')
  })
})

describe('isHighSignalSection', () => {
  test('detects non-negotiable keyword', () => {
    assert.ok(isHighSignalSection('## Key rules', 'These are non-negotiable:'))
  })

  test('detects critical keyword in header', () => {
    assert.ok(isHighSignalSection('## Critical requirements', 'Some content'))
  })

  test('detects never/always keywords', () => {
    assert.ok(isHighSignalSection('## Rules', 'Never disable contextIsolation'))
    assert.ok(isHighSignalSection('## Rules', 'Always use contextBridge'))
  })

  test('returns false for low-signal sections', () => {
    assert.ok(!isHighSignalSection('## Project structure', 'Scaffold projects like this:'))
  })
})

describe('SkillSummaryService', () => {
  const service = new SkillSummaryService()

  describe('generateSummaries', () => {
    test('generates all three tiers', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(summaries.full.length > 0, 'full summary should not be empty')
      assert.ok(summaries.standard.length > 0, 'standard summary should not be empty')
      assert.ok(summaries.minimal.length > 0, 'minimal summary should not be empty')
    })

    test('full summary is longer than standard', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(
        summaries.full.length >= summaries.standard.length,
        `full (${summaries.full.length}) should be >= standard (${summaries.standard.length})`
      )
    })

    test('standard summary is longer than minimal', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(
        summaries.standard.length >= summaries.minimal.length,
        `standard (${summaries.standard.length}) should be >= minimal (${summaries.minimal.length})`
      )
    })

    test('full summary respects ~2000 char budget', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(summaries.full.length <= 2100, `full summary too long: ${summaries.full.length}`)
    })

    test('standard summary respects ~800 char budget', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(summaries.standard.length <= 900, `standard summary too long: ${summaries.standard.length}`)
    })

    test('minimal summary respects ~200 char budget', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(summaries.minimal.length <= 200, `minimal summary too long: ${summaries.minimal.length}`)
    })

    test('minimal summary contains skill name', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      assert.ok(summaries.minimal.includes('electron-pro'))
    })

    test('standard summary includes high-signal sections', () => {
      const summaries = service.generateSummaries(SAMPLE_SKILL)
      // Should include Key rules or Security (both have high-signal keywords)
      const hasHighSignal =
        summaries.standard.includes('Key rules') ||
        summaries.standard.includes('non-negotiable') ||
        summaries.standard.includes('Security') ||
        summaries.standard.includes('Critical')
      assert.ok(hasHighSignal, 'standard summary should include high-signal content')
    })

    test('handles skill with no frontmatter', () => {
      const summaries = service.generateSummaries(NO_FRONTMATTER_SKILL)
      assert.ok(summaries.full.length > 0)
      assert.ok(summaries.minimal.length > 0)
    })

    test('handles simple skill', () => {
      const summaries = service.generateSummaries(SIMPLE_SKILL)
      assert.ok(summaries.minimal.includes('simple-skill'))
    })
  })

  describe('contentHash', () => {
    test('produces deterministic hash', () => {
      const hash1 = service.contentHash('test content')
      const hash2 = service.contentHash('test content')
      assert.equal(hash1, hash2)
    })

    test('different content produces different hash', () => {
      const hash1 = service.contentHash('content v1')
      const hash2 = service.contentHash('content v2')
      assert.notEqual(hash1, hash2)
    })

    test('returns 64-char hex string (SHA-256)', () => {
      const hash = service.contentHash('test')
      assert.equal(hash.length, 64)
      assert.match(hash, /^[a-f0-9]+$/)
    })
  })

  describe('isStale', () => {
    test('returns true when summaryHash is null', () => {
      const skill = {
        summaryHash: null,
        summaryFull: null
      } as never
      assert.ok(service.isStale(skill, 'any content'))
    })

    test('returns true when summaryFull is null', () => {
      const skill = {
        summaryHash: 'somehash',
        summaryFull: null
      } as never
      assert.ok(service.isStale(skill, 'any content'))
    })

    test('returns true when hash differs', () => {
      const content = 'original content'
      const skill = {
        summaryHash: service.contentHash('different content'),
        summaryFull: 'some summary'
      } as never
      assert.ok(service.isStale(skill, content))
    })

    test('returns false when hash matches', () => {
      const content = 'original content'
      const skill = {
        summaryHash: service.contentHash(content),
        summaryFull: 'some summary'
      } as never
      assert.ok(!service.isStale(skill, content))
    })
  })
})

// ── Report ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

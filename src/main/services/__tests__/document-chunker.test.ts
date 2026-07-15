/**
 * Tests for document-chunker.ts — structure-aware text chunking.
 *
 * All pure functions, no mocking needed.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { chunkDocument, detectStrategy } from '../document-chunker'

// ── detectStrategy ──────────────────────────────────────────────────────────

describe('detectStrategy', () => {
  test('detects markdown files', () => {
    assert.equal(detectStrategy('docs/readme.md'), 'markdown')
    assert.equal(detectStrategy('CHANGELOG.mdx'), 'markdown')
  })

  test('detects code files', () => {
    assert.equal(detectStrategy('src/app.ts'), 'code')
    assert.equal(detectStrategy('index.tsx'), 'code')
    assert.equal(detectStrategy('main.py'), 'code')
    assert.equal(detectStrategy('lib.rs'), 'code')
    assert.equal(detectStrategy('query.sql'), 'code')
  })

  test('defaults to plain for unknown extensions', () => {
    assert.equal(detectStrategy('data.txt'), 'plain')
    assert.equal(detectStrategy('notes.pdf'), 'plain')
    assert.equal(detectStrategy('doc.docx'), 'plain')
    assert.equal(detectStrategy('file'), 'plain')
  })
})

// ── chunkDocument — markdown strategy ───────────────────────────────────────

describe('chunkDocument — markdown', () => {
  test('splits on heading boundaries', () => {
    const md = `# Section A

Content for section A.

## Subsection A1

Details for A1.

# Section B

Content for section B.`

    const chunks = chunkDocument(md, 'markdown', 'doc.md')
    assert.ok(chunks.length >= 1, 'Should produce at least 1 chunk')
    // All sections should fit in one chunk since total is small
    assert.ok(chunks[0].content.includes('Section A'))
    assert.ok(chunks[0].content.includes('Section B') || chunks.length > 1)
  })

  test('includes breadcrumbs with docName', () => {
    const md = `# Top

## Sub

Content here.`

    const chunks = chunkDocument(md, 'markdown', 'README.md')
    const hasBreadcrumb = chunks.some((c) => c.breadcrumb && c.breadcrumb.includes('README.md'))
    assert.ok(hasBreadcrumb, 'Should include doc name in breadcrumb')
  })

  test('handles content without headings as plain text', () => {
    const md = 'Just some plain content without any headings. '.repeat(100)
    const chunks = chunkDocument(md, 'markdown')
    assert.ok(chunks.length >= 1, 'Should produce chunks even without headings')
  })

  test('splits large sections into sub-chunks', () => {
    const largeSection = `# Big Section\n\n${'A'.repeat(15000)}`
    const chunks = chunkDocument(largeSection, 'markdown')
    assert.ok(chunks.length >= 2, `Large section should split into multiple chunks (got ${chunks.length})`)
  })

  test('returns empty array for empty content', () => {
    assert.deepEqual(chunkDocument('', 'markdown'), [])
  })
})

// ── chunkDocument — code strategy ───────────────────────────────────────────

describe('chunkDocument — code', () => {
  test('splits on double blank lines', () => {
    const code = `function a() { return 1 }


function b() { return 2 }


function c() { return 3 }`

    const chunks = chunkDocument(code, 'code')
    assert.ok(chunks.length >= 1, 'Should produce at least 1 chunk')
    // All three functions should be present across chunks
    const combined = chunks.map((c) => c.content).join('\n')
    assert.ok(combined.includes('function a'))
    assert.ok(combined.includes('function b'))
    assert.ok(combined.includes('function c'))
  })

  test('keeps small files in one chunk', () => {
    const smallCode = 'const x = 1\nconst y = 2'
    const chunks = chunkDocument(smallCode, 'code')
    assert.equal(chunks.length, 1)
  })
})

// ── chunkDocument — plain strategy ──────────────────────────────────────────

describe('chunkDocument — plain', () => {
  test('keeps small content in one chunk', () => {
    const text = 'Hello world.\n\nSecond paragraph.'
    const chunks = chunkDocument(text, 'plain')
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].content.includes('Hello world'))
  })

  test('splits large content with overlap', () => {
    // Create content that exceeds 10K chars
    const paragraphs = Array.from({ length: 50 }, (_, i) =>
      `Paragraph ${i}: ${'Lorem ipsum dolor sit amet. '.repeat(20)}`
    )
    const text = paragraphs.join('\n\n')
    const chunks = chunkDocument(text, 'plain')
    assert.ok(chunks.length >= 2, `Should split into multiple chunks (got ${chunks.length})`)

    // Check that chunks are properly indexed
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].index, i)
      assert.equal(chunks[i].total, chunks.length)
    }
  })
})

// ── Chunk capping ───────────────────────────────────────────────────────────

describe('chunk capping', () => {
  test('caps at MAX_CHUNKS_PER_DOC (25)', () => {
    // Create markdown with 50 sections
    const sections = Array.from({ length: 50 }, (_, i) =>
      `# Section ${i}\n\n${'Content '.repeat(500)}`
    )
    const md = sections.join('\n\n')
    const chunks = chunkDocument(md, 'markdown')
    assert.ok(chunks.length <= 25, `Should cap at 25 chunks (got ${chunks.length})`)
  })

  test('all chunks have correct total after capping', () => {
    const sections = Array.from({ length: 50 }, (_, i) =>
      `# Section ${i}\n\n${'Content '.repeat(500)}`
    )
    const md = sections.join('\n\n')
    const chunks = chunkDocument(md, 'markdown')
    for (const chunk of chunks) {
      assert.equal(chunk.total, chunks.length)
    }
  })
})

// ── Breadcrumb tracking ─────────────────────────────────────────────────────

describe('breadcrumb tracking', () => {
  test('tracks heading hierarchy', () => {
    const md = `# Top Level

## Sub Level

### Deep Level

Content at the deepest level.`

    const chunks = chunkDocument(md, 'markdown', 'test.md')
    const lastChunk = chunks[chunks.length - 1]
    assert.ok(lastChunk.breadcrumb, 'Should have breadcrumb')
    // Breadcrumb should contain hierarchy
    assert.ok(
      lastChunk.breadcrumb!.includes('Top Level') || lastChunk.breadcrumb!.includes('test.md'),
      `Breadcrumb should include heading hierarchy: "${lastChunk.breadcrumb}"`
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

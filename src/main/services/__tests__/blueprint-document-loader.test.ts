/**
 * Tests for splitBinaryDocs and buildReferenceDocsBlock from blueprint-document-loader.ts.
 *
 * Run: npx tsx src/main/services/__tests__/blueprint-document-loader.test.ts
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync, beforeEach, afterEach } from './test-harness'

setupElectronStub()

// Lazy-loaded module reference — populated inside tests after stub is active
let splitBinaryDocs: typeof import('../blueprint-document-loader').splitBinaryDocs
let buildReferenceDocsBlock: typeof import('../blueprint-document-loader').buildReferenceDocsBlock

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RefDoc {
  type: 'file' | 'workspace-file' | 'url'
  path: string
  url?: string
  name?: string
  label?: string
}

function makeDoc(overrides?: Partial<RefDoc>): RefDoc {
  return {
    type: 'workspace-file',
    path: 'readme.md',
    name: 'readme.md',
    ...overrides
  }
}

// ── splitBinaryDocs ─────────────────────────────────────────────────────────

describe('splitBinaryDocs', () => {
  beforeEach(async () => {
    const mod = await import('../blueprint-document-loader')
    splitBinaryDocs = mod.splitBinaryDocs
    buildReferenceDocsBlock = mod.buildReferenceDocsBlock
  })

  test('splits mixed md+png into text and binary', () => {
    const docs = [
      makeDoc({ path: 'docs/spec.md', name: 'spec.md' }),
      makeDoc({ path: 'assets/logo.png', name: 'logo.png' })
    ]
    const { textDocs, binaryPaths } = splitBinaryDocs(docs)
    assert.equal(textDocs.length, 1)
    assert.equal(textDocs[0].path, 'docs/spec.md')
    assert.equal(binaryPaths.length, 1)
    assert.equal(binaryPaths[0], 'assets/logo.png')
  })

  test('all-text returns empty binaryPaths', () => {
    const docs = [
      makeDoc({ path: 'a.ts' }),
      makeDoc({ path: 'b.json' })
    ]
    const { textDocs, binaryPaths } = splitBinaryDocs(docs)
    assert.equal(textDocs.length, 2)
    assert.equal(binaryPaths.length, 0)
  })

  test('all-binary returns empty textDocs', () => {
    const docs = [
      makeDoc({ path: 'img.jpg' }),
      makeDoc({ path: 'archive.zip' })
    ]
    const { textDocs, binaryPaths } = splitBinaryDocs(docs)
    assert.equal(textDocs.length, 0)
    assert.equal(binaryPaths.length, 2)
  })

  test('.docx classified as binary (Bug 1 fix)', () => {
    const { textDocs, binaryPaths } = splitBinaryDocs([makeDoc({ path: 'spec.docx' })])
    assert.equal(textDocs.length, 0)
    assert.equal(binaryPaths.length, 1)
    assert.equal(binaryPaths[0], 'spec.docx')
  })

  test('.doc classified as binary (Bug 1 fix)', () => {
    const { textDocs, binaryPaths } = splitBinaryDocs([makeDoc({ path: 'spec.doc' })])
    assert.equal(textDocs.length, 0)
    assert.equal(binaryPaths.length, 1)
  })

  test('extensionless file treated as text', () => {
    const { textDocs, binaryPaths } = splitBinaryDocs([makeDoc({ path: 'Makefile' })])
    assert.equal(textDocs.length, 1)
    assert.equal(binaryPaths.length, 0)
  })

  test('case-insensitive extension (.PNG → binary)', () => {
    const { textDocs, binaryPaths } = splitBinaryDocs([makeDoc({ path: 'PHOTO.PNG' })])
    assert.equal(textDocs.length, 0)
    assert.equal(binaryPaths.length, 1)
  })

  test('empty docs array returns both empty', () => {
    const { textDocs, binaryPaths } = splitBinaryDocs([])
    assert.equal(textDocs.length, 0)
    assert.equal(binaryPaths.length, 0)
  })
})

// ── buildReferenceDocsBlock ─────────────────────────────────────────────────

describe('buildReferenceDocsBlock', () => {
  let tmpDir: string

  beforeEach(async () => {
    const mod = await import('../blueprint-document-loader')
    splitBinaryDocs = mod.splitBinaryDocs
    buildReferenceDocsBlock = mod.buildReferenceDocsBlock
    tmpDir = join(tmpdir(), `bp-doc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  test('text doc content loaded and included', async () => {
    writeFileSync(join(tmpDir, 'spec.md'), '# Specification\n\nDetails here.')
    const { block, failedDocs } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: 'spec.md', name: 'My Spec' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('### My Spec'))
    assert.ok(block!.includes('# Specification'))
    assert.ok(block!.includes('Details here.'))
    assert.equal(failedDocs.length, 0)
  })

  test('binary listed by path, not read', async () => {
    // Don't create the binary file — it should never be read
    const { block } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: 'logo.png', name: 'logo.png' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('### Binary Reference Files'))
    assert.ok(block!.includes('`logo.png`'))
  })

  test('mixed text + binary produces both sections', async () => {
    writeFileSync(join(tmpDir, 'notes.txt'), 'Some notes')
    const { block } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: 'notes.txt', name: 'notes.txt' }),
      makeDoc({ path: 'diagram.pdf', name: 'diagram.pdf' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('### notes.txt'))
    assert.ok(block!.includes('Some notes'))
    assert.ok(block!.includes('### Binary Reference Files'))
    assert.ok(block!.includes('`diagram.pdf`'))
    assert.ok(block!.includes('---'))
  })

  test('missing file produces graceful error string (no throw)', async () => {
    const { block, failedDocs } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: 'nonexistent.md', name: 'ghost.md' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('Failed to load'))
    assert.deepEqual(failedDocs, ['ghost.md'])
  })

  test('traversal path produces error string', async () => {
    const { block, failedDocs } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: '../../etc/passwd', name: 'traversal' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('Failed to load') || block!.includes('Path traversal'))
    assert.equal(failedDocs.length, 1)
  })

  test('empty array returns undefined block and empty failedDocs', async () => {
    const { block, failedDocs } = await buildReferenceDocsBlock(tmpDir, [])
    assert.equal(block, undefined)
    assert.deepEqual(failedDocs, [])
  })

  test('text doc content capped at MAX_DOC_CHARS', async () => {
    writeFileSync(join(tmpDir, 'big.md'), 'x'.repeat(60_000))
    const { block } = await buildReferenceDocsBlock(tmpDir, [
      makeDoc({ path: 'big.md', name: 'big.md' })
    ])
    assert.ok(block)
    assert.ok(block!.includes('[… truncated]'))
  })

  test('uses doc.path as fallback heading when name is absent', async () => {
    const { block } = await buildReferenceDocsBlock(tmpDir, [
      { type: 'workspace-file' as const, path: 'unnamed.md' }
    ])
    assert.ok(block)
    assert.ok(block!.includes('### unnamed.md'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

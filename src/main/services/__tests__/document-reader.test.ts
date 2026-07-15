/**
 * Tests for document-reader.ts — format-specific text extraction.
 *
 * Tests the routing logic, extension detection, and size cap enforcement.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, beforeEach, afterEach, summaryAsync } from './test-harness'
import { readDocument, isSupportedExtension, isImageFile } from '../document-reader'

// ── isSupportedExtension ────────────────────────────────────────────────────

describe('isSupportedExtension', () => {
  test('returns true for markdown', () => {
    assert.equal(isSupportedExtension('readme.md'), true)
  })

  test('returns true for code files', () => {
    assert.equal(isSupportedExtension('app.ts'), true)
    assert.equal(isSupportedExtension('main.py'), true)
    assert.equal(isSupportedExtension('index.js'), true)
  })

  test('returns true for PDF', () => {
    assert.equal(isSupportedExtension('doc.pdf'), true)
  })

  test('returns true for DOCX', () => {
    assert.equal(isSupportedExtension('doc.docx'), true)
  })

  test('returns true for images', () => {
    assert.equal(isSupportedExtension('photo.png'), true)
    assert.equal(isSupportedExtension('photo.jpg'), true)
  })

  test('returns false for unsupported binaries', () => {
    assert.equal(isSupportedExtension('archive.zip'), false)
    assert.equal(isSupportedExtension('installer.dmg'), false)
  })

  test('returns true for known extensionless files', () => {
    assert.equal(isSupportedExtension('/path/to/Dockerfile'), true)
    assert.equal(isSupportedExtension('/path/to/Makefile'), true)
  })
})

// ── isImageFile ─────────────────────────────────────────────────────────────

describe('isImageFile', () => {
  test('returns true for image extensions', () => {
    assert.equal(isImageFile('photo.png'), true)
    assert.equal(isImageFile('photo.jpg'), true)
    assert.equal(isImageFile('photo.jpeg'), true)
    assert.equal(isImageFile('photo.webp'), true)
    assert.equal(isImageFile('photo.gif'), true)
  })

  test('returns false for non-image files', () => {
    assert.equal(isImageFile('doc.md'), false)
    assert.equal(isImageFile('doc.pdf'), false)
    assert.equal(isImageFile('doc.txt'), false)
  })
})

// ── readDocument (filesystem tests) ─────────────────────────────────────────

describe('readDocument', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), 'doc-reader-test-' + Date.now())
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  test('reads markdown files', async () => {
    const filePath = join(testDir, 'test.md')
    writeFileSync(filePath, '# Hello World\n\nThis is a markdown test file with enough content to pass the minimum check.')
    const result = await readDocument(filePath)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.format, 'text')
      assert.ok(result.content.includes('Hello World'))
      assert.equal(result.isImage, false)
    }
  })

  test('reads TypeScript files', async () => {
    const filePath = join(testDir, 'test.ts')
    writeFileSync(filePath, 'export function hello(): string { return "world" }\n// more content to pass minimum')
    const result = await readDocument(filePath)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.format, 'text')
      assert.ok(result.content.includes('hello'))
    }
  })

  test('rejects files with too little content', async () => {
    const filePath = join(testDir, 'tiny.md')
    writeFileSync(filePath, 'hi')
    const result = await readDocument(filePath)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'too_short')
    }
  })

  test('handles non-existent files', async () => {
    const result = await readDocument(join(testDir, 'does-not-exist.md'))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'not_found')
    }
  })

  test('skips zip files', async () => {
    const filePath = join(testDir, 'archive.zip')
    writeFileSync(filePath, 'PK fake zip')
    const result = await readDocument(filePath)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'binary_skip')
    }
  })

  test('skips exe files', async () => {
    const filePath = join(testDir, 'app.exe')
    writeFileSync(filePath, 'MZ fake exe')
    const result = await readDocument(filePath)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'binary_skip')
    }
  })

  test('skips legacy .doc files', async () => {
    const filePath = join(testDir, 'old.doc')
    writeFileSync(filePath, 'fake doc file')
    const result = await readDocument(filePath)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'binary_skip')
    }
  })

  test('reads images as base64 with isImage flag', async () => {
    const filePath = join(testDir, 'test.png')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const result = await readDocument(filePath)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.isImage, true)
      assert.equal(result.format, 'image')
      assert.ok(result.content.startsWith('data:image/png;base64,'))
    }
  })

  test('tries to read unknown extensions as text', async () => {
    const filePath = join(testDir, 'data.custom')
    writeFileSync(filePath, 'This is some content in a file with an unknown extension, long enough to pass.')
    const result = await readDocument(filePath)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.format, 'text')
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

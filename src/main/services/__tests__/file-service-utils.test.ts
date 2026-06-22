/**
 * Tests for FileService pure utility methods — isImageFile + estimateTokens.
 *
 * Both are pure functions on the singleton with no I/O dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { fileService } from '../file.service'

// ── isImageFile ──

describe('FileService.isImageFile', () => {
  test('.png → true', () => {
    assert.equal(fileService.isImageFile('screenshot.png'), true)
  })

  test('.jpg → true', () => {
    assert.equal(fileService.isImageFile('photo.jpg'), true)
  })

  test('.jpeg → true', () => {
    assert.equal(fileService.isImageFile('image.jpeg'), true)
  })

  test('.gif → true', () => {
    assert.equal(fileService.isImageFile('animation.gif'), true)
  })

  test('.webp → true', () => {
    assert.equal(fileService.isImageFile('hero.webp'), true)
  })

  test('.ts → false', () => {
    assert.equal(fileService.isImageFile('app.ts'), false)
  })

  test('.pdf → false', () => {
    assert.equal(fileService.isImageFile('document.pdf'), false)
  })

  test('.svg → false (SVG not in IMAGE_EXTENSIONS)', () => {
    assert.equal(fileService.isImageFile('icon.svg'), false)
  })

  test('case insensitive — .PNG → true', () => {
    assert.equal(fileService.isImageFile('SCREENSHOT.PNG'), true)
  })

  test('path with directories → still checks extension', () => {
    assert.equal(fileService.isImageFile('/assets/images/logo.png'), true)
  })
})

// ── estimateTokens ──

describe('FileService.estimateTokens', () => {
  test('empty string → 0', () => {
    assert.equal(fileService.estimateTokens(''), 0)
  })

  test('"hello world" (11 chars) → 3 (ceil(11/4))', () => {
    assert.equal(fileService.estimateTokens('hello world'), 3)
  })

  test('4000-char string → 1000', () => {
    const text = 'a'.repeat(4000)
    assert.equal(fileService.estimateTokens(text), 1000)
  })

  test('single char → 1 (ceil(1/4))', () => {
    assert.equal(fileService.estimateTokens('x'), 1)
  })

  test('4 chars → 1 (exact division)', () => {
    assert.equal(fileService.estimateTokens('test'), 1)
  })

  test('5 chars → 2 (ceil rounds up)', () => {
    assert.equal(fileService.estimateTokens('hello'), 2)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

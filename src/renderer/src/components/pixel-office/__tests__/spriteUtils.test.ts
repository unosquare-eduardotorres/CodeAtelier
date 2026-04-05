/**
 * Tests for sprites/spriteUtils — pure pixel math functions.
 * These are testable in Node.js without DOM or Phaser dependencies.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { rgbaToHex, flipSpriteH, pixelDataToSpriteData, spriteDataToPixelData } from '../sprites/spriteUtils'
import type { SpriteData } from '../engine/types'

// ── rgbaToHex ────────────────────────────────────────────────────

describe('rgbaToHex', () => {
  it('returns empty for transparent pixel (alpha 0)', () => {
    assert.equal(rgbaToHex(255, 0, 0, 0), '')
  })

  it('returns empty for near-transparent pixel (alpha 1)', () => {
    assert.equal(rgbaToHex(255, 0, 0, 1), '')
  })

  it('returns #RRGGBB for fully opaque pixel', () => {
    assert.equal(rgbaToHex(255, 128, 0, 255), '#ff8000')
  })

  it('returns #RRGGBBAA for semi-transparent pixel', () => {
    assert.equal(rgbaToHex(255, 0, 0, 128), '#ff000080')
  })

  it('handles black pixel', () => {
    assert.equal(rgbaToHex(0, 0, 0, 255), '#000000')
  })

  it('handles white pixel', () => {
    assert.equal(rgbaToHex(255, 255, 255, 255), '#ffffff')
  })

  it('pads single-digit hex values', () => {
    assert.equal(rgbaToHex(1, 2, 3, 255), '#010203')
  })

  it('handles alpha threshold boundary (alpha=2 is visible)', () => {
    assert.equal(rgbaToHex(255, 0, 0, 2), '#ff000002')
  })
})

// ── flipSpriteH ──────────────────────────────────────────────────

describe('flipSpriteH', () => {
  it('flips a row horizontally', () => {
    const sprite: SpriteData = [['#FF0000', '#00FF00', '#0000FF']]
    const flipped = flipSpriteH(sprite)
    assert.deepEqual(flipped[0], ['#0000FF', '#00FF00', '#FF0000'])
  })

  it('flips multiple rows', () => {
    const sprite: SpriteData = [
      ['#FF0000', '#00FF00'],
      ['#0000FF', '#FFFF00']
    ]
    const flipped = flipSpriteH(sprite)
    assert.deepEqual(flipped, [
      ['#00FF00', '#FF0000'],
      ['#FFFF00', '#0000FF']
    ])
  })

  it('handles single pixel', () => {
    const sprite: SpriteData = [['#ABCDEF']]
    const flipped = flipSpriteH(sprite)
    assert.deepEqual(flipped, [['#ABCDEF']])
  })

  it('does not mutate original', () => {
    const sprite: SpriteData = [['#FF0000', '#00FF00']]
    const original = sprite[0].slice()
    flipSpriteH(sprite)
    assert.deepEqual(sprite[0], original)
  })

  it('double flip returns original', () => {
    const sprite: SpriteData = [
      ['#FF0000', '#00FF00', '#0000FF'],
      ['#111111', '#222222', '#333333']
    ]
    const doubleFlipped = flipSpriteH(flipSpriteH(sprite))
    assert.deepEqual(doubleFlipped, sprite)
  })
})

// ── pixelDataToSpriteData ────────────────────────────────────────

describe('pixelDataToSpriteData', () => {
  it('converts RGBA bytes to SpriteData', () => {
    // 2x1 pixel: red opaque, transparent
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0])
    const sprite = pixelDataToSpriteData(data, 2, 1)
    assert.equal(sprite.length, 1)
    assert.equal(sprite[0].length, 2)
    assert.equal(sprite[0][0], '#ff0000')
    assert.equal(sprite[0][1], '')
  })

  it('handles 2x2 pixels', () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, // row 0: red, green
      0, 0, 255, 255, 255, 255, 255, 255 // row 1: blue, white
    ])
    const sprite = pixelDataToSpriteData(data, 2, 2)
    assert.equal(sprite.length, 2)
    assert.deepEqual(sprite[0], ['#ff0000', '#00ff00'])
    assert.deepEqual(sprite[1], ['#0000ff', '#ffffff'])
  })

  it('handles empty image', () => {
    const data = new Uint8ClampedArray([])
    const sprite = pixelDataToSpriteData(data, 0, 0)
    assert.equal(sprite.length, 0)
  })
})

// ── spriteDataToPixelData ────────────────────────────────────────

describe('spriteDataToPixelData', () => {
  it('converts SpriteData to RGBA bytes', () => {
    const sprite: SpriteData = [['#ff0000', '']]
    const { data, width, height } = spriteDataToPixelData(sprite)
    assert.equal(width, 2)
    assert.equal(height, 1)
    // Red pixel
    assert.equal(data[0], 255) // R
    assert.equal(data[1], 0) // G
    assert.equal(data[2], 0) // B
    assert.equal(data[3], 255) // A
    // Transparent pixel
    assert.equal(data[4], 0)
    assert.equal(data[5], 0)
    assert.equal(data[6], 0)
    assert.equal(data[7], 0)
  })

  it('round-trips with pixelDataToSpriteData', () => {
    const original: SpriteData = [
      ['#ff0000', '#00ff00'],
      ['#0000ff', '']
    ]
    const { data, width, height } = spriteDataToPixelData(original)
    const roundTripped = pixelDataToSpriteData(data, width, height)
    assert.deepEqual(roundTripped, original)
  })

  it('handles semi-transparent pixels', () => {
    const sprite: SpriteData = [['#ff000080']]
    const { data } = spriteDataToPixelData(sprite)
    assert.equal(data[0], 255) // R
    assert.equal(data[1], 0) // G
    assert.equal(data[2], 0) // B
    assert.equal(data[3], 128) // A = 0x80
  })
})

const totalTests = 22
console.log(`\n--- spriteUtils.test.ts: ${totalTests} tests defined ---`)

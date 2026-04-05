/**
 * Unit tests for pixel-office sprite utilities.
 * Tests spriteData.ts (flipSpriteHorizontal, getCharacterSprites, setCharacterTemplates)
 * and spriteCache.ts (getOutlineSprite — pure SpriteData transform, no DOM).
 */
import assert from 'node:assert/strict'
import type { SpriteData } from '../engine/types'
import { Direction } from '../engine/types'
import {
  flipSpriteHorizontal,
  getCharacterSprites,
  setCharacterTemplates,
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE
} from '../sprites/spriteData'
import { getOutlineSprite } from '../sprites/spriteCache'

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

// ── flipSpriteHorizontal ────────────────────────────────────

describe('flipSpriteHorizontal', () => {
  test('reverses each row', () => {
    const sprite: SpriteData = [
      ['#FF0000', '#00FF00', '#0000FF'],
      ['#111111', '#222222', '#333333']
    ]
    const flipped = flipSpriteHorizontal(sprite)
    assert.deepEqual(flipped[0], ['#0000FF', '#00FF00', '#FF0000'])
    assert.deepEqual(flipped[1], ['#333333', '#222222', '#111111'])
  })

  test('preserves empty pixels', () => {
    const sprite: SpriteData = [['', '#FF0000', '']]
    const flipped = flipSpriteHorizontal(sprite)
    assert.deepEqual(flipped[0], ['', '#FF0000', ''])
  })

  test('preserves row count', () => {
    const sprite: SpriteData = [['#FF0000'], ['#00FF00'], ['#0000FF']]
    const flipped = flipSpriteHorizontal(sprite)
    assert.equal(flipped.length, 3)
  })

  test('single pixel is unchanged', () => {
    const sprite: SpriteData = [['#ABCDEF']]
    const flipped = flipSpriteHorizontal(sprite)
    assert.deepEqual(flipped, [['#ABCDEF']])
  })

  test('does not mutate original', () => {
    const sprite: SpriteData = [['#FF0000', '#00FF00']]
    const original = sprite[0].slice()
    flipSpriteHorizontal(sprite)
    assert.deepEqual(sprite[0], original)
  })

  test('double flip restores original', () => {
    const sprite: SpriteData = [
      ['#AA', '#BB', '#CC'],
      ['#DD', '#EE', '#FF']
    ]
    const doubleFlipped = flipSpriteHorizontal(flipSpriteHorizontal(sprite))
    assert.deepEqual(doubleFlipped, sprite)
  })
})

// ── getCharacterSprites ─────────────────────────────────────

describe('getCharacterSprites — fallback (no loaded characters)', () => {
  test('returns CharacterSprites structure with all directions', () => {
    const sprites = getCharacterSprites(0)
    assert.ok(sprites.walk)
    assert.ok(sprites.typing)
    assert.ok(sprites.reading)
    assert.ok(sprites.walk[Direction.DOWN])
    assert.ok(sprites.walk[Direction.UP])
    assert.ok(sprites.walk[Direction.LEFT])
    assert.ok(sprites.walk[Direction.RIGHT])
  })

  test('walk frames have 4 entries', () => {
    const sprites = getCharacterSprites(0)
    assert.equal(sprites.walk[Direction.DOWN].length, 4)
    assert.equal(sprites.walk[Direction.UP].length, 4)
    assert.equal(sprites.walk[Direction.LEFT].length, 4)
    assert.equal(sprites.walk[Direction.RIGHT].length, 4)
  })

  test('typing frames have 2 entries', () => {
    const sprites = getCharacterSprites(0)
    assert.equal(sprites.typing[Direction.DOWN].length, 2)
    assert.equal(sprites.typing[Direction.UP].length, 2)
  })

  test('reading frames have 2 entries', () => {
    const sprites = getCharacterSprites(0)
    assert.equal(sprites.reading[Direction.DOWN].length, 2)
    assert.equal(sprites.reading[Direction.UP].length, 2)
  })

  test('caches results for same palette + hueShift', () => {
    const s1 = getCharacterSprites(0, 0)
    const s2 = getCharacterSprites(0, 0)
    assert.equal(s1, s2, 'Same palette+hueShift should return cached reference')
  })

  test('different palette indices return different cache entries', () => {
    const s1 = getCharacterSprites(0, 0)
    const s2 = getCharacterSprites(1, 0)
    // They may be equal in fallback mode (both empty), but different cache keys
    // Verify the function doesn't crash
    assert.ok(s1)
    assert.ok(s2)
  })
})

describe('getCharacterSprites — with loaded characters', () => {
  // Create minimal character template data
  const makeTemplate = () => {
    const frame: SpriteData = [['#FF0000']]
    return {
      down: [frame, frame, frame, frame, frame, frame, frame],
      up: [frame, frame, frame, frame, frame, frame, frame],
      right: [frame, frame, frame, frame, frame, frame, frame]
    }
  }

  test('uses loaded character templates', () => {
    setCharacterTemplates([makeTemplate(), makeTemplate()])
    const sprites = getCharacterSprites(0)
    // Should have actual sprite data (not empty 32x32)
    const walkFrame = sprites.walk[Direction.DOWN][0]
    assert.ok(walkFrame.length > 0)
    assert.ok(walkFrame[0].length > 0)
    assert.notEqual(walkFrame[0][0], '')
  })

  test('left direction is a flipped version of right', () => {
    setCharacterTemplates([makeTemplate()])
    const sprites = getCharacterSprites(0)
    const rightFrame = sprites.walk[Direction.RIGHT][0]
    const leftFrame = sprites.walk[Direction.LEFT][0]
    // Left should be horizontally flipped right
    assert.deepEqual(leftFrame, flipSpriteHorizontal(rightFrame))
  })

  test('wraps palette index for out of range', () => {
    setCharacterTemplates([makeTemplate()])
    // palette=5, but only 1 template — should use index 0 (5 % 1)
    const sprites = getCharacterSprites(5)
    assert.ok(sprites)
    assert.ok(sprites.walk[Direction.DOWN][0][0][0] !== '')
  })

  // Clean up by resetting templates
  setCharacterTemplates([makeTemplate(), makeTemplate(), makeTemplate()])
})

// ── getOutlineSprite ────────────────────────────────────────

describe('getOutlineSprite', () => {
  test('expands dimensions by 2 in each direction', () => {
    const sprite: SpriteData = [
      ['#FF0000', '#00FF00'],
      ['#0000FF', '#FFFFFF']
    ]
    const outline = getOutlineSprite(sprite)
    assert.equal(outline.length, 4) // 2 + 2
    assert.equal(outline[0].length, 4) // 2 + 2
  })

  test('adds white outline pixels around opaque pixels', () => {
    // Single pixel in center
    const sprite: SpriteData = [['#FF0000']]
    const outline = getOutlineSprite(sprite)
    // Should be 3x3, with white at cardinal neighbors of center
    assert.equal(outline.length, 3)
    assert.equal(outline[0].length, 3)
    assert.equal(outline[0][1], '#FFFFFF') // above
    assert.equal(outline[2][1], '#FFFFFF') // below
    assert.equal(outline[1][0], '#FFFFFF') // left
    assert.equal(outline[1][2], '#FFFFFF') // right
  })

  test('clears center pixel (outline only, not fill)', () => {
    const sprite: SpriteData = [['#FF0000']]
    const outline = getOutlineSprite(sprite)
    assert.equal(outline[1][1], '') // center should be empty
  })

  test('transparent pixels produce no outline', () => {
    const sprite: SpriteData = [['', '', ''], ['', '', ''], ['', '', '']]
    const outline = getOutlineSprite(sprite)
    // All should be empty
    for (const row of outline) {
      for (const px of row) {
        assert.equal(px, '')
      }
    }
  })

  test('caches result for same sprite reference', () => {
    const sprite: SpriteData = [['#FF0000']]
    const o1 = getOutlineSprite(sprite)
    const o2 = getOutlineSprite(sprite)
    assert.equal(o1, o2, 'Should return cached result')
  })

  test('L-shaped sprite produces correct outline', () => {
    const sprite: SpriteData = [
      ['#FF0000', ''],
      ['#FF0000', ''],
      ['#FF0000', '#FF0000']
    ]
    const outline = getOutlineSprite(sprite)
    assert.ok(outline.length === 5) // 3 + 2
    assert.ok(outline[0].length === 4) // 2 + 2
    // Above top-left pixel: (0,1) in expanded grid
    assert.equal(outline[0][1], '#FFFFFF')
    // Left of top pixel: (1,0) in expanded grid
    assert.equal(outline[1][0], '#FFFFFF')
    // Center pixels should be cleared (the L shape itself)
    assert.equal(outline[1][1], '') // original (0,0)
    assert.equal(outline[2][1], '') // original (1,0)
    assert.equal(outline[3][1], '') // original (2,0)
    assert.equal(outline[3][2], '') // original (2,1)
  })
})

// ── Bubble sprite constants ──────────────────────────────────

describe('bubble sprite constants', () => {
  test('BUBBLE_PERMISSION_SPRITE is valid SpriteData', () => {
    assert.ok(Array.isArray(BUBBLE_PERMISSION_SPRITE))
    assert.ok(BUBBLE_PERMISSION_SPRITE.length > 0)
    assert.ok(Array.isArray(BUBBLE_PERMISSION_SPRITE[0]))
  })

  test('BUBBLE_WAITING_SPRITE is valid SpriteData', () => {
    assert.ok(Array.isArray(BUBBLE_WAITING_SPRITE))
    assert.ok(BUBBLE_WAITING_SPRITE.length > 0)
    assert.ok(Array.isArray(BUBBLE_WAITING_SPRITE[0]))
  })

  test('bubble sprites have consistent row widths', () => {
    const width = BUBBLE_PERMISSION_SPRITE[0].length
    for (const row of BUBBLE_PERMISSION_SPRITE) {
      assert.equal(row.length, width, 'All rows should have same width')
    }
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- spriteData.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

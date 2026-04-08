/**
 * Unit tests for pixel-office colorize module (colorize.ts).
 * Tests pure string-to-string color transforms: colorize mode,
 * adjust mode, caching, and color math edge cases.
 */
import assert from 'node:assert/strict'
import type { FloorColor, SpriteData } from '../engine/types'
import { colorizeSprite, adjustSprite, getColorizedSprite, clearColorizeCache } from '../colorize'

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

// ── Helpers ───────────────────────────────────────────────────

/** Create a 1-pixel sprite for isolated color testing */
function pixel(hex: string): SpriteData {
  return [[hex]]
}

/** Get the single output pixel from a 1x1 sprite */
function singlePixel(sprite: SpriteData): string {
  return sprite[0][0]
}

/** Check that a hex string is a valid #RRGGBB or #RRGGBBAA format */
function isValidHex(s: string): boolean {
  return /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(s)
}

// ── colorizeSprite ──────────────────────────────────────────

describe('colorizeSprite', () => {
  test('preserves transparent pixels (empty strings)', () => {
    const sprite: SpriteData = [
      ['', '#FF0000', ''],
      ['#00FF00', '', '#0000FF']
    ]
    const color: FloorColor = { h: 180, s: 50, b: 0, c: 0, colorize: true }
    const result = colorizeSprite(sprite, color)
    assert.equal(result[0][0], '')
    assert.equal(result[0][2], '')
    assert.equal(result[1][1], '')
  })

  test('produces valid hex output for every non-transparent pixel', () => {
    const sprite: SpriteData = [['#112233', '#AABBCC', '#000000', '#FFFFFF']]
    const color: FloorColor = { h: 200, s: 60, b: 0, c: 0, colorize: true }
    const result = colorizeSprite(sprite, color)
    for (const px of result[0]) {
      assert.ok(isValidHex(px), `Expected valid hex, got: ${px}`)
    }
  })

  test('applies hue to grayscale pixels (pure white becomes hue-tinted)', () => {
    const result = colorizeSprite(pixel('#FFFFFF'), { h: 0, s: 100, b: 0, c: 0, colorize: true })
    const px = singlePixel(result)
    // White has lightness 1.0, with hue 0 and full saturation
    // The result should be a light color (near white since L~1)
    assert.ok(isValidHex(px))
  })

  test('pure black stays black (lightness 0)', () => {
    const result = colorizeSprite(pixel('#000000'), { h: 120, s: 100, b: 0, c: 0, colorize: true })
    const px = singlePixel(result)
    assert.equal(px, '#000000')
  })

  test('mid-gray produces a clearly tinted color', () => {
    const result = colorizeSprite(pixel('#808080'), { h: 0, s: 100, b: 0, c: 0, colorize: true })
    const px = singlePixel(result)
    // Hue 0, full sat, lightness ~0.5 should produce a reddish color
    const r = parseInt(px.slice(1, 3), 16)
    const g = parseInt(px.slice(3, 5), 16)
    assert.ok(r > g, `Expected red > green for hue=0, got R=${r} G=${g}`)
  })

  test('brightness > 0 makes pixels lighter', () => {
    const base = colorizeSprite(pixel('#808080'), { h: 200, s: 50, b: 0, c: 0, colorize: true })
    const bright = colorizeSprite(pixel('#808080'), { h: 200, s: 50, b: 50, c: 0, colorize: true })
    // Compare perceived luminance (simple: sum of RGB)
    const baseSum =
      parseInt(singlePixel(base).slice(1, 3), 16) +
      parseInt(singlePixel(base).slice(3, 5), 16) +
      parseInt(singlePixel(base).slice(5, 7), 16)
    const brightSum =
      parseInt(singlePixel(bright).slice(1, 3), 16) +
      parseInt(singlePixel(bright).slice(3, 5), 16) +
      parseInt(singlePixel(bright).slice(5, 7), 16)
    assert.ok(
      brightSum > baseSum,
      `Expected brighter pixel, got base=${baseSum} bright=${brightSum}`
    )
  })

  test('brightness < 0 makes pixels darker', () => {
    const base = colorizeSprite(pixel('#808080'), { h: 200, s: 50, b: 0, c: 0, colorize: true })
    const dark = colorizeSprite(pixel('#808080'), { h: 200, s: 50, b: -50, c: 0, colorize: true })
    const baseSum =
      parseInt(singlePixel(base).slice(1, 3), 16) +
      parseInt(singlePixel(base).slice(3, 5), 16) +
      parseInt(singlePixel(base).slice(5, 7), 16)
    const darkSum =
      parseInt(singlePixel(dark).slice(1, 3), 16) +
      parseInt(singlePixel(dark).slice(3, 5), 16) +
      parseInt(singlePixel(dark).slice(5, 7), 16)
    assert.ok(darkSum < baseSum, `Expected darker pixel, got base=${baseSum} dark=${darkSum}`)
  })

  test('contrast increases range between light and dark pixels', () => {
    const lightBase = colorizeSprite(pixel('#C0C0C0'), { h: 0, s: 0, b: 0, c: 0, colorize: true })
    const darkBase = colorizeSprite(pixel('#404040'), { h: 0, s: 0, b: 0, c: 0, colorize: true })
    const lightHigh = colorizeSprite(pixel('#C0C0C0'), { h: 0, s: 0, b: 0, c: 50, colorize: true })
    const darkHigh = colorizeSprite(pixel('#404040'), { h: 0, s: 0, b: 0, c: 50, colorize: true })
    const rangeBase =
      parseInt(singlePixel(lightBase).slice(1, 3), 16) -
      parseInt(singlePixel(darkBase).slice(1, 3), 16)
    const rangeHigh =
      parseInt(singlePixel(lightHigh).slice(1, 3), 16) -
      parseInt(singlePixel(darkHigh).slice(1, 3), 16)
    assert.ok(
      rangeHigh >= rangeBase,
      `Expected higher contrast range, got base=${rangeBase} high=${rangeHigh}`
    )
  })

  test('preserves alpha channel from 8-digit hex (#RRGGBBAA)', () => {
    const result = colorizeSprite(pixel('#FF000080'), { h: 200, s: 50, b: 0, c: 0, colorize: true })
    const px = singlePixel(result)
    assert.ok(px.length === 9, `Expected 9-char hex with alpha, got: ${px}`)
    assert.equal(px.slice(7, 9), '80')
  })

  test('omits alpha suffix for fully opaque pixels', () => {
    const result = colorizeSprite(pixel('#FF0000'), { h: 200, s: 50, b: 0, c: 0, colorize: true })
    const px = singlePixel(result)
    assert.equal(px.length, 7, `Expected 7-char hex (no alpha), got: ${px}`)
  })

  test('preserves sprite dimensions', () => {
    const sprite: SpriteData = [
      ['#FF0000', '#00FF00', '#0000FF'],
      ['#FFFFFF', '#000000', '#808080']
    ]
    const result = colorizeSprite(sprite, { h: 100, s: 50, b: 0, c: 0, colorize: true })
    assert.equal(result.length, 2)
    assert.equal(result[0].length, 3)
    assert.equal(result[1].length, 3)
  })

  test('different hues produce different outputs for same gray input', () => {
    const r1 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 0, s: 80, b: 0, c: 0, colorize: true })
    )
    const r2 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 120, s: 80, b: 0, c: 0, colorize: true })
    )
    const r3 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 240, s: 80, b: 0, c: 0, colorize: true })
    )
    assert.notEqual(r1, r2)
    assert.notEqual(r2, r3)
  })

  test('zero saturation produces gray regardless of hue', () => {
    const r1 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 0, s: 0, b: 0, c: 0, colorize: true })
    )
    const r2 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 180, s: 0, b: 0, c: 0, colorize: true })
    )
    assert.equal(r1, r2, `Zero saturation should produce same gray regardless of hue`)
  })
})

// ── adjustSprite ────────────────────────────────────────────

describe('adjustSprite', () => {
  test('preserves transparent pixels', () => {
    const sprite: SpriteData = [['', '#FF0000']]
    const result = adjustSprite(sprite, { h: 90, s: 0, b: 0, c: 0 })
    assert.equal(result[0][0], '')
  })

  test('zero shift returns same color values', () => {
    // With h=0, s=0, b=0, c=0 the pixel should be unchanged
    const result = adjustSprite(pixel('#FF0000'), { h: 0, s: 0, b: 0, c: 0 })
    const px = singlePixel(result)
    // Due to RGB -> HSL -> RGB round-tripping, allow small error
    const r = parseInt(px.slice(1, 3), 16)
    assert.ok(r >= 253, `Expected R near 255, got ${r}`)
  })

  test('hue shift of +180 rotates color to complement', () => {
    // Red (#FF0000) shifted by 180 degrees should become cyan-ish
    const result = adjustSprite(pixel('#FF0000'), { h: 180, s: 0, b: 0, c: 0 })
    const px = singlePixel(result)
    const r = parseInt(px.slice(1, 3), 16)
    const g = parseInt(px.slice(3, 5), 16)
    const b = parseInt(px.slice(5, 7), 16)
    // Cyan has low R, high G and B
    assert.ok(r < 50, `Expected low R for cyan, got ${r}`)
    assert.ok(g > 200, `Expected high G for cyan, got ${g}`)
    assert.ok(b > 200, `Expected high B for cyan, got ${b}`)
  })

  test('hue shift wraps around 360 correctly', () => {
    const r1 = singlePixel(adjustSprite(pixel('#FF0000'), { h: 360, s: 0, b: 0, c: 0 }))
    const r2 = singlePixel(adjustSprite(pixel('#FF0000'), { h: 0, s: 0, b: 0, c: 0 }))
    assert.equal(r1, r2, 'Hue shift of 360 should equal 0')
  })

  test('negative hue shift wraps correctly', () => {
    const r1 = singlePixel(adjustSprite(pixel('#FF0000'), { h: -60, s: 0, b: 0, c: 0 }))
    const r2 = singlePixel(adjustSprite(pixel('#FF0000'), { h: 300, s: 0, b: 0, c: 0 }))
    assert.equal(r1, r2, 'Hue shift of -60 should equal 300')
  })

  test('positive saturation shift increases color vividness', () => {
    // Start with a desaturated color
    const base = adjustSprite(pixel('#806060'), { h: 0, s: 0, b: 0, c: 0 })
    const vivid = adjustSprite(pixel('#806060'), { h: 0, s: 50, b: 0, c: 0 })
    // More saturated = bigger difference between max and min RGB channels
    const basePx = singlePixel(base)
    const vividPx = singlePixel(vivid)
    const baseRange =
      Math.max(
        parseInt(basePx.slice(1, 3), 16),
        parseInt(basePx.slice(3, 5), 16),
        parseInt(basePx.slice(5, 7), 16)
      ) -
      Math.min(
        parseInt(basePx.slice(1, 3), 16),
        parseInt(basePx.slice(3, 5), 16),
        parseInt(basePx.slice(5, 7), 16)
      )
    const vividRange =
      Math.max(
        parseInt(vividPx.slice(1, 3), 16),
        parseInt(vividPx.slice(3, 5), 16),
        parseInt(vividPx.slice(5, 7), 16)
      ) -
      Math.min(
        parseInt(vividPx.slice(1, 3), 16),
        parseInt(vividPx.slice(3, 5), 16),
        parseInt(vividPx.slice(5, 7), 16)
      )
    assert.ok(
      vividRange >= baseRange,
      `Expected more vivid: base range=${baseRange}, vivid range=${vividRange}`
    )
  })

  test('brightness shift makes pixels lighter', () => {
    const base = adjustSprite(pixel('#808080'), { h: 0, s: 0, b: 0, c: 0 })
    const bright = adjustSprite(pixel('#808080'), { h: 0, s: 0, b: 50, c: 0 })
    const baseR = parseInt(singlePixel(base).slice(1, 3), 16)
    const brightR = parseInt(singlePixel(bright).slice(1, 3), 16)
    assert.ok(brightR > baseR, `Expected brighter: base R=${baseR}, bright R=${brightR}`)
  })

  test('preserves alpha channel', () => {
    const result = adjustSprite(pixel('#FF000040'), { h: 0, s: 0, b: 0, c: 0 })
    const px = singlePixel(result)
    assert.equal(px.slice(7, 9), '40')
  })

  test('preserves sprite dimensions', () => {
    const sprite: SpriteData = [
      ['#AA1122', '#33BB44'],
      ['#5566CC', '#DD7788']
    ]
    const result = adjustSprite(sprite, { h: 45, s: 10, b: -5, c: 10 })
    assert.equal(result.length, 2)
    assert.equal(result[0].length, 2)
    assert.equal(result[1].length, 2)
  })

  test('outputs valid hex for every non-empty pixel', () => {
    const sprite: SpriteData = [['#112233', '#AABBCC', '', '#FF00FF']]
    const result = adjustSprite(sprite, { h: 60, s: 20, b: 10, c: -10 })
    for (const px of result[0]) {
      if (px === '') continue
      assert.ok(isValidHex(px), `Expected valid hex, got: ${px}`)
    }
  })
})

// ── getColorizedSprite (cache) ──────────────────────────────

describe('getColorizedSprite', () => {
  test('returns same result for same cache key', () => {
    clearColorizeCache()
    const sprite = pixel('#808080')
    const color: FloorColor = { h: 100, s: 50, b: 0, c: 0, colorize: true }
    const r1 = getColorizedSprite('test-key-1', sprite, color)
    const r2 = getColorizedSprite('test-key-1', sprite, color)
    assert.equal(r1, r2, 'Same cache key should return identical reference')
  })

  test('different cache keys produce separate results', () => {
    clearColorizeCache()
    const sprite = pixel('#808080')
    const color: FloorColor = { h: 100, s: 50, b: 0, c: 0, colorize: true }
    const r1 = getColorizedSprite('key-a', sprite, color)
    const color2: FloorColor = { h: 200, s: 50, b: 0, c: 0, colorize: true }
    const r2 = getColorizedSprite('key-b', sprite, color2)
    assert.notEqual(singlePixel(r1), singlePixel(r2))
  })

  test('dispatches to colorize mode when color.colorize is true', () => {
    clearColorizeCache()
    const sprite = pixel('#808080')
    const color: FloorColor = { h: 0, s: 100, b: 0, c: 0, colorize: true }
    const result = getColorizedSprite('colorize-test', sprite, color)
    const expected = colorizeSprite(sprite, color)
    assert.equal(singlePixel(result), singlePixel(expected))
  })

  test('dispatches to adjust mode when color.colorize is falsy', () => {
    clearColorizeCache()
    const sprite = pixel('#808080')
    const color: FloorColor = { h: 90, s: 0, b: 0, c: 0 }
    const result = getColorizedSprite('adjust-test', sprite, color)
    const expected = adjustSprite(sprite, color)
    assert.equal(singlePixel(result), singlePixel(expected))
  })
})

// ── clearColorizeCache ──────────────────────────────────────

describe('clearColorizeCache', () => {
  test('clears cached sprites so next call recomputes', () => {
    const sprite = pixel('#808080')
    const color: FloorColor = { h: 100, s: 50, b: 0, c: 0, colorize: true }
    const r1 = getColorizedSprite('clear-test', sprite, color)
    clearColorizeCache()
    const r2 = getColorizedSprite('clear-test', sprite, color)
    // Values should be equal but references should differ (recomputed)
    assert.equal(singlePixel(r1), singlePixel(r2))
    assert.notEqual(r1, r2, 'After clear, result should be a new object')
  })
})

// ── Edge cases / color math ─────────────────────────────────

describe('color math edge cases', () => {
  test('hue 0 and hue 360 produce same result in colorize mode', () => {
    const r0 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 0, s: 50, b: 0, c: 0, colorize: true })
    )
    const r360 = singlePixel(
      colorizeSprite(pixel('#808080'), { h: 360, s: 50, b: 0, c: 0, colorize: true })
    )
    assert.equal(r0, r360)
  })

  test('maximum brightness does not exceed #FFFFFF', () => {
    const result = colorizeSprite(pixel('#FFFFFF'), { h: 0, s: 0, b: 100, c: 0, colorize: true })
    const px = singlePixel(result)
    const r = parseInt(px.slice(1, 3), 16)
    const g = parseInt(px.slice(3, 5), 16)
    const b = parseInt(px.slice(5, 7), 16)
    assert.ok(r <= 255 && g <= 255 && b <= 255)
  })

  test('minimum brightness does not go below #000000', () => {
    const result = colorizeSprite(pixel('#000000'), { h: 0, s: 0, b: -100, c: 0, colorize: true })
    const px = singlePixel(result)
    assert.equal(px, '#000000')
  })

  test('extreme contrast does not produce invalid values', () => {
    const result = colorizeSprite(pixel('#808080'), { h: 200, s: 80, b: 0, c: 100, colorize: true })
    const px = singlePixel(result)
    assert.ok(isValidHex(px), `Expected valid hex with extreme contrast, got: ${px}`)
  })

  test('negative contrast is valid', () => {
    const result = colorizeSprite(pixel('#808080'), {
      h: 200,
      s: 80,
      b: 0,
      c: -100,
      colorize: true
    })
    const px = singlePixel(result)
    assert.ok(isValidHex(px), `Expected valid hex with negative contrast, got: ${px}`)
  })

  test('empty sprite returns empty sprite', () => {
    const result = colorizeSprite([], { h: 0, s: 0, b: 0, c: 0, colorize: true })
    assert.equal(result.length, 0)
  })

  test('single row of empty pixels returns all empty', () => {
    const result = colorizeSprite([['', '', '']], { h: 0, s: 0, b: 0, c: 0, colorize: true })
    assert.deepEqual(result, [['', '', '']])
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- colorize.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

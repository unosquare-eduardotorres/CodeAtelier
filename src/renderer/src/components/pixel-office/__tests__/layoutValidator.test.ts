/**
 * Unit tests for layout schema validation (layout/layoutValidator.ts).
 */
import assert from 'node:assert/strict'
import { TileType } from '../engine/types'
import type { OfficeLayout } from '../engine/types'
import { validateLayout, validateLayoutOrNull } from '../layout/layoutValidator'

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

// ── Fixtures ───────────────────────────────────────────────

function validLayout(): OfficeLayout {
  return {
    version: 1,
    cols: 3,
    rows: 2,
    tiles: [
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.FLOOR_1,
      TileType.WALL
    ],
    furniture: [{ uid: 'f1', type: 'DESK', col: 1, row: 1 }]
  }
}

// ── validateLayout — valid cases ────────────────────────────

describe('validateLayout — valid layouts', () => {
  test('accepts a valid layout', () => {
    const result = validateLayout(validLayout())
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
    assert.ok(result.layout)
  })

  test('accepts layout with no furniture', () => {
    const layout = { ...validLayout(), furniture: [] }
    const result = validateLayout(layout)
    assert.equal(result.valid, true)
  })

  test('accepts layout with tileColors', () => {
    const layout = {
      ...validLayout(),
      tileColors: [null, null, null, null, { h: 0, s: 0, b: 0, c: 0 }, null]
    }
    const result = validateLayout(layout)
    assert.equal(result.valid, true)
  })

  test('accepts layout with VOID tiles', () => {
    const layout = {
      ...validLayout(),
      tiles: [
        TileType.VOID,
        TileType.WALL,
        TileType.VOID,
        TileType.WALL,
        TileType.FLOOR_1,
        TileType.WALL
      ]
    }
    const result = validateLayout(layout)
    assert.equal(result.valid, true)
  })

  test('accepts all valid floor types', () => {
    const layout = {
      version: 1,
      cols: 9,
      rows: 1,
      tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      furniture: [],
      layoutRevision: 1
    }
    const result = validateLayout(layout)
    assert.equal(result.valid, true)
  })
})

// ── validateLayout — invalid cases ──────────────────────────

describe('validateLayout — invalid inputs', () => {
  test('rejects null', () => {
    const result = validateLayout(null)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
  })

  test('rejects undefined', () => {
    const result = validateLayout(undefined)
    assert.equal(result.valid, false)
  })

  test('rejects string', () => {
    const result = validateLayout('not a layout')
    assert.equal(result.valid, false)
  })

  test('rejects number', () => {
    const result = validateLayout(42)
    assert.equal(result.valid, false)
  })

  test('rejects empty object', () => {
    const result = validateLayout({})
    assert.equal(result.valid, false)
    assert.ok(result.errors.length >= 2) // missing tiles and furniture
  })
})

describe('validateLayout — field validation', () => {
  test('rejects missing version', () => {
    const layout = validLayout() as any
    delete layout.version
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('version')))
  })

  test('rejects version 0', () => {
    const layout = { ...validLayout(), version: 0 }
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
  })

  test('rejects missing cols', () => {
    const layout = validLayout() as any
    delete layout.cols
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
  })

  test('rejects non-integer cols', () => {
    const layout = { ...validLayout(), cols: 3.5 }
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
  })

  test('rejects missing tiles', () => {
    const layout = validLayout() as any
    delete layout.tiles
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.equal(result.layout, null)
  })

  test('rejects missing furniture', () => {
    const layout = validLayout() as any
    delete layout.furniture
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.equal(result.layout, null)
  })

  test('rejects tile array length mismatch', () => {
    const layout = { ...validLayout(), tiles: [0, 1, 0] } // 3 tiles but cols*rows = 6
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('length')))
  })

  test('rejects invalid tile values', () => {
    const layout = { ...validLayout(), tiles: [0, 0, 0, 0, 999, 0] }
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('invalid TileType')))
  })

  test('rejects duplicate furniture UIDs', () => {
    const layout = {
      ...validLayout(),
      furniture: [
        { uid: 'dup', type: 'A', col: 1, row: 1 },
        { uid: 'dup', type: 'B', col: 2, row: 1 }
      ]
    }
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('duplicate')))
  })

  test('rejects tileColors length mismatch', () => {
    const layout = {
      ...validLayout(),
      tileColors: [null, null] // should be 6 to match tiles
    }
    const result = validateLayout(layout)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('tileColors')))
  })
})

// ── validateLayoutOrNull ────────────────────────────────────

describe('validateLayoutOrNull', () => {
  test('returns layout for valid input', () => {
    const layout = validateLayoutOrNull(validLayout())
    assert.ok(layout)
    assert.equal(layout!.cols, 3)
  })

  test('returns null for invalid input', () => {
    assert.equal(validateLayoutOrNull(null), null)
    assert.equal(validateLayoutOrNull({}), null)
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- layoutValidator.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

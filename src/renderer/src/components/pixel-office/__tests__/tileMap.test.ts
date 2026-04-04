/**
 * Unit tests for pixel-office pathfinding and tile walkability (layout/tileMap.ts).
 * Tests BFS pathfinding correctness, edge cases, and walkability checks.
 */
import assert from 'node:assert/strict'
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap'
import { TileType } from '../engine/types'
import type { TileType as TileTypeVal } from '../engine/types'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── Fixtures ──────────────────────────────────────────────

/** 5x5 grid: wall border, floor interior */
function makeGrid(): TileTypeVal[][] {
  return [
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0]
  ] as TileTypeVal[][]
}

/** 5x5 grid with a wall barrier cutting the floor in half */
function makeGridWithBarrier(): TileTypeVal[][] {
  return [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0]
  ] as TileTypeVal[][]
}

// ── isWalkable ──────────────────────────────────────────────

describe('isWalkable', () => {
  test('returns true for floor tile', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(1, 1, grid, new Set()), true)
  })

  test('returns false for wall tile', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(0, 0, grid, new Set()), false)
  })

  test('returns false for void tile', () => {
    const grid: TileTypeVal[][] = [[255 as TileTypeVal]]
    assert.equal(isWalkable(0, 0, grid, new Set()), false)
  })

  test('returns false for out-of-bounds (negative col)', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(-1, 1, grid, new Set()), false)
  })

  test('returns false for out-of-bounds (col >= cols)', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(5, 1, grid, new Set()), false)
  })

  test('returns false for out-of-bounds (negative row)', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(1, -1, grid, new Set()), false)
  })

  test('returns false for out-of-bounds (row >= rows)', () => {
    const grid = makeGrid()
    assert.equal(isWalkable(1, 5, grid, new Set()), false)
  })

  test('returns false for blocked tile', () => {
    const grid = makeGrid()
    const blocked = new Set(['1,1'])
    assert.equal(isWalkable(1, 1, grid, blocked), false)
  })

  test('returns true for unblocked floor tile', () => {
    const grid = makeGrid()
    const blocked = new Set(['2,2'])
    assert.equal(isWalkable(1, 1, grid, blocked), true)
  })

  test('handles all floor types (FLOOR_1 through FLOOR_9)', () => {
    for (let ft = 1; ft <= 9; ft++) {
      const grid: TileTypeVal[][] = [[ft as TileTypeVal]]
      assert.equal(isWalkable(0, 0, grid, new Set()), true, `FLOOR_${ft} should be walkable`)
    }
  })
})

// ── getWalkableTiles ────────────────────────────────────────

describe('getWalkableTiles', () => {
  test('returns only floor tiles from 5x5 grid', () => {
    const grid = makeGrid()
    const tiles = getWalkableTiles(grid, new Set())
    // 3x3 interior = 9 walkable tiles
    assert.equal(tiles.length, 9)
  })

  test('excludes blocked tiles', () => {
    const grid = makeGrid()
    const blocked = new Set(['1,1', '2,2'])
    const tiles = getWalkableTiles(grid, blocked)
    assert.equal(tiles.length, 7)
    assert.ok(!tiles.some((t) => t.col === 1 && t.row === 1))
    assert.ok(!tiles.some((t) => t.col === 2 && t.row === 2))
  })

  test('returns empty for all-wall grid', () => {
    const grid: TileTypeVal[][] = [
      [0, 0],
      [0, 0]
    ] as TileTypeVal[][]
    const tiles = getWalkableTiles(grid, new Set())
    assert.equal(tiles.length, 0)
  })

  test('returns empty for empty grid', () => {
    const grid: TileTypeVal[][] = []
    const tiles = getWalkableTiles(grid, new Set())
    assert.equal(tiles.length, 0)
  })
})

// ── findPath ──────────────────────────────────────────────

describe('findPath', () => {
  test('returns empty array when start equals end', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 1, 1, grid, new Set())
    assert.equal(path.length, 0)
  })

  test('finds straight horizontal path', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 3, 1, grid, new Set())
    assert.ok(path.length > 0)
    // Path should not include start, should end at destination
    assert.equal(path[path.length - 1].col, 3)
    assert.equal(path[path.length - 1].row, 1)
    // Optimal: 2 steps (1,1) → (2,1) → (3,1)
    assert.equal(path.length, 2)
  })

  test('finds straight vertical path', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 1, 3, grid, new Set())
    assert.ok(path.length > 0)
    assert.equal(path[path.length - 1].col, 1)
    assert.equal(path[path.length - 1].row, 3)
    assert.equal(path.length, 2)
  })

  test('finds path around blocked tile', () => {
    const grid = makeGrid()
    const blocked = new Set(['2,1']) // block middle of top row
    const path = findPath(1, 1, 3, 1, grid, blocked)
    assert.ok(path.length > 0)
    // Should go around: (1,1) → (1,2) → (2,2) → (3,2) → (3,1) or similar
    assert.equal(path[path.length - 1].col, 3)
    assert.equal(path[path.length - 1].row, 1)
    // Path should be longer than 2 (straight is blocked)
    assert.ok(path.length > 2)
    // Path should not pass through blocked tile
    assert.ok(!path.some((p) => p.col === 2 && p.row === 1))
  })

  test('returns empty when end is a wall', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 0, 0, grid, new Set())
    assert.equal(path.length, 0)
  })

  test('returns empty when end is blocked', () => {
    const grid = makeGrid()
    const blocked = new Set(['3,1'])
    const path = findPath(1, 1, 3, 1, grid, blocked)
    assert.equal(path.length, 0)
  })

  test('returns empty when no path exists (barrier)', () => {
    const grid = makeGridWithBarrier()
    const path = findPath(1, 1, 3, 1, grid, new Set())
    assert.equal(path.length, 0)
  })

  test('finds shortest path (BFS guarantees)', () => {
    const grid = makeGrid()
    // (1,1) to (3,3) — shortest is 4 steps (Manhattan distance)
    const path = findPath(1, 1, 3, 3, grid, new Set())
    assert.equal(path.length, 4)
  })

  test('path excludes start tile', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 2, 1, grid, new Set())
    assert.ok(path.length > 0)
    // First step should NOT be the start
    assert.ok(!(path[0].col === 1 && path[0].row === 1))
  })

  test('path includes end tile', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 2, 2, grid, new Set())
    assert.ok(path.length > 0)
    assert.equal(path[path.length - 1].col, 2)
    assert.equal(path[path.length - 1].row, 2)
  })

  test('returns empty when end is out of bounds', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 10, 10, grid, new Set())
    assert.equal(path.length, 0)
  })

  test('adjacent tiles produce single-step path', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 2, 1, grid, new Set())
    assert.equal(path.length, 1)
    assert.equal(path[0].col, 2)
    assert.equal(path[0].row, 1)
  })

  test('no diagonal movement (4-connected grid)', () => {
    const grid = makeGrid()
    const path = findPath(1, 1, 2, 2, grid, new Set())
    // Each step should change either col OR row, not both
    let prev = { col: 1, row: 1 }
    for (const step of path) {
      const dc = Math.abs(step.col - prev.col)
      const dr = Math.abs(step.row - prev.row)
      assert.ok(dc + dr === 1, `Step from (${prev.col},${prev.row}) to (${step.col},${step.row}) is not 4-connected`)
      prev = step
    }
  })
})

// ── Report ──────────────────────────────────────────────

console.log(`\n─── tileMap.test.ts: ${passed} passed, ${failed} failed ───`)
if (failed > 0) process.exit(1)

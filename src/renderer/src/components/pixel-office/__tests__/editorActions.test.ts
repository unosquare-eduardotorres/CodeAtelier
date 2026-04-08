/**
 * Unit tests for pixel-office editor actions (editor/editorActions.ts).
 * Tests pure layout transformations: paint, place, remove, move, rotate,
 * toggle, canPlace validation, and grid expansion.
 */
import assert from 'node:assert/strict'
import type { FloorColor, OfficeLayout, PlacedFurniture, SpriteData } from '../engine/types'
import { EditTool, MAX_COLS, MAX_ROWS, TileType } from '../engine/types'
import {
  paintTile,
  placeFurniture,
  removeFurniture,
  moveFurniture,
  rotateFurniture,
  toggleFurnitureState,
  canPlaceFurniture,
  findFurnitureAtTile,
  resolveTilePaintAction,
  resolveWallPaintAction,
  resolveEraseAction,
  resolveEyedropperAction,
  resolveFurniturePlacement,
  expandLayout,
  getWallPlacementRow
} from '../editor/editorActions'
import { buildDynamicCatalog } from '../layout/furnitureCatalog'
import type { LoadedAssetData } from '../layout/furnitureCatalog'

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

function simpleSprite(w: number, h: number): SpriteData {
  const rows: string[][] = []
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill('#FFFFFF'))
  }
  return rows
}

/** Build test catalog with desk (2x1), chair (1x1 with rotation), plant (1x1), PC with on/off states */
function buildTestCatalog(): void {
  const assets: LoadedAssetData = {
    catalog: [
      {
        id: 'ED_DESK',
        label: 'Desk',
        category: 'desks',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: true
      },
      {
        id: 'ED_CHAIR_FRONT',
        label: 'Chair - Front',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'ed-chair',
        orientation: 'front'
      },
      {
        id: 'ED_CHAIR_BACK',
        label: 'Chair - Back',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'ed-chair',
        orientation: 'back'
      },
      {
        id: 'ED_PLANT',
        label: 'Plant',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false
      },
      {
        id: 'ED_PC_OFF',
        label: 'PC - Front - Off',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'ed-pc',
        orientation: 'front',
        state: 'off',
        canPlaceOnSurfaces: true
      },
      {
        id: 'ED_PC_ON',
        label: 'PC - Front - On',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'ed-pc',
        orientation: 'front',
        state: 'on',
        canPlaceOnSurfaces: true
      },
      {
        id: 'ED_WALL_ART',
        label: 'Wall Art',
        category: 'wall',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
        canPlaceOnWalls: true
      }
    ],
    sprites: {
      ED_DESK: simpleSprite(32, 16),
      ED_CHAIR_FRONT: simpleSprite(16, 16),
      ED_CHAIR_BACK: simpleSprite(16, 16),
      ED_PLANT: simpleSprite(16, 16),
      ED_PC_OFF: simpleSprite(16, 16),
      ED_PC_ON: simpleSprite(16, 16),
      ED_WALL_ART: simpleSprite(16, 32)
    }
  }
  buildDynamicCatalog(assets)
}

buildTestCatalog()

/** 5x5 layout: wall border, floor interior */
function make5x5Layout(): OfficeLayout {
  const cols = 5
  const rows = 5
  const tiles: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        tiles.push(TileType.WALL)
      } else {
        tiles.push(TileType.FLOOR_1)
      }
    }
  }
  return { version: 1, cols, rows, tiles: tiles as any, furniture: [] }
}

// ── paintTile ──────────────────────────────────────────────

describe('paintTile', () => {
  test('changes tile type at specified position', () => {
    const layout = make5x5Layout()
    const result = paintTile(layout, 2, 2, TileType.FLOOR_3)
    const idx = 2 * 5 + 2
    assert.equal(result.tiles[idx], TileType.FLOOR_3)
  })

  test('returns immutable copy (original unchanged)', () => {
    const layout = make5x5Layout()
    const result = paintTile(layout, 2, 2, TileType.FLOOR_3)
    assert.notEqual(result, layout)
    assert.notEqual(result.tiles, layout.tiles)
  })

  test('returns same layout if tile unchanged', () => {
    const layout = make5x5Layout()
    // Tile at (0,0) is already WALL
    const result = paintTile(layout, 0, 0, TileType.WALL)
    assert.equal(result, layout, 'Should return same reference when no change')
  })

  test('out of bounds returns layout unchanged', () => {
    const layout = make5x5Layout()
    assert.equal(paintTile(layout, -1, 0, TileType.FLOOR_1), layout)
    assert.equal(paintTile(layout, 0, 99, TileType.FLOOR_1), layout)
  })

  test('applies custom color', () => {
    const layout = make5x5Layout()
    const color: FloorColor = { h: 42, s: 50, b: -10, c: 5 }
    const result = paintTile(layout, 2, 2, TileType.FLOOR_2, color)
    const idx = 2 * 5 + 2
    assert.ok(result.tileColors)
    assert.deepEqual(result.tileColors![idx], color)
  })

  test('wall paint sets null color', () => {
    const layout = make5x5Layout()
    const result = paintTile(layout, 2, 2, TileType.WALL)
    const idx = 2 * 5 + 2
    assert.ok(result.tileColors)
    assert.equal(result.tileColors![idx], null)
  })

  test('VOID paint sets null color', () => {
    const layout = make5x5Layout()
    const result = paintTile(layout, 2, 2, TileType.VOID)
    const idx = 2 * 5 + 2
    assert.ok(result.tileColors)
    assert.equal(result.tileColors![idx], null)
  })
})

// ── placeFurniture ─────────────────────────────────────────

describe('placeFurniture', () => {
  test('adds furniture to layout', () => {
    const layout = make5x5Layout()
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 }
    const result = placeFurniture(layout, item)
    assert.equal(result.furniture.length, 1)
    assert.equal(result.furniture[0].uid, 'f1')
  })

  test('returns immutable copy', () => {
    const layout = make5x5Layout()
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 }
    const result = placeFurniture(layout, item)
    assert.notEqual(result, layout)
    assert.notEqual(result.furniture, layout.furniture)
  })

  test('rejects placement on wall tiles', () => {
    const layout = make5x5Layout()
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_PLANT', col: 0, row: 0 }
    const result = placeFurniture(layout, item)
    assert.equal(result.furniture.length, 0, 'Should not place on wall')
  })

  test('rejects out of bounds placement', () => {
    const layout = make5x5Layout()
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_PLANT', col: 5, row: 2 }
    const result = placeFurniture(layout, item)
    assert.equal(result.furniture.length, 0)
  })

  test('rejects overlapping placement', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    // Try to place on same tile
    const result = placeFurniture(layout, { uid: 'f2', type: 'ED_PLANT', col: 2, row: 2 })
    assert.equal(result.furniture.length, 1, 'Should reject overlap')
  })

  test('allows multi-tile furniture that fits', () => {
    const layout = make5x5Layout()
    // ED_DESK is 2x1, placing at (1,2) uses tiles (1,2) and (2,2)
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_DESK', col: 1, row: 2 }
    const result = placeFurniture(layout, item)
    assert.equal(result.furniture.length, 1)
  })

  test('rejects multi-tile furniture that overflows bounds', () => {
    const layout = make5x5Layout()
    // ED_DESK is 2x1, placing at (4,2) would overflow (col 4 + width 2 = 6 > 5)
    const item: PlacedFurniture = { uid: 'f1', type: 'ED_DESK', col: 4, row: 2 }
    const result = placeFurniture(layout, item)
    assert.equal(result.furniture.length, 0)
  })
})

// ── removeFurniture ─────────────────────────────────────────

describe('removeFurniture', () => {
  test('removes furniture by uid', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = removeFurniture(layout, 'f1')
    assert.equal(result.furniture.length, 0)
  })

  test('returns same layout if uid not found', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = removeFurniture(layout, 'nonexistent')
    assert.equal(result, layout)
  })

  test('only removes target, preserves others', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 1, row: 1 })
    layout = placeFurniture(layout, { uid: 'f2', type: 'ED_PLANT', col: 3, row: 3 })
    const result = removeFurniture(layout, 'f1')
    assert.equal(result.furniture.length, 1)
    assert.equal(result.furniture[0].uid, 'f2')
  })
})

// ── moveFurniture ──────────────────────────────────────────

describe('moveFurniture', () => {
  test('moves furniture to new position', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 1, row: 1 })
    const result = moveFurniture(layout, 'f1', 3, 3)
    assert.equal(result.furniture[0].col, 3)
    assert.equal(result.furniture[0].row, 3)
  })

  test('returns same layout if uid not found', () => {
    const layout = make5x5Layout()
    const result = moveFurniture(layout, 'nonexistent', 2, 2)
    assert.equal(result, layout)
  })

  test('rejects move to occupied position', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 1, row: 1 })
    layout = placeFurniture(layout, { uid: 'f2', type: 'ED_PLANT', col: 3, row: 3 })
    const result = moveFurniture(layout, 'f1', 3, 3)
    // Should not move since (3,3) is occupied by f2
    assert.equal(result, layout)
  })

  test('rejects move to wall tile', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = moveFurniture(layout, 'f1', 0, 0) // wall
    assert.equal(result, layout)
  })
})

// ── rotateFurniture ────────────────────────────────────────

describe('rotateFurniture', () => {
  test('rotates chair from front to back (cw)', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'c1', type: 'ED_CHAIR_FRONT', col: 2, row: 2 })
    const result = rotateFurniture(layout, 'c1', 'cw')
    assert.equal(result.furniture[0].type, 'ED_CHAIR_BACK')
  })

  test('rotates back to front (cw wraps)', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'c1', type: 'ED_CHAIR_BACK', col: 2, row: 2 })
    const result = rotateFurniture(layout, 'c1', 'cw')
    assert.equal(result.furniture[0].type, 'ED_CHAIR_FRONT')
  })

  test('returns same layout for non-rotatable furniture', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'p1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = rotateFurniture(layout, 'p1', 'cw')
    assert.equal(result, layout)
  })

  test('returns same layout for unknown uid', () => {
    const layout = make5x5Layout()
    const result = rotateFurniture(layout, 'nonexistent', 'cw')
    assert.equal(result, layout)
  })
})

// ── toggleFurnitureState ───────────────────────────────────

describe('toggleFurnitureState', () => {
  test('toggles PC from off to on', () => {
    let layout = make5x5Layout()
    // Place desk first (PC needs surface), then place PC on desk
    layout = placeFurniture(layout, { uid: 'd1', type: 'ED_DESK', col: 1, row: 1 })
    // Manually add PC since canPlaceOnSurfaces logic may be complex
    layout = {
      ...layout,
      furniture: [...layout.furniture, { uid: 'pc1', type: 'ED_PC_OFF', col: 1, row: 1 }]
    }
    const result = toggleFurnitureState(layout, 'pc1')
    assert.equal(result.furniture.find((f) => f.uid === 'pc1')!.type, 'ED_PC_ON')
  })

  test('toggles PC from on back to off', () => {
    let layout = make5x5Layout()
    layout = { ...layout, furniture: [{ uid: 'pc1', type: 'ED_PC_ON', col: 2, row: 2 }] }
    const result = toggleFurnitureState(layout, 'pc1')
    assert.equal(result.furniture.find((f) => f.uid === 'pc1')!.type, 'ED_PC_OFF')
  })

  test('returns same layout for non-toggleable furniture', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'p1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = toggleFurnitureState(layout, 'p1')
    assert.equal(result, layout)
  })
})

// ── canPlaceFurniture ──────────────────────────────────────

describe('canPlaceFurniture', () => {
  test('returns true for valid floor position', () => {
    const layout = make5x5Layout()
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', 2, 2), true)
  })

  test('returns false for wall position', () => {
    const layout = make5x5Layout()
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', 0, 0), false)
  })

  test('returns false for out of bounds', () => {
    const layout = make5x5Layout()
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', -1, 2), false)
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', 5, 2), false)
  })

  test('returns false for unknown furniture type', () => {
    const layout = make5x5Layout()
    assert.equal(canPlaceFurniture(layout, 'NONEXISTENT', 2, 2), false)
  })

  test('returns false when multi-tile furniture overflows', () => {
    const layout = make5x5Layout()
    // ED_DESK is 2x1, col 4 + 2 = 6 > 5
    assert.equal(canPlaceFurniture(layout, 'ED_DESK', 4, 2), false)
  })

  test('returns false on VOID tiles', () => {
    let layout = make5x5Layout()
    // Set (2,2) to VOID
    const tiles = [...layout.tiles]
    tiles[2 * 5 + 2] = TileType.VOID
    layout = { ...layout, tiles: tiles as any }
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', 2, 2), false)
  })

  test('excludeUid allows placement over own tiles', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    // Should be able to place in same spot when excluding f1 (for move operation)
    assert.equal(canPlaceFurniture(layout, 'ED_PLANT', 2, 2, 'f1'), true)
  })

  test('surface items can be placed on desk tiles', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'd1', type: 'ED_DESK', col: 1, row: 2 })
    // ED_PC_OFF has canPlaceOnSurfaces, so it should be placeable on desk tile
    assert.equal(canPlaceFurniture(layout, 'ED_PC_OFF', 1, 2), true)
  })
})

// ── getWallPlacementRow ────────────────────────────────────

describe('getWallPlacementRow', () => {
  test('offsets row for wall items', () => {
    // ED_WALL_ART has footprintH: 2 and canPlaceOnWalls
    const row = getWallPlacementRow('ED_WALL_ART', 3)
    // Should offset: row - (footprintH - 1) = 3 - 1 = 2
    assert.equal(row, 2)
  })

  test('does not offset non-wall items', () => {
    const row = getWallPlacementRow('ED_PLANT', 3)
    assert.equal(row, 3)
  })
})

// ── expandLayout ───────────────────────────────────────────

describe('expandLayout', () => {
  test('expands right by 1 column', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'right')
    assert.ok(result)
    assert.equal(result!.layout.cols, 6)
    assert.equal(result!.layout.rows, 5)
    assert.equal(result!.shift.col, 0)
    assert.equal(result!.shift.row, 0)
  })

  test('expands left by 1 column with shift', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'left')
    assert.ok(result)
    assert.equal(result!.layout.cols, 6)
    assert.equal(result!.shift.col, 1)
    assert.equal(result!.shift.row, 0)
  })

  test('expands down by 1 row', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'down')
    assert.ok(result)
    assert.equal(result!.layout.cols, 5)
    assert.equal(result!.layout.rows, 6)
  })

  test('expands up by 1 row with shift', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'up')
    assert.ok(result)
    assert.equal(result!.layout.rows, 6)
    assert.equal(result!.shift.col, 0)
    assert.equal(result!.shift.row, 1)
  })

  test('new tiles are VOID', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'right')!
    // Last column should be VOID
    for (let r = 0; r < result.layout.rows; r++) {
      const idx = r * result.layout.cols + (result.layout.cols - 1)
      assert.equal(result.layout.tiles[idx], TileType.VOID, `Row ${r} last col should be VOID`)
    }
  })

  test('preserves existing tiles', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'right')!
    // Original tiles should be preserved in their positions
    assert.equal(result.layout.tiles[0], TileType.WALL) // (0,0)
    const idx = 1 * result.layout.cols + 1
    assert.equal(result.layout.tiles[idx], TileType.FLOOR_1) // (1,1)
  })

  test('shifts furniture when expanding left', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = expandLayout(layout, 'left')!
    assert.equal(result.layout.furniture[0].col, 3) // shifted by 1
    assert.equal(result.layout.furniture[0].row, 2) // unchanged
  })

  test('shifts furniture when expanding up', () => {
    let layout = make5x5Layout()
    layout = placeFurniture(layout, { uid: 'f1', type: 'ED_PLANT', col: 2, row: 2 })
    const result = expandLayout(layout, 'up')!
    assert.equal(result.layout.furniture[0].col, 2) // unchanged
    assert.equal(result.layout.furniture[0].row, 3) // shifted by 1
  })

  test('returns null when exceeding MAX_COLS', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: MAX_COLS,
      rows: 3,
      tiles: new Array(MAX_COLS * 3).fill(TileType.FLOOR_1),
      furniture: []
    }
    const result = expandLayout(layout, 'right')
    assert.equal(result, null)
  })

  test('returns null when exceeding MAX_ROWS', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: MAX_ROWS,
      tiles: new Array(3 * MAX_ROWS).fill(TileType.FLOOR_1),
      furniture: []
    }
    const result = expandLayout(layout, 'down')
    assert.equal(result, null)
  })

  test('preserves tileColors and shifts them', () => {
    let layout = make5x5Layout()
    const color: FloorColor = { h: 42, s: 50, b: 0, c: 0 }
    layout = paintTile(layout, 2, 2, TileType.FLOOR_2, color)
    const result = expandLayout(layout, 'left')!
    // (2,2) shifted to (3,2) in the expanded layout
    const idx = 2 * result.layout.cols + 3
    assert.deepEqual(result.layout.tileColors![idx], color)
  })

  test('tile array length matches new cols * rows', () => {
    const layout = make5x5Layout()
    const result = expandLayout(layout, 'right')!
    assert.equal(result.layout.tiles.length, result.layout.cols * result.layout.rows)
  })
})

// ── findFurnitureAtTile ────────────────────────────────────

describe('findFurnitureAtTile', () => {
  test('finds 1x1 furniture at its tile', () => {
    const furniture: PlacedFurniture[] = [{ uid: 'p1', type: 'ED_PLANT', col: 2, row: 2 }]
    const hit = findFurnitureAtTile(furniture, 2, 2)
    assert.ok(hit)
    assert.equal(hit!.uid, 'p1')
  })

  test('finds multi-tile furniture within footprint', () => {
    const furniture: PlacedFurniture[] = [{ uid: 'd1', type: 'ED_DESK', col: 1, row: 2 }]
    // ED_DESK is 2x1, so (1,2) and (2,2) should both hit
    assert.ok(findFurnitureAtTile(furniture, 1, 2))
    assert.ok(findFurnitureAtTile(furniture, 2, 2))
  })

  test('returns undefined when no furniture at tile', () => {
    const furniture: PlacedFurniture[] = [{ uid: 'p1', type: 'ED_PLANT', col: 2, row: 2 }]
    assert.equal(findFurnitureAtTile(furniture, 3, 3), undefined)
  })

  test('returns undefined for empty furniture list', () => {
    assert.equal(findFurnitureAtTile([], 0, 0), undefined)
  })

  test('returns first hit when multiple items overlap (surface on desk)', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'ED_DESK', col: 1, row: 2 },
      { uid: 'pc1', type: 'ED_PC_OFF', col: 1, row: 2 }
    ]
    const hit = findFurnitureAtTile(furniture, 1, 2)
    assert.ok(hit)
    assert.equal(hit!.uid, 'd1') // first in list
  })

  test('does not match tile outside footprint', () => {
    const furniture: PlacedFurniture[] = [{ uid: 'd1', type: 'ED_DESK', col: 1, row: 2 }]
    // ED_DESK is 2x1 at (1,2), so (3,2) is outside
    assert.equal(findFurnitureAtTile(furniture, 3, 2), undefined)
    // Row below
    assert.equal(findFurnitureAtTile(furniture, 1, 3), undefined)
  })

  test('handles unknown furniture type gracefully', () => {
    const furniture: PlacedFurniture[] = [{ uid: 'x1', type: 'UNKNOWN_TYPE', col: 2, row: 2 }]
    assert.equal(findFurnitureAtTile(furniture, 2, 2), undefined)
  })
})

// ── resolveTilePaintAction ─────────────────────────────────

describe('resolveTilePaintAction', () => {
  test('returns new layout when tile changes', () => {
    const layout = make5x5Layout()
    const color: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const result = resolveTilePaintAction(layout, 2, 2, TileType.FLOOR_3, color)
    assert.ok(result)
    assert.equal(result!.tiles[2 * 5 + 2], TileType.FLOOR_3)
  })

  test('returns null when no change', () => {
    const layout = make5x5Layout()
    // Tile at (0,0) is WALL, painting WALL with no color → no change
    resolveTilePaintAction(layout, 0, 0, TileType.WALL, { h: 0, s: 0, b: 0, c: 0 })
    // paintTile returns same ref for WALL→WALL since color is null for walls
    // But we're passing a color, so paintTile adds tileColors — this IS a change
    // For a true no-op, paint a floor tile to its existing type and color
    const floorLayout = paintTile(make5x5Layout(), 2, 2, TileType.FLOOR_2, {
      h: 10,
      s: 20,
      b: 0,
      c: 0
    })
    const noChange = resolveTilePaintAction(floorLayout, 2, 2, TileType.FLOOR_2, {
      h: 10,
      s: 20,
      b: 0,
      c: 0
    })
    assert.equal(noChange, null)
  })
})

// ── resolveWallPaintAction ────────────────────────────────

describe('resolveWallPaintAction', () => {
  test('adds wall when wallDragAdding is null and tile is not wall', () => {
    const layout = make5x5Layout()
    const wallColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const fallbackColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const result = resolveWallPaintAction(
      layout,
      2,
      2,
      null,
      wallColor,
      TileType.FLOOR_1,
      fallbackColor
    )
    assert.ok(result.layout)
    assert.equal(result.wallDragAdding, true)
    assert.equal(result.layout!.tiles[2 * 5 + 2], TileType.WALL)
  })

  test('removes wall when wallDragAdding is null and tile is wall', () => {
    const layout = make5x5Layout()
    const wallColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const fallbackColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    // (0,0) is WALL in make5x5Layout
    const result = resolveWallPaintAction(
      layout,
      0,
      0,
      null,
      wallColor,
      TileType.FLOOR_1,
      fallbackColor
    )
    assert.ok(result.layout)
    assert.equal(result.wallDragAdding, false)
    assert.equal(result.layout!.tiles[0], TileType.FLOOR_1)
  })

  test('preserves wallDragAdding when already set', () => {
    const layout = make5x5Layout()
    const wallColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const fallbackColor: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
    const result = resolveWallPaintAction(
      layout,
      2,
      2,
      true,
      wallColor,
      TileType.FLOOR_1,
      fallbackColor
    )
    assert.equal(result.wallDragAdding, true)
  })
})

// ── resolveEraseAction ────────────────────────────────────

describe('resolveEraseAction', () => {
  test('erases floor tile to VOID', () => {
    const layout = make5x5Layout()
    const result = resolveEraseAction(layout, 2, 2)
    assert.ok(result)
    assert.equal(result!.tiles[2 * 5 + 2], TileType.VOID)
  })

  test('returns null for already-VOID tile', () => {
    let layout = make5x5Layout()
    // Set (2,2) to VOID
    const tiles = [...layout.tiles] as any
    tiles[2 * 5 + 2] = TileType.VOID
    layout = { ...layout, tiles }
    assert.equal(resolveEraseAction(layout, 2, 2), null)
  })

  test('returns null for out of bounds', () => {
    const layout = make5x5Layout()
    assert.equal(resolveEraseAction(layout, -1, 0), null)
    assert.equal(resolveEraseAction(layout, 0, 99), null)
  })
})

// ── resolveEyedropperAction ───────────────────────────────

describe('resolveEyedropperAction', () => {
  test('samples floor tile type and color', () => {
    let layout = make5x5Layout()
    const color: FloorColor = { h: 42, s: 50, b: 0, c: 0 }
    layout = paintTile(layout, 2, 2, TileType.FLOOR_3, color)
    const result = resolveEyedropperAction(layout, 2, 2)
    assert.ok(result)
    assert.equal(result!.tool, EditTool.TILE_PAINT)
    assert.equal(result!.tileType, TileType.FLOOR_3)
    assert.deepEqual(result!.color, color)
  })

  test('samples wall tile', () => {
    const layout = make5x5Layout()
    const result = resolveEyedropperAction(layout, 0, 0)
    assert.ok(result)
    assert.equal(result!.tool, EditTool.WALL_PAINT)
  })

  test('returns null for VOID tile', () => {
    let layout = make5x5Layout()
    const tiles = [...layout.tiles] as any
    tiles[2 * 5 + 2] = TileType.VOID
    layout = { ...layout, tiles }
    assert.equal(resolveEyedropperAction(layout, 2, 2), null)
  })
})

// ── resolveFurniturePlacement ─────────────────────────────

describe('resolveFurniturePlacement', () => {
  test('places furniture on valid floor tile', () => {
    const layout = make5x5Layout()
    const result = resolveFurniturePlacement(layout, 2, 2, 'ED_PLANT')
    assert.ok(result)
    assert.equal(result!.layout.furniture.length, 1)
    assert.equal(result!.placed.type, 'ED_PLANT')
  })

  test('returns null for invalid placement', () => {
    const layout = make5x5Layout()
    assert.equal(resolveFurniturePlacement(layout, 0, 0, 'ED_PLANT'), null) // on wall
  })

  test('applies color when provided', () => {
    const layout = make5x5Layout()
    const color: FloorColor = { h: 100, s: 50, b: 0, c: 0 }
    const result = resolveFurniturePlacement(layout, 2, 2, 'ED_PLANT', color)
    assert.ok(result)
    assert.deepEqual(result!.placed.color, color)
  })

  test('generates unique uid', () => {
    const layout = make5x5Layout()
    const r1 = resolveFurniturePlacement(layout, 1, 1, 'ED_PLANT')
    const r2 = resolveFurniturePlacement(layout, 3, 3, 'ED_PLANT')
    assert.ok(r1 && r2)
    assert.notEqual(r1!.placed.uid, r2!.placed.uid)
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- editorActions.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

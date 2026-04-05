/**
 * Unit tests for pixel-office layoutSerializer (layout/layoutSerializer.ts).
 * Tests tile map conversion, furniture instances, seats, serialization round-trip,
 * migration paths, and default layout validity.
 */
import assert from 'node:assert/strict'
import type { FloorColor, OfficeLayout, PlacedFurniture, SpriteData } from '../engine/types'
import { DEFAULT_COLS, DEFAULT_ROWS, TileType } from '../engine/types'
import {
  layoutToTileMap,
  createDefaultLayout,
  serializeLayout,
  deserializeLayout,
  migrateLayoutColors,
  getBlockedTiles,
  getPlacementBlockedTiles,
  getSeatTiles,
  layoutToSeats,
  layoutToFurnitureInstances
} from '../layout/layoutSerializer'
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

// ── Test Fixtures ──────────────────────────────────────────────

/** Small 3x3 layout: wall border + one floor tile */
function make3x3Layout(): OfficeLayout {
  return {
    version: 1,
    cols: 3,
    rows: 3,
    tiles: [
      TileType.WALL, TileType.WALL, TileType.WALL,
      TileType.WALL, TileType.FLOOR_1, TileType.WALL,
      TileType.WALL, TileType.WALL, TileType.WALL
    ],
    furniture: []
  }
}

/** 4x3 layout with mixed floor types */
function make4x3Layout(): OfficeLayout {
  return {
    version: 1,
    cols: 4,
    rows: 3,
    tiles: [
      TileType.WALL, TileType.WALL, TileType.WALL, TileType.WALL,
      TileType.WALL, TileType.FLOOR_1, TileType.FLOOR_2, TileType.WALL,
      TileType.WALL, TileType.WALL, TileType.WALL, TileType.WALL
    ],
    furniture: []
  }
}

/** Create a simple 1x1 white sprite */
function simpleSprite(w: number, h: number): SpriteData {
  const rows: string[][] = []
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill('#FFFFFF'))
  }
  return rows
}

/** Build a minimal test catalog with a desk, chair, and decor item */
function buildTestCatalog(): void {
  const assets: LoadedAssetData = {
    catalog: [
      {
        id: 'TEST_DESK',
        label: 'Test Desk',
        category: 'desks',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: true
      },
      {
        id: 'TEST_CHAIR_FRONT',
        label: 'Test Chair - Front',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'test-chair',
        orientation: 'front'
      },
      {
        id: 'TEST_CHAIR_BACK',
        label: 'Test Chair - Back',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'test-chair',
        orientation: 'back'
      },
      {
        id: 'TEST_PLANT',
        label: 'Test Plant',
        category: 'decor',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        backgroundTiles: 1
      },
      {
        id: 'TEST_SURFACE_ITEM',
        label: 'Test Surface Item',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnSurfaces: true
      }
    ],
    sprites: {
      TEST_DESK: simpleSprite(32, 16),
      TEST_CHAIR_FRONT: simpleSprite(16, 16),
      TEST_CHAIR_BACK: simpleSprite(16, 16),
      TEST_PLANT: simpleSprite(16, 32),
      TEST_SURFACE_ITEM: simpleSprite(16, 16)
    }
  }
  buildDynamicCatalog(assets)
}

// Build test catalog before running tests
buildTestCatalog()

// ── layoutToTileMap ────────────────────────────────────────

describe('layoutToTileMap', () => {
  test('converts flat tile array into 2D grid', () => {
    const layout = make3x3Layout()
    const map = layoutToTileMap(layout)
    assert.equal(map.length, 3)
    assert.equal(map[0].length, 3)
  })

  test('preserves tile values in correct positions', () => {
    const layout = make4x3Layout()
    const map = layoutToTileMap(layout)
    assert.equal(map[0][0], TileType.WALL)
    assert.equal(map[1][1], TileType.FLOOR_1)
    assert.equal(map[1][2], TileType.FLOOR_2)
    assert.equal(map[2][3], TileType.WALL)
  })

  test('handles single-cell layout', () => {
    const layout: OfficeLayout = {
      version: 1, cols: 1, rows: 1,
      tiles: [TileType.FLOOR_1], furniture: []
    }
    const map = layoutToTileMap(layout)
    assert.equal(map.length, 1)
    assert.equal(map[0].length, 1)
    assert.equal(map[0][0], TileType.FLOOR_1)
  })

  test('handles all floor types', () => {
    const layout: OfficeLayout = {
      version: 1, cols: 3, rows: 1,
      tiles: [TileType.FLOOR_1, TileType.FLOOR_5, TileType.VOID],
      furniture: []
    }
    const map = layoutToTileMap(layout)
    assert.equal(map[0][0], TileType.FLOOR_1)
    assert.equal(map[0][1], TileType.FLOOR_5)
    assert.equal(map[0][2], TileType.VOID)
  })
})

// ── getBlockedTiles ────────────────────────────────────────

describe('getBlockedTiles', () => {
  test('returns empty set for no furniture', () => {
    const blocked = getBlockedTiles([])
    assert.equal(blocked.size, 0)
  })

  test('blocks tiles under furniture footprint', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 2 }
    ]
    const blocked = getBlockedTiles(furniture)
    // TEST_DESK is 2x1 footprint
    assert.ok(blocked.has('2,2'))
    assert.ok(blocked.has('3,2'))
    assert.equal(blocked.size, 2)
  })

  test('skips background tile rows', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'p1', type: 'TEST_PLANT', col: 3, row: 3 }
    ]
    const blocked = getBlockedTiles(furniture)
    // TEST_PLANT has backgroundTiles: 1 and footprintH: 1
    // With footprintH=1 and bgRows=1, the only row (row 0) is a background row -> skipped
    assert.equal(blocked.size, 0)
  })

  test('respects excludeTiles parameter', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 2 }
    ]
    const exclude = new Set(['2,2'])
    const blocked = getBlockedTiles(furniture, exclude)
    assert.ok(!blocked.has('2,2'))
    assert.ok(blocked.has('3,2'))
  })
})

// ── getPlacementBlockedTiles ────────────────────────────────

describe('getPlacementBlockedTiles', () => {
  test('excludes furniture by uid', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 2 },
      { uid: 'c1', type: 'TEST_CHAIR_FRONT', col: 4, row: 2 }
    ]
    const blocked = getPlacementBlockedTiles(furniture, 'd1')
    // Should not include desk d1 tiles
    assert.ok(!blocked.has('2,2'))
    assert.ok(!blocked.has('3,2'))
    // Should include chair c1 tile
    assert.ok(blocked.has('4,2'))
  })
})

// ── layoutToSeats ──────────────────────────────────────────

describe('layoutToSeats', () => {
  test('returns empty map for no furniture', () => {
    const seats = layoutToSeats([])
    assert.equal(seats.size, 0)
  })

  test('creates seat for chair furniture', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'c1', type: 'TEST_CHAIR_FRONT', col: 3, row: 3 }
    ]
    const seats = layoutToSeats(furniture)
    assert.equal(seats.size, 1)
    const seat = seats.get('c1')!
    assert.ok(seat)
    assert.equal(seat.seatCol, 3)
    assert.equal(seat.seatRow, 3)
  })

  test('does not create seats for non-chair furniture', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 2 }
    ]
    const seats = layoutToSeats(furniture)
    assert.equal(seats.size, 0)
  })

  test('chair orientation determines facing direction', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'c1', type: 'TEST_CHAIR_FRONT', col: 3, row: 3 },
      { uid: 'c2', type: 'TEST_CHAIR_BACK', col: 5, row: 3 }
    ]
    const seats = layoutToSeats(furniture)
    // front orientation -> DOWN
    assert.equal(seats.get('c1')!.facingDir, 0) // Direction.DOWN
    // back orientation -> UP
    assert.equal(seats.get('c2')!.facingDir, 3) // Direction.UP
  })

  test('seats start unassigned', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'c1', type: 'TEST_CHAIR_FRONT', col: 3, row: 3 }
    ]
    const seats = layoutToSeats(furniture)
    assert.equal(seats.get('c1')!.assigned, false)
  })
})

// ── getSeatTiles ────────────────────────────────────────────

describe('getSeatTiles', () => {
  test('returns tile coords for all seats', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'c1', type: 'TEST_CHAIR_FRONT', col: 3, row: 3 },
      { uid: 'c2', type: 'TEST_CHAIR_BACK', col: 5, row: 4 }
    ]
    const seats = layoutToSeats(furniture)
    const tiles = getSeatTiles(seats)
    assert.ok(tiles.has('3,3'))
    assert.ok(tiles.has('5,4'))
    assert.equal(tiles.size, 2)
  })
})

// ── layoutToFurnitureInstances ──────────────────────────────

describe('layoutToFurnitureInstances', () => {
  test('returns empty array for no furniture', () => {
    const instances = layoutToFurnitureInstances([])
    assert.equal(instances.length, 0)
  })

  test('creates instance with correct pixel position', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 3 }
    ]
    const instances = layoutToFurnitureInstances(furniture)
    assert.equal(instances.length, 1)
    // TILE_SIZE is 16, so pixel pos = col * 16, row * 16
    assert.equal(instances[0].x, 2 * 16)
    assert.equal(instances[0].y, 3 * 16)
  })

  test('has sprite data for each instance', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'd1', type: 'TEST_DESK', col: 2, row: 3 }
    ]
    const instances = layoutToFurnitureInstances(furniture)
    assert.ok(instances[0].sprite)
    assert.ok(instances[0].sprite.length > 0)
  })

  test('skips unknown furniture types gracefully', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'x1', type: 'NONEXISTENT_TYPE', col: 1, row: 1 }
    ]
    const instances = layoutToFurnitureInstances(furniture)
    assert.equal(instances.length, 0)
  })
})

// ── createDefaultLayout ────────────────────────────────────

describe('createDefaultLayout', () => {
  test('has correct default dimensions', () => {
    const layout = createDefaultLayout()
    assert.equal(layout.cols, DEFAULT_COLS)
    assert.equal(layout.rows, DEFAULT_ROWS)
  })

  test('tile array length matches cols * rows', () => {
    const layout = createDefaultLayout()
    assert.equal(layout.tiles.length, layout.cols * layout.rows)
  })

  test('has wall border', () => {
    const layout = createDefaultLayout()
    // Top-left corner should be wall
    assert.equal(layout.tiles[0], TileType.WALL)
    // Top-right corner
    assert.equal(layout.tiles[layout.cols - 1], TileType.WALL)
    // Bottom-left corner
    assert.equal(layout.tiles[(layout.rows - 1) * layout.cols], TileType.WALL)
  })

  test('has floor tiles in interior', () => {
    const layout = createDefaultLayout()
    // Interior tile at (1,1) should be floor
    const idx = 1 * layout.cols + 1
    assert.ok(layout.tiles[idx] > 0 && layout.tiles[idx] !== TileType.VOID)
  })

  test('includes tileColors parallel to tiles', () => {
    const layout = createDefaultLayout()
    assert.ok(layout.tileColors)
    assert.equal(layout.tileColors!.length, layout.tiles.length)
  })

  test('wall tiles have null color', () => {
    const layout = createDefaultLayout()
    assert.equal(layout.tileColors![0], null) // Wall at (0,0)
  })

  test('floor tiles have non-null color', () => {
    const layout = createDefaultLayout()
    const idx = 1 * layout.cols + 1
    assert.ok(layout.tileColors![idx] !== null)
  })

  test('has empty furniture array', () => {
    const layout = createDefaultLayout()
    assert.ok(Array.isArray(layout.furniture))
    assert.equal(layout.furniture.length, 0)
  })

  test('version is 1', () => {
    const layout = createDefaultLayout()
    assert.equal(layout.version, 1)
  })
})

// ── serializeLayout / deserializeLayout ─────────────────────

describe('serializeLayout / deserializeLayout — round-trip', () => {
  test('round-trips a simple layout', () => {
    const layout = make3x3Layout()
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.cols, layout.cols)
    assert.equal(restored!.rows, layout.rows)
    assert.deepEqual(restored!.tiles, layout.tiles)
    assert.deepEqual(restored!.furniture, layout.furniture)
  })

  test('round-trips the default layout', () => {
    const layout = createDefaultLayout()
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.cols, layout.cols)
    assert.equal(restored!.rows, layout.rows)
  })

  test('round-trips layout with furniture', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 5,
      rows: 5,
      tiles: new Array(25).fill(TileType.FLOOR_1),
      furniture: [
        { uid: 'f1', type: 'TEST_DESK', col: 1, row: 1 },
        { uid: 'f2', type: 'TEST_CHAIR_FRONT', col: 1, row: 2 }
      ]
    }
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.furniture.length, 2)
    assert.equal(restored!.furniture[0].uid, 'f1')
    assert.equal(restored!.furniture[1].uid, 'f2')
  })

  test('round-trips layout with tileColors', () => {
    const layout = createDefaultLayout()
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.ok(restored!.tileColors)
    assert.equal(restored!.tileColors!.length, restored!.tiles.length)
  })
})

describe('deserializeLayout — error handling', () => {
  test('returns null for invalid JSON', () => {
    assert.equal(deserializeLayout('not json'), null)
  })

  test('returns null for empty string', () => {
    assert.equal(deserializeLayout(''), null)
  })

  test('returns null for JSON missing version', () => {
    assert.equal(deserializeLayout('{"tiles":[1],"furniture":[]}'), null)
  })

  test('returns null for JSON missing tiles', () => {
    assert.equal(deserializeLayout('{"version":1,"furniture":[]}'), null)
  })

  test('returns null for JSON missing furniture', () => {
    assert.equal(deserializeLayout('{"version":1,"tiles":[1]}'), null)
  })

  test('returns null for non-array tiles', () => {
    assert.equal(deserializeLayout('{"version":1,"tiles":"bad","furniture":[]}'), null)
  })
})

// ── migrateLayoutColors ────────────────────────────────────

describe('migrateLayoutColors', () => {
  test('adds tileColors when missing', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: 1,
      tiles: [TileType.WALL, TileType.FLOOR_1, TileType.FLOOR_2],
      furniture: []
    }
    const migrated = migrateLayoutColors(layout)
    assert.ok(migrated.tileColors)
    assert.equal(migrated.tileColors!.length, 3)
  })

  test('wall tiles get null color after migration', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 1,
      rows: 1,
      tiles: [TileType.WALL],
      furniture: []
    }
    const migrated = migrateLayoutColors(layout)
    assert.equal(migrated.tileColors![0], null)
  })

  test('floor tiles get non-null color after migration', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 1,
      rows: 1,
      tiles: [TileType.FLOOR_1],
      furniture: []
    }
    const migrated = migrateLayoutColors(layout)
    assert.ok(migrated.tileColors![0] !== null)
    const color = migrated.tileColors![0] as FloorColor
    assert.equal(typeof color.h, 'number')
    assert.equal(typeof color.s, 'number')
    assert.equal(typeof color.b, 'number')
    assert.equal(typeof color.c, 'number')
  })

  test('preserves existing tileColors', () => {
    const customColor: FloorColor = { h: 42, s: 77, b: -10, c: 3 }
    const layout: OfficeLayout = {
      version: 1,
      cols: 1,
      rows: 1,
      tiles: [TileType.FLOOR_1],
      tileColors: [customColor],
      furniture: []
    }
    const migrated = migrateLayoutColors(layout)
    assert.deepEqual(migrated.tileColors![0], customColor)
  })

  test('migrates all floor types (1-9) with layoutRevision set', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 9,
      rows: 1,
      tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] as any,
      furniture: [],
      layoutRevision: 1 // Prevents old VOID migration (value 8 -> 255)
    }
    const migrated = migrateLayoutColors(layout)
    assert.equal(migrated.tileColors!.length, 9)
    for (let i = 0; i < 9; i++) {
      assert.ok(migrated.tileColors![i] !== null, `Floor type ${i + 1} should have a color`)
    }
  })

  test('without layoutRevision, tile value 8 is treated as legacy VOID', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 1,
      rows: 1,
      tiles: [8] as any,
      furniture: []
      // No layoutRevision — triggers old VOID migration (8 -> 255)
    }
    const migrated = migrateLayoutColors(layout)
    // Value 8 becomes TileType.VOID (255), which gets null color
    assert.equal(migrated.tileColors![0], null)
  })
})

// ── Legacy furniture type migration ─────────────────────────

describe('legacy furniture migration via deserializeLayout', () => {
  test('migrates "desk" to "DESK_FRONT"', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: 3,
      tiles: new Array(9).fill(TileType.FLOOR_1),
      furniture: [{ uid: 'f1', type: 'desk', col: 1, row: 1 }]
    }
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.furniture[0].type, 'DESK_FRONT')
  })

  test('migrates "chair" to "WOODEN_CHAIR_FRONT"', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: 3,
      tiles: new Array(9).fill(TileType.FLOOR_1),
      furniture: [{ uid: 'f1', type: 'chair', col: 1, row: 1 }]
    }
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.furniture[0].type, 'WOODEN_CHAIR_FRONT')
  })

  test('removes furniture with no equivalent (cooler, lamp)', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: 3,
      tiles: new Array(9).fill(TileType.FLOOR_1),
      furniture: [
        { uid: 'f1', type: 'cooler', col: 1, row: 1 },
        { uid: 'f2', type: 'lamp', col: 2, row: 1 }
      ]
    }
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.furniture.length, 0)
  })

  test('preserves non-legacy furniture types', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 3,
      rows: 3,
      tiles: new Array(9).fill(TileType.FLOOR_1),
      furniture: [{ uid: 'f1', type: 'TEST_DESK', col: 1, row: 1 }]
    }
    const json = serializeLayout(layout)
    const restored = deserializeLayout(json)
    assert.ok(restored)
    assert.equal(restored!.furniture[0].type, 'TEST_DESK')
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- layoutSerializer.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

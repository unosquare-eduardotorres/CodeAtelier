// Ported from vendor: pixel-agents/webview-ui/src/office/editor/editorActions.ts
// Pure layout operations — no VS Code or Phaser dependencies.

import { DEFAULT_NEUTRAL_COLOR } from '../constants'
import { getCatalogEntry, getRotatedType, getToggledType } from '../layout/furnitureCatalog'
import { getPlacementBlockedTiles } from '../layout/layoutSerializer'
import type {
  FloorColor,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal
} from '../engine/types'
import { EditTool, MAX_COLS, MAX_ROWS, TileType } from '../engine/types'

/** Paint a single tile with pattern and color. Returns new layout (immutable). */
export function paintTile(
  layout: OfficeLayout,
  col: number,
  row: number,
  tileType: TileTypeVal,
  color?: FloorColor
): OfficeLayout {
  const idx = row * layout.cols + col
  if (idx < 0 || idx >= layout.tiles.length) return layout

  const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null)
  const newColor =
    color ??
    (tileType === TileType.WALL || tileType === TileType.VOID ? null : { ...DEFAULT_NEUTRAL_COLOR })

  // Check if anything actually changed
  if (layout.tiles[idx] === tileType) {
    const existingColor = existingColors[idx]
    if (newColor === null && existingColor === null) return layout
    if (
      newColor &&
      existingColor &&
      newColor.h === existingColor.h &&
      newColor.s === existingColor.s &&
      newColor.b === existingColor.b &&
      newColor.c === existingColor.c &&
      !!newColor.colorize === !!existingColor.colorize
    )
      return layout
  }

  const tiles = [...layout.tiles]
  tiles[idx] = tileType
  const tileColors = [...existingColors]
  tileColors[idx] = newColor
  return { ...layout, tiles, tileColors }
}

/** Place furniture. Returns new layout (immutable). */
export function placeFurniture(layout: OfficeLayout, item: PlacedFurniture): OfficeLayout {
  if (!canPlaceFurniture(layout, item.type, item.col, item.row)) return layout
  return { ...layout, furniture: [...layout.furniture, item] }
}

/** Remove furniture by uid. Returns new layout (immutable). */
export function removeFurniture(layout: OfficeLayout, uid: string): OfficeLayout {
  const filtered = layout.furniture.filter((f) => f.uid !== uid)
  if (filtered.length === layout.furniture.length) return layout
  return { ...layout, furniture: filtered }
}

/** Move furniture to new position. Returns new layout (immutable). */
export function moveFurniture(
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid)
  if (!item) return layout
  if (!canPlaceFurniture(layout, item.type, newCol, newRow, uid)) return layout
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, col: newCol, row: newRow } : f))
  }
}

/** Rotate furniture to the next orientation. Returns new layout (immutable). */
export function rotateFurniture(
  layout: OfficeLayout,
  uid: string,
  direction: 'cw' | 'ccw'
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid)
  if (!item) return layout
  const newType = getRotatedType(item.type, direction)
  if (!newType) return layout
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, type: newType } : f))
  }
}

/** Toggle furniture state (on/off). Returns new layout (immutable). */
export function toggleFurnitureState(layout: OfficeLayout, uid: string): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid)
  if (!item) return layout
  const newType = getToggledType(item.type)
  if (!newType) return layout
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, type: newType } : f))
  }
}

/** For wall items, offset the row so the bottom row aligns with the hovered tile. */
export function getWallPlacementRow(type: string, row: number): number {
  const entry = getCatalogEntry(type)
  if (!entry?.canPlaceOnWalls) return row
  return row - (entry.footprintH - 1)
}

/** Check if furniture can be placed at (col, row) without overlapping. */
export function canPlaceFurniture(
  layout: OfficeLayout,
  type: string,
  col: number,
  row: number,
  excludeUid?: string
): boolean {
  const entry = getCatalogEntry(type)
  if (!entry) return false

  // Check bounds — wall items may extend above the map
  if (entry.canPlaceOnWalls) {
    const bottomRow = row + entry.footprintH - 1
    if (
      col < 0 ||
      col + entry.footprintW > layout.cols ||
      bottomRow < 0 ||
      bottomRow >= layout.rows
    ) {
      return false
    }
  } else {
    if (
      col < 0 ||
      row < 0 ||
      col + entry.footprintW > layout.cols ||
      row + entry.footprintH > layout.rows
    ) {
      return false
    }
  }

  // Wall/VOID placement check (background rows skip this check)
  const bgRows = entry.backgroundTiles || 0
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < bgRows) continue
    if (row + dr < 0) continue
    if (entry.canPlaceOnWalls && dr < entry.footprintH - 1) continue
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const idx = (row + dr) * layout.cols + (col + dc)
      const tileVal = layout.tiles[idx]
      if (entry.canPlaceOnWalls) {
        if (tileVal !== TileType.WALL) return false
      } else {
        if (tileVal === TileType.VOID) return false
        if (tileVal === TileType.WALL) return false
      }
    }
  }

  // Build occupied set excluding the item being moved
  const occupied = getPlacementBlockedTiles(layout.furniture, excludeUid)

  // If this item can be placed on surfaces, build set of desk tiles to exclude from collision
  let deskTiles: Set<string> | null = null
  if (entry.canPlaceOnSurfaces) {
    deskTiles = new Set<string>()
    for (const item of layout.furniture) {
      if (item.uid === excludeUid) continue
      const itemEntry = getCatalogEntry(item.type)
      if (!itemEntry || !itemEntry.isDesk) continue
      for (let dr = 0; dr < itemEntry.footprintH; dr++) {
        for (let dc = 0; dc < itemEntry.footprintW; dc++) {
          deskTiles.add(`${item.col + dc},${item.row + dr}`)
        }
      }
    }
  }

  // Check overlap
  const newBgRows = entry.backgroundTiles || 0
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < newBgRows) continue
    if (row + dr < 0) continue
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const key = `${col + dc},${row + dr}`
      if (occupied.has(key) && !deskTiles?.has(key)) return false
    }
  }

  return true
}

/**
 * Find the first furniture item whose footprint covers (col, row).
 * Shared hit-test used by editor tools, PhaserEditorScene, and sub-hooks.
 */
export function findFurnitureAtTile(
  furniture: PlacedFurniture[],
  col: number,
  row: number
): PlacedFurniture | undefined {
  return furniture.find((f) => {
    const entry = getCatalogEntry(f.type)
    if (!entry) return false
    return (
      col >= f.col &&
      col < f.col + entry.footprintW &&
      row >= f.row &&
      row < f.row + entry.footprintH
    )
  })
}

// ── Pure decision functions (extracted from hooks to reduce complexity) ──

/** Resolve a tile paint action. Returns new layout or null if unchanged. */
export function resolveTilePaintAction(
  layout: OfficeLayout,
  col: number,
  row: number,
  tileType: TileTypeVal,
  floorColor: FloorColor
): OfficeLayout | null {
  const newLayout = paintTile(layout, col, row, tileType, floorColor)
  return newLayout !== layout ? newLayout : null
}

/**
 * Resolve a wall paint action with drag-adding state machine.
 * Returns { layout, wallDragAdding } where layout is null if no change.
 */
export function resolveWallPaintAction(
  layout: OfficeLayout,
  col: number,
  row: number,
  wallDragAdding: boolean | null,
  wallColor: FloorColor,
  fallbackTileType: TileTypeVal,
  fallbackFloorColor: FloorColor
): { layout: OfficeLayout | null; wallDragAdding: boolean | null } {
  const idx = row * layout.cols + col
  const isWall = layout.tiles[idx] === TileType.WALL

  const dragAdding = wallDragAdding === null ? !isWall : wallDragAdding

  if (dragAdding) {
    const newLayout = paintTile(layout, col, row, TileType.WALL, wallColor)
    return { layout: newLayout !== layout ? newLayout : null, wallDragAdding: dragAdding }
  } else {
    if (isWall) {
      const newLayout = paintTile(layout, col, row, fallbackTileType, fallbackFloorColor)
      return { layout: newLayout !== layout ? newLayout : null, wallDragAdding: dragAdding }
    }
  }
  return { layout: null, wallDragAdding: dragAdding }
}

/** Resolve an erase action. Returns new layout or null if unchanged. */
export function resolveEraseAction(
  layout: OfficeLayout,
  col: number,
  row: number
): OfficeLayout | null {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null
  const idx = row * layout.cols + col
  if (layout.tiles[idx] === TileType.VOID) return null
  const newLayout = paintTile(layout, col, row, TileType.VOID)
  return newLayout !== layout ? newLayout : null
}

/** Result of resolving an eyedropper sample */
interface EyedropperResult {
  /** Tool to switch to */
  tool: typeof EditTool.TILE_PAINT | typeof EditTool.WALL_PAINT
  /** Sampled tile type (only for floor tiles) */
  tileType?: TileTypeVal
  /** Sampled color */
  color?: FloorColor
}

/** Resolve an eyedropper action at (col, row). Returns what was sampled or null if void. */
export function resolveEyedropperAction(
  layout: OfficeLayout,
  col: number,
  row: number
): EyedropperResult | null {
  const idx = row * layout.cols + col
  const tile = layout.tiles[idx]
  if (tile === undefined || tile === TileType.VOID) return null

  const color = layout.tileColors?.[idx] ?? undefined

  if (tile !== TileType.WALL) {
    return { tool: EditTool.TILE_PAINT, tileType: tile, color: color ? { ...color } : undefined }
  } else {
    return { tool: EditTool.WALL_PAINT, color: color ? { ...color } : undefined }
  }
}

/**
 * Resolve furniture placement at (col, row).
 * Returns the new layout and placed item, or null if placement is invalid.
 */
export function resolveFurniturePlacement(
  layout: OfficeLayout,
  col: number,
  row: number,
  furnitureType: string,
  color?: FloorColor | null
): { layout: OfficeLayout; placed: PlacedFurniture } | null {
  const placementRow = getWallPlacementRow(furnitureType, row)
  if (!canPlaceFurniture(layout, furnitureType, col, placementRow)) return null
  const uid = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const placed: PlacedFurniture = { uid, type: furnitureType, col, row: placementRow }
  if (color) {
    placed.color = { ...color }
  }
  const newLayout = placeFurniture(layout, placed)
  if (newLayout === layout) return null
  return { layout: newLayout, placed }
}

export type ExpandDirection = 'left' | 'right' | 'up' | 'down'

/**
 * Expand layout by 1 tile in the given direction. New tiles are VOID.
 * Furniture and tile indices are shifted when expanding left or up.
 * Returns { layout, shift } or null if exceeding MAX_COLS/MAX_ROWS.
 */
export function expandLayout(
  layout: OfficeLayout,
  direction: ExpandDirection
): { layout: OfficeLayout; shift: { col: number; row: number } } | null {
  const { cols, rows, tiles, furniture, tileColors } = layout
  const existingColors = tileColors || new Array(tiles.length).fill(null)

  let newCols = cols
  let newRows = rows
  let shiftCol = 0
  let shiftRow = 0

  if (direction === 'right') {
    newCols = cols + 1
  } else if (direction === 'left') {
    newCols = cols + 1
    shiftCol = 1
  } else if (direction === 'down') {
    newRows = rows + 1
  } else if (direction === 'up') {
    newRows = rows + 1
    shiftRow = 1
  }

  if (newCols > MAX_COLS || newRows > MAX_ROWS) return null

  // Build new tile array
  const newTiles: TileTypeVal[] = new Array(newCols * newRows).fill(TileType.VOID as TileTypeVal)
  const newColors: Array<FloorColor | null> = new Array(newCols * newRows).fill(null)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const oldIdx = r * cols + c
      const newIdx = (r + shiftRow) * newCols + (c + shiftCol)
      newTiles[newIdx] = tiles[oldIdx]
      newColors[newIdx] = existingColors[oldIdx]
    }
  }

  // Shift furniture positions
  const newFurniture: PlacedFurniture[] = furniture.map((f) => ({
    ...f,
    col: f.col + shiftCol,
    row: f.row + shiftRow
  }))

  return {
    layout: {
      ...layout,
      cols: newCols,
      rows: newRows,
      tiles: newTiles,
      tileColors: newColors,
      furniture: newFurniture
    },
    shift: { col: shiftCol, row: shiftRow }
  }
}

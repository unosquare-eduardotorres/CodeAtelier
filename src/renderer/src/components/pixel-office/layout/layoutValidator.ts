/**
 * Layout schema validation for pixel office layouts.
 * Validates layout integrity before applying to the engine, preventing
 * crashes from corrupted or malformed layout JSON.
 */

import type { FloorColor, OfficeLayout, PlacedFurniture } from '../engine/types'
import { TileType } from '../engine/types'

/** Validation result with errors */
export interface LayoutValidationResult {
  valid: boolean
  errors: string[]
  /** The validated layout, or null if invalid */
  layout: OfficeLayout | null
}

/** Set of valid tile type values */
const VALID_TILE_VALUES = new Set<number>([
  TileType.WALL,
  TileType.FLOOR_1,
  TileType.FLOOR_2,
  TileType.FLOOR_3,
  TileType.FLOOR_4,
  TileType.FLOOR_5,
  TileType.FLOOR_6,
  TileType.FLOOR_7,
  TileType.FLOOR_8,
  TileType.FLOOR_9,
  TileType.VOID
])

/**
 * Validate an unknown JSON value as a valid OfficeLayout.
 * Returns a structured result with errors and the validated layout.
 */
export function validateLayout(json: unknown): LayoutValidationResult {
  const errors: string[] = []

  if (!json || typeof json !== 'object') {
    return { valid: false, errors: ['Layout must be a non-null object'], layout: null }
  }

  const obj = json as Record<string, unknown>

  // Required fields
  if (typeof obj.version !== 'number' || obj.version < 1) {
    errors.push('Missing or invalid "version" (must be a positive number)')
  }

  if (typeof obj.cols !== 'number' || obj.cols < 1 || !Number.isInteger(obj.cols)) {
    errors.push('Missing or invalid "cols" (must be a positive integer)')
  }

  if (typeof obj.rows !== 'number' || obj.rows < 1 || !Number.isInteger(obj.rows)) {
    errors.push('Missing or invalid "rows" (must be a positive integer)')
  }

  if (!Array.isArray(obj.tiles)) {
    errors.push('Missing or invalid "tiles" (must be an array)')
    return { valid: false, errors, layout: null }
  }

  if (!Array.isArray(obj.furniture)) {
    errors.push('Missing or invalid "furniture" (must be an array)')
    return { valid: false, errors, layout: null }
  }

  const cols = obj.cols as number
  const rows = obj.rows as number
  const tiles = obj.tiles as number[]

  // Tile array length check
  if (cols > 0 && rows > 0 && tiles.length !== cols * rows) {
    errors.push(
      `Tile array length (${tiles.length}) does not match cols * rows (${cols} * ${rows} = ${cols * rows})`
    )
  }

  // Validate tile values
  let invalidTileCount = 0
  for (let i = 0; i < tiles.length; i++) {
    if (typeof tiles[i] !== 'number' || !VALID_TILE_VALUES.has(tiles[i])) {
      invalidTileCount++
    }
  }
  if (invalidTileCount > 0) {
    errors.push(`${invalidTileCount} tile(s) have invalid TileType values`)
  }

  // Validate furniture UIDs are unique
  const furniture = obj.furniture as PlacedFurniture[]
  const uidSet = new Set<string>()
  let duplicateUids = 0
  for (const item of furniture) {
    if (!item.uid || typeof item.uid !== 'string') {
      errors.push('Furniture item missing "uid" string')
      continue
    }
    if (uidSet.has(item.uid)) {
      duplicateUids++
    }
    uidSet.add(item.uid)
  }
  if (duplicateUids > 0) {
    errors.push(`${duplicateUids} duplicate furniture UID(s) found`)
  }

  // Validate furniture fields
  for (const item of furniture) {
    if (typeof item.type !== 'string' || !item.type) {
      errors.push(`Furniture ${item.uid || '?'} has invalid "type"`)
    }
    if (typeof item.col !== 'number' || typeof item.row !== 'number') {
      errors.push(`Furniture ${item.uid || '?'} has invalid col/row`)
    }
  }

  // Validate tileColors if present
  if (obj.tileColors !== undefined) {
    if (!Array.isArray(obj.tileColors)) {
      errors.push('"tileColors" must be an array when present')
    } else if (obj.tileColors.length !== tiles.length) {
      errors.push(
        `tileColors length (${obj.tileColors.length}) does not match tiles length (${tiles.length})`
      )
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, layout: null }
  }

  return { valid: true, errors: [], layout: obj as unknown as OfficeLayout }
}

/**
 * Validate and return layout, or null if invalid.
 * Simpler API for cases where you just need the layout or null.
 */
export function validateLayoutOrNull(json: unknown): OfficeLayout | null {
  const result = validateLayout(json)
  return result.layout
}

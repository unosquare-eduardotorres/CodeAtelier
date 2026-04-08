// Adapted from pixel-agents: webview-ui/src/office/layout/furnitureCatalog.ts
// Removed VS Code messaging dependencies

import type { FurnitureCatalogEntry, SpriteData } from '../engine/types'
import {
  buildCatalogEntries,
  createMirrorEntries,
  detectRotationGroups,
  detectStatePairs,
  registerOnStateRotations,
  detectAnimationGroups,
  buildVisibleCatalog
} from './catalogBuilder'
import type { RotationGroup } from './catalogBuilder'

export interface LoadedAssetData {
  catalog: Array<{
    id: string
    label: string
    category: string
    width: number
    height: number
    footprintW: number
    footprintH: number
    isDesk: boolean
    groupId?: string
    orientation?: string // 'front' | 'back' | 'left' | 'right' | 'side'
    state?: string // 'on' | 'off'
    canPlaceOnSurfaces?: boolean
    backgroundTiles?: number
    canPlaceOnWalls?: boolean
    mirrorSide?: boolean
    rotationScheme?: string
    animationGroup?: string
    frame?: number
  }>
  sprites: Record<string, SpriteData>
}

export type FurnitureCategory =
  | 'desks'
  | 'chairs'
  | 'storage'
  | 'decor'
  | 'electronics'
  | 'wall'
  | 'misc'

export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory
}

// ── Rotation groups ──────────────────────────────────────────────
// Maps any member asset ID → its rotation group
const rotationGroups = new Map<string, RotationGroup>()

// ── State groups ────────────────────────────────────────────────
// Maps asset ID → its on/off counterpart (symmetric for toggle)
const stateGroups = new Map<string, string>()
// Directional maps for getOnStateType / getOffStateType
const offToOn = new Map<string, string>() // off asset → on asset
const onToOff = new Map<string, string>() // on asset → off asset

// ── Animation groups ────────────────────────────────────────────
// Maps animation group ID → ordered list of asset IDs by frame index
const animationGroups = new Map<string, string[]>()

// Internal catalog (includes all variants for getCatalogEntry lookups)
let internalCatalog: CatalogEntryWithCategory[] | null = null

// Dynamic catalog built from loaded assets (when available)
// Only includes "front" variants for grouped items (shown in editor palette)
let dynamicCatalog: CatalogEntryWithCategory[] | null = null
let dynamicCategories: FurnitureCategory[] | null = null

/**
 * Build catalog from loaded assets. Returns true if successful.
 * Once built, all getCatalog* functions use the dynamic catalog.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false

  // Stage 1: Build all entries from raw assets
  const allEntries = buildCatalogEntries(assets)

  // Stage 2: Create virtual ":left" mirror entries
  const mirrors = createMirrorEntries(allEntries, assets)
  allEntries.push(...mirrors)

  if (allEntries.length === 0) return false

  // Clear module-level state
  rotationGroups.clear()
  stateGroups.clear()
  offToOn.clear()
  onToOff.clear()
  animationGroups.clear()

  // Stage 3: Detect rotation groups
  const rotResult = detectRotationGroups(assets)
  for (const [id, group] of rotResult.rotationGroups) {
    rotationGroups.set(id, group)
  }

  // Stage 4: Detect state pairs (on/off)
  const stateResult = detectStatePairs(assets)
  for (const [k, v] of stateResult.stateGroups) stateGroups.set(k, v)
  for (const [k, v] of stateResult.offToOn) offToOn.set(k, v)
  for (const [k, v] of stateResult.onToOff) onToOff.set(k, v)

  // Stage 5: Register rotation groups for "on" state variants
  registerOnStateRotations(assets, rotationGroups, stateGroups)

  // Stage 6: Detect animation groups
  const animResult = detectAnimationGroups(assets)
  for (const [k, v] of animResult) animationGroups.set(k, v)

  // Store full internal catalog (all variants)
  internalCatalog = allEntries

  // Stage 7: Build visible catalog for editor palette
  const visResult = buildVisibleCatalog(
    allEntries,
    assets,
    rotResult.nonFrontIds,
    rotationGroups,
    stateGroups
  )
  dynamicCatalog = visResult.visibleEntries
  dynamicCategories = visResult.categories

  const rotGroupCount = new Set(Array.from(rotationGroups.values())).size
  const animGroupCount = animationGroups.size
  console.log(
    `Built dynamic catalog with ${allEntries.length} assets (${visResult.visibleEntries.length} visible, ${rotGroupCount} rotation groups, ${stateGroups.size / 2} state pairs, ${animGroupCount} animation groups)`
  )
  return true
}

export function getCatalogEntry(type: string): CatalogEntryWithCategory | undefined {
  // Check internal catalog (includes all variants, e.g., non-front rotations)
  if (internalCatalog) {
    return internalCatalog.find((e) => e.type === type)
  }
  return dynamicCatalog?.find((e) => e.type === type)
}

export function getCatalogByCategory(category: FurnitureCategory): CatalogEntryWithCategory[] {
  const catalog = dynamicCatalog ?? []
  return catalog.filter((e) => e.category === category)
}

export function getActiveCatalog(): CatalogEntryWithCategory[] {
  return dynamicCatalog ?? []
}

export function getActiveCategories(): Array<{ id: FurnitureCategory; label: string }> {
  const categories = dynamicCategories ?? []
  return FURNITURE_CATEGORIES.filter((c) => categories.includes(c.id))
}

export const FURNITURE_CATEGORIES: Array<{ id: FurnitureCategory; label: string }> = [
  { id: 'desks', label: 'Desks' },
  { id: 'chairs', label: 'Chairs' },
  { id: 'storage', label: 'Storage' },
  { id: 'electronics', label: 'Tech' },
  { id: 'decor', label: 'Decor' },
  { id: 'wall', label: 'Wall' },
  { id: 'misc', label: 'Misc' }
]

// ── Rotation helpers ─────────────────────────────────────────────

/** Returns the next asset ID in the rotation group (cw or ccw), or null if not rotatable. */
export function getRotatedType(currentType: string, direction: 'cw' | 'ccw'): string | null {
  const group = rotationGroups.get(currentType)
  if (!group) return null
  const order = group.orientations.map((o) => group.members[o])
  const idx = order.indexOf(currentType)
  if (idx === -1) return null
  const step = direction === 'cw' ? 1 : -1
  const nextIdx = (idx + step + order.length) % order.length
  return order[nextIdx]
}

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function getToggledType(currentType: string): string | null {
  return stateGroups.get(currentType) ?? null
}

/** Returns the "on" variant if this type has one, otherwise returns the type unchanged. */
export function getOnStateType(currentType: string): string {
  return offToOn.get(currentType) ?? currentType
}

/** Returns true if the given furniture type is part of a rotation group. */
export function isRotatable(type: string): boolean {
  return rotationGroups.has(type)
}

/** Get ordered animation frame asset IDs for a given type, or null if not animated. */
export function getAnimationFrames(type: string): string[] | null {
  // Find the animation group this type belongs to
  for (const [, frames] of animationGroups) {
    if (frames.includes(type)) return frames
  }
  return null
}

/**
 * Get the orientation of a type within its rotation group, or undefined if not in a group.
 * Used by the renderer to determine if a "left" orientation should be mirrored.
 */
export function getOrientationInGroup(type: string): string | undefined {
  const group = rotationGroups.get(type)
  if (!group) return undefined
  for (const [orient, id] of Object.entries(group.members)) {
    if (id === type) return orient
  }
  return undefined
}

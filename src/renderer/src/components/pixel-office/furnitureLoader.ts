/**
 * furnitureLoader — Runtime furniture asset discovery using Vite glob imports.
 *
 * Replaces the auto-generated furnitureRegistry.ts (1,139 LOC) with ~80 LOC
 * of dynamic loading. Furniture additions now only require dropping a PNG +
 * manifest.json — no script regeneration or code commits needed.
 */

// ── Glob all furniture PNGs at build time ──
const pngModules = import.meta.glob<string>(
  '@renderer/assets/pixel-office/furniture/**/*.png',
  { eager: true, import: 'default' }
)

// ── Glob all furniture manifests at build time ──
const manifestModules = import.meta.glob<Record<string, unknown>>(
  '@renderer/assets/pixel-office/furniture/*/manifest.json',
  { eager: true, import: 'default' }
)

/**
 * Build the FURNITURE_PNG_MAP from glob'd PNGs.
 * Keys are asset IDs derived from filename (e.g. "DESK_FRONT" from "DESK_FRONT.png").
 */
export function buildFurniturePngMap(): Record<string, string> {
  const map: Record<string, string> = {}

  for (const [path, url] of Object.entries(pngModules)) {
    // Path looks like: /@renderer/assets/pixel-office/furniture/DESK/DESK_FRONT.png
    const filename = path.split('/').pop()
    if (!filename) continue
    const assetId = filename.replace('.png', '')
    map[assetId] = url
  }

  return map
}

/** Furniture manifest entry as loaded from JSON (internal) */
interface ManifestAsset {
  type?: string
  id: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  orientation?: string
  state?: string
  animationGroup?: string
}

interface ManifestGroup {
  id: string
  name: string
  category: string
  type: string
  groupType?: string
  rotationScheme?: string
  canPlaceOnWalls?: boolean
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
  mirrorSide?: boolean
  members?: ManifestAsset[]
  // Single-asset manifests have these at root level
  file?: string
  width?: number
  height?: number
  footprintW?: number
  footprintH?: number
  isDesk?: boolean
}

/** Catalog entry compatible with FURNITURE_CATALOG format (internal) */
interface FurnitureCatalogRaw {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  canPlaceOnSurfaces: boolean
  backgroundTiles: number
  groupId?: string
  orientation?: string
  state?: string
  animationGroup?: string
  rotationScheme?: string
  mirrorSide?: boolean
}

/**
 * Build the FURNITURE_CATALOG from glob'd manifests.
 * Flattens group manifests into individual asset entries matching the
 * format expected by buildDynamicCatalog.
 */
export function buildFurnitureCatalog(): FurnitureCatalogRaw[] {
  const catalog: FurnitureCatalogRaw[] = []

  for (const manifest of Object.values(manifestModules)) {
    const m = manifest as unknown as ManifestGroup

    if (m.members && m.members.length > 0) {
      // Group manifest — flatten each member into a catalog entry
      for (const member of m.members) {
        catalog.push({
          id: member.id,
          name: m.name,
          label: m.name,
          category: m.category,
          file: member.file,
          width: member.width,
          height: member.height,
          footprintW: member.footprintW,
          footprintH: member.footprintH,
          isDesk: m.category === 'desks' || m.category === 'chairs',
          canPlaceOnWalls: m.canPlaceOnWalls ?? false,
          canPlaceOnSurfaces: m.canPlaceOnSurfaces ?? false,
          backgroundTiles: m.backgroundTiles ?? 0,
          groupId: m.id,
          orientation: member.orientation,
          state: member.state,
          animationGroup: member.animationGroup,
          rotationScheme: m.rotationScheme,
          mirrorSide: m.mirrorSide
        })
      }
    } else if (m.file) {
      // Single-asset manifest
      catalog.push({
        id: m.id,
        name: m.name,
        label: m.name,
        category: m.category,
        file: m.file!,
        width: m.width!,
        height: m.height!,
        footprintW: m.footprintW!,
        footprintH: m.footprintH!,
        isDesk: m.isDesk ?? (m.category === 'desks' || m.category === 'chairs'),
        canPlaceOnWalls: m.canPlaceOnWalls ?? false,
        canPlaceOnSurfaces: m.canPlaceOnSurfaces ?? false,
        backgroundTiles: m.backgroundTiles ?? 0
      })
    }
  }

  return catalog
}

/**
 * Backward-compatible exports matching furnitureRegistry's interface.
 * Computed eagerly to match the old module's export behavior.
 */
export const FURNITURE_PNG_MAP = buildFurniturePngMap()
export const FURNITURE_CATALOG = buildFurnitureCatalog()

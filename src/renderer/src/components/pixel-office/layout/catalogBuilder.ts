/**
 * Pipeline stages for building the furniture catalog from loaded assets.
 * Each stage is a pure function with ~10-15 complexity, independently testable.
 *
 * Pipeline: buildCatalogEntries → createMirrorEntries → detectRotationGroups
 *         → detectStatePairs → registerOnStateRotations → detectAnimationGroups
 *         → buildVisibleCatalog
 */

import type {
  LoadedAssetData,
  CatalogEntryWithCategory,
  FurnitureCategory
} from './furnitureCatalog'

// ── Types for intermediate pipeline data ─────────────────────

export interface RotationGroup {
  /** Ordered list of orientations available for this group */
  orientations: string[]
  /** Maps orientation → asset ID (for the default/off state) */
  members: Record<string, string>
}

// ── Stage 1: Build catalog entries from raw assets ───────────

/** Convert raw asset data into CatalogEntryWithCategory objects */
export function buildCatalogEntries(assets: LoadedAssetData): CatalogEntryWithCategory[] {
  return assets.catalog
    .map((asset) => {
      const sprite = assets.sprites[asset.id]
      if (!sprite) {
        console.warn(`No sprite data for asset ${asset.id}`)
        return null
      }
      return {
        type: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        sprite,
        isDesk: asset.isDesk,
        category: asset.category as FurnitureCategory,
        ...(asset.orientation ? { orientation: asset.orientation } : {}),
        ...(asset.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
        ...(asset.backgroundTiles ? { backgroundTiles: asset.backgroundTiles } : {}),
        ...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {})
      }
    })
    .filter((e): e is CatalogEntryWithCategory => e !== null)
}

// ── Stage 2: Create virtual mirror entries ───────────────────

/** Create virtual `:left` entries for mirrorSide assets with orientation "side" */
export function createMirrorEntries(
  entries: CatalogEntryWithCategory[],
  assets: LoadedAssetData
): CatalogEntryWithCategory[] {
  const mirrors: CatalogEntryWithCategory[] = []
  for (const asset of assets.catalog) {
    if (asset.mirrorSide && asset.orientation === 'side') {
      const sideEntry = entries.find((e) => e.type === asset.id)
      if (sideEntry) {
        mirrors.push({
          ...sideEntry,
          type: `${asset.id}:left`,
          orientation: 'left',
          mirrorSide: true
        })
      }
    }
  }
  return mirrors
}

// ── Stage 3: Detect rotation groups ────���─────────────────────

interface RotationGroupResult {
  rotationGroups: Map<string, RotationGroup>
  nonFrontIds: Set<string>
}

/** Build rotation groups from groupId + orientation metadata */
export function detectRotationGroups(assets: LoadedAssetData): RotationGroupResult {
  const rotationGroups = new Map<string, RotationGroup>()
  const nonFrontIds = new Set<string>()

  // Collect orientations per group (only "off" or stateless variants)
  const groupMap = new Map<string, Map<string, string>>()
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation) {
      if (asset.state && asset.state !== 'off') continue
      let orientMap = groupMap.get(asset.groupId)
      if (!orientMap) {
        orientMap = new Map()
        groupMap.set(asset.groupId, orientMap)
      }
      if (asset.orientation === 'side') {
        orientMap.set('right', asset.id)
        if (asset.mirrorSide) {
          orientMap.set('left', `${asset.id}:left`)
        }
      } else {
        orientMap.set(asset.orientation, asset.id)
      }
    }
  }

  // Collect rotation schemes
  const rotationSchemes = new Map<string, string>()
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.rotationScheme) {
      rotationSchemes.set(asset.groupId, asset.rotationScheme)
    }
  }

  // Register rotation groups with 2+ orientations
  const orientationOrder = ['front', 'right', 'back', 'left']
  for (const [groupId, orientMap] of groupMap) {
    if (orientMap.size < 2) continue
    const scheme = rotationSchemes.get(groupId)
    let allowedOrients = orientationOrder
    if (scheme === '2-way') {
      allowedOrients = ['front', 'right']
    }

    const orderedOrients = allowedOrients.filter((o) => orientMap.has(o))
    if (orderedOrients.length < 2) continue

    const members: Record<string, string> = {}
    for (const o of orderedOrients) {
      members[o] = orientMap.get(o)!
    }
    const rg: RotationGroup = { orientations: orderedOrients, members }

    const registeredIds = new Set<string>()
    for (const id of Object.values(members)) {
      if (!registeredIds.has(id)) {
        rotationGroups.set(id, rg)
        registeredIds.add(id)
      }
    }
    for (const [orient, id] of Object.entries(members)) {
      if (orient !== 'front') nonFrontIds.add(id)
    }
  }

  return { rotationGroups, nonFrontIds }
}

// ── Stage 4: Detect state pairs (on/off) ─────────────────────

interface StatePairResult {
  stateGroups: Map<string, string>
  offToOn: Map<string, string>
  onToOff: Map<string, string>
}

/** Build on/off state pairs from groupId + state metadata */
export function detectStatePairs(assets: LoadedAssetData): StatePairResult {
  const stateGroups = new Map<string, string>()
  const offToOn = new Map<string, string>()
  const onToOff = new Map<string, string>()

  const stateMap = new Map<string, Map<string, string>>()
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.state) {
      const key = `${asset.groupId}|${asset.orientation || ''}`
      let sm = stateMap.get(key)
      if (!sm) {
        sm = new Map()
        stateMap.set(key, sm)
      }
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue
      sm.set(asset.state, asset.id)
    }
  }
  for (const sm of stateMap.values()) {
    const onId = sm.get('on')
    const offId = sm.get('off')
    if (onId && offId) {
      stateGroups.set(onId, offId)
      stateGroups.set(offId, onId)
      offToOn.set(offId, onId)
      onToOff.set(onId, offId)
    }
  }

  return { stateGroups, offToOn, onToOff }
}

// ── Stage 5: Register rotation groups for "on" state variants ─

/** Extend rotation groups to cover "on" state variants so rotation works on active items */
export function registerOnStateRotations(
  assets: LoadedAssetData,
  rotationGroups: Map<string, RotationGroup>,
  stateGroups: Map<string, string>
): void {
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation && asset.state === 'on') {
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue
      const offCounterpart = stateGroups.get(asset.id)
      if (offCounterpart) {
        const offGroup = rotationGroups.get(offCounterpart)
        if (offGroup) {
          const onMembers: Record<string, string> = {}
          for (const orient of offGroup.orientations) {
            const offId = offGroup.members[orient]
            const onId = stateGroups.get(offId)
            onMembers[orient] = onId ?? offId
          }
          const onGroup: RotationGroup = {
            orientations: offGroup.orientations,
            members: onMembers
          }
          for (const id of Object.values(onMembers)) {
            if (!rotationGroups.has(id)) {
              rotationGroups.set(id, onGroup)
            }
          }
        }
      }
    }
  }
}

// ── Stage 6: Detect animation groups ─────────────────────────

/** Build animation groups mapping first frame ID → ordered list of all frame IDs */
export function detectAnimationGroups(assets: LoadedAssetData): Map<string, string[]> {
  const animationGroups = new Map<string, string[]>()
  const animGroupCollector = new Map<string, Array<{ id: string; frame: number }>>()

  for (const asset of assets.catalog) {
    if (asset.animationGroup && asset.frame !== undefined) {
      let frames = animGroupCollector.get(asset.animationGroup)
      if (!frames) {
        frames = []
        animGroupCollector.set(asset.animationGroup, frames)
      }
      frames.push({ id: asset.id, frame: asset.frame })
    }
  }
  for (const [, frames] of animGroupCollector) {
    frames.sort((a, b) => a.frame - b.frame)
    animationGroups.set(
      frames[0].id,
      frames.map((f) => f.id)
    )
  }

  return animationGroups
}

// ── Stage 7: Build visible catalog ───────────────────────────

interface VisibleCatalogResult {
  visibleEntries: CatalogEntryWithCategory[]
  categories: FurnitureCategory[]
}

/** Filter entries to build the visible catalog (editor palette) and strip label suffixes */
export function buildVisibleCatalog(
  allEntries: CatalogEntryWithCategory[],
  assets: LoadedAssetData,
  nonFrontIds: Set<string>,
  rotationGroups: Map<string, RotationGroup>,
  stateGroups: Map<string, string>
): VisibleCatalogResult {
  const onStateIds = new Set<string>()
  for (const asset of assets.catalog) {
    if (asset.state === 'on') onStateIds.add(asset.id)
  }

  const visibleEntries = allEntries.filter(
    (e) => !nonFrontIds.has(e.type) && !onStateIds.has(e.type)
  )

  // Strip orientation/state suffix from labels for grouped variants
  for (const entry of visibleEntries) {
    if (rotationGroups.has(entry.type) || stateGroups.has(entry.type)) {
      entry.label = entry.label
        .replace(/ - Front - Off$/, '')
        .replace(/ - Front$/, '')
        .replace(/ - Off$/, '')
    }
  }

  const categories = Array.from(new Set(visibleEntries.map((e) => e.category)))
    .filter((c): c is FurnitureCategory => !!c)
    .sort()

  return { visibleEntries, categories }
}

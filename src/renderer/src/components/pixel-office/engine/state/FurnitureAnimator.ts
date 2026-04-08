/**
 * Manages furniture animation state: auto-on detection, animation frame cycling,
 * and dirty-flag-based rebuild of furniture instances.
 * Extracted from OfficeState to reduce complexity.
 */
import {
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  FURNITURE_ANIM_INTERVAL_SEC
} from '../../constants'
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../../layout/furnitureCatalog'
import { layoutToFurnitureInstances } from '../../layout/layoutSerializer'
import type { Character, FurnitureInstance, OfficeLayout, PlacedFurniture, Seat } from '../types'
import { Direction as Dir } from '../types'

export class FurnitureAnimator {
  /** Accumulated time for furniture animation frame cycling */
  animTimer = 0
  /** When true, furniture instances need recalculation */
  private dirty = true

  /** Mark furniture as needing rebuild (e.g., agent activity changed) */
  markDirty(): void {
    this.dirty = true
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON).
   *  Returns the new furniture instance array, or null if no rebuild needed. */
  update(
    dt: number,
    layout: OfficeLayout,
    characters: Map<number, Character>,
    seats: Map<string, Seat>,
    currentFurniture: FurnitureInstance[]
  ): FurnitureInstance[] | null {
    const prevFrame = Math.floor(this.animTimer / FURNITURE_ANIM_INTERVAL_SEC)
    this.animTimer += dt
    const newFrame = Math.floor(this.animTimer / FURNITURE_ANIM_INTERVAL_SEC)

    if (newFrame === prevFrame && !this.dirty) return null

    this.dirty = false
    return this.rebuildInstances(layout, characters, seats, currentFurniture, newFrame)
  }

  /** Force a full rebuild (e.g., on layout change) */
  forceRebuild(
    layout: OfficeLayout,
    characters: Map<number, Character>,
    seats: Map<string, Seat>
  ): FurnitureInstance[] {
    this.dirty = false
    const frame = Math.floor(this.animTimer / FURNITURE_ANIM_INTERVAL_SEC)
    return this.rebuildInstances(layout, characters, seats, [], frame)!
  }

  private rebuildInstances(
    layout: OfficeLayout,
    characters: Map<number, Character>,
    seats: Map<string, Seat>,
    currentFurniture: FurnitureInstance[],
    animFrame: number
  ): FurnitureInstance[] | null {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>()
    for (const ch of characters.values()) {
      if (!ch.isActive || !ch.seatId) continue
      const seat = seats.get(ch.seatId)
      if (!seat) continue
      const dCol = seat.facingDir === Dir.RIGHT ? 1 : seat.facingDir === Dir.LEFT ? -1 : 0
      const dRow = seat.facingDir === Dir.DOWN ? 1 : seat.facingDir === Dir.UP ? -1 : 0
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        autoOnTiles.add(`${seat.seatCol + dCol * d},${seat.seatRow + dRow * d}`)
      }
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d
        const baseRow = seat.seatRow + dRow * d
        if (dCol !== 0) {
          autoOnTiles.add(`${baseCol},${baseRow - 1}`)
          autoOnTiles.add(`${baseCol},${baseRow + 1}`)
        } else {
          autoOnTiles.add(`${baseCol - 1},${baseRow}`)
          autoOnTiles.add(`${baseCol + 1},${baseRow}`)
        }
      }
    }

    // Build modified furniture list with auto-state and animation applied
    let anyChanged = false
    const modifiedFurniture: PlacedFurniture[] = layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type)
      if (!entry) return item

      let nextType = item.type

      // Always cycle ambient animation groups
      const ambientFrames = getAnimationFrames(nextType)
      if (ambientFrames && ambientFrames.length > 1) {
        nextType = ambientFrames[animFrame % ambientFrames.length]
      }

      // Check if any tile overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            let onType = getOnStateType(item.type)
            if (onType !== item.type) {
              const frames = getAnimationFrames(onType)
              if (frames && frames.length > 1) {
                onType = frames[animFrame % frames.length]
              }
              nextType = onType
            }
            if (nextType !== item.type) {
              anyChanged = true
              return { ...item, type: nextType }
            }
            return item
          }
        }
      }
      if (nextType !== item.type) {
        anyChanged = true
        return { ...item, type: nextType }
      }
      return item
    })

    if (anyChanged) {
      return layoutToFurnitureInstances(modifiedFurniture)
    } else if (currentFurniture.length === 0) {
      return layoutToFurnitureInstances(layout.furniture)
    }
    return null
  }
}

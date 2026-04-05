/**
 * Shared rendering utilities for pixel-office Phaser scenes.
 *
 * Extracts duplicated wall rendering and color conversion logic from
 * PhaserOfficeScene and PhaserEditorScene into reusable functions.
 */

import type { FloorColor, FurnitureInstance, OfficeLayout, SpriteData } from '../engine/types'
import type { TileType as TileTypeVal } from '../engine/types'
import { TileType, TILE_SIZE } from '../engine/types'

// ── Renaissance palette constants ──────────────────────────────
export const PLANK_COLORS = [
  0x5c3a1e, // medium oak
  0x6b4226, // warm walnut
  0x4e3018, // dark oak
  0x7a5030, // honey oak
  0x5a3820 // chestnut
]
export const WALL_BASE_COLOR = 0x0f1517 // --ca-bg-primary deep obsidian stone
export const WALL_ACCENT_COLOR = 0x283337 // --ca-panel-navy mortar lines
export const BASEBOARD_COLOR = 0x8b6f4a // --ca-gold-muted baseboard trim

/**
 * Draw wall tiles procedurally with baseboard accents on all floor-adjacent edges,
 * stone mortar grid lines, and doorway shadow depth.
 *
 * Shared between PhaserOfficeScene and PhaserEditorScene.
 */
export function drawWalls(
  g: Phaser.GameObjects.Graphics,
  tileMap: number[][],
  rows: number,
  cols: number
): void {
  const isFloor = (r: number, c: number): boolean =>
    r >= 0 &&
    r < rows &&
    c >= 0 &&
    c < cols &&
    tileMap[r][c] !== TileType.WALL &&
    tileMap[r][c] !== TileType.VOID

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (tileMap[r][c] !== TileType.WALL) continue

      const x = c * TILE_SIZE
      const y = r * TILE_SIZE

      // Wall base fill
      g.fillStyle(WALL_BASE_COLOR, 1)
      g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

      // Stone mortar grid lines — horizontal and vertical for textured look
      g.lineStyle(1, WALL_ACCENT_COLOR, 0.3)
      // Horizontal mortar lines every 4px
      for (let my = 4; my < TILE_SIZE; my += 4) {
        g.lineBetween(x, y + my, x + TILE_SIZE, y + my)
      }
      // Vertical mortar lines offset per row for a brick pattern
      const vOffset = (r % 2) * (TILE_SIZE / 2)
      for (let mx = vOffset; mx < TILE_SIZE; mx += TILE_SIZE) {
        g.lineStyle(1, WALL_ACCENT_COLOR, 0.2)
        g.lineBetween(x + (mx % TILE_SIZE), y, x + (mx % TILE_SIZE), y + TILE_SIZE)
      }
      // Subtle vertical accent line on left edge
      g.lineStyle(1, WALL_ACCENT_COLOR, 0.5)
      g.lineBetween(x, y, x, y + TILE_SIZE)

      // Baseboard accents on ALL edges adjacent to floor tiles
      const hasFloorBelow = isFloor(r + 1, c)
      const hasFloorAbove = isFloor(r - 1, c)
      const hasFloorLeft = isFloor(r, c - 1)
      const hasFloorRight = isFloor(r, c + 1)

      if (hasFloorBelow) {
        g.fillStyle(BASEBOARD_COLOR, 1)
        g.fillRect(x, y + TILE_SIZE - 3, TILE_SIZE, 3)
      }
      if (hasFloorAbove) {
        g.fillStyle(BASEBOARD_COLOR, 1)
        g.fillRect(x, y, TILE_SIZE, 3)
      }
      if (hasFloorLeft) {
        g.fillStyle(BASEBOARD_COLOR, 1)
        g.fillRect(x, y, 3, TILE_SIZE)
      }
      if (hasFloorRight) {
        g.fillStyle(BASEBOARD_COLOR, 1)
        g.fillRect(x + TILE_SIZE - 3, y, 3, TILE_SIZE)
      }

      // Doorway edge shadows — darker shadow on wall tiles that border a doorway
      if (hasFloorBelow || hasFloorAbove) {
        if (hasFloorLeft) {
          g.fillStyle(0x0f1517, 0.4)
          g.fillRect(x, y, 2, TILE_SIZE)
        }
        if (hasFloorRight) {
          g.fillStyle(0x0f1517, 0.4)
          g.fillRect(x + TILE_SIZE - 2, y, 2, TILE_SIZE)
        }
      }
    }
  }
}

/**
 * Convert FloorColor (HSL-ish) to a Phaser hex color number.
 * Improved conversion that produces warm, natural floor tones.
 *
 * Shared between PhaserOfficeScene and PhaserEditorScene.
 */
export function floorColorToHex(color: FloorColor): number {
  const h = ((color.h % 360) + 360) % 360
  // Lower floor + steeper curve — negative b values produce truly dark tones
  const l = Math.max(0.06, Math.min(0.55, 0.25 + color.b / 150))
  const s = Math.max(0.08, Math.min(0.5, 0.25 + color.s / 200))

  // HSL → RGB (simplified)
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r1 = 0,
    g1 = 0,
    b1 = 0
  if (h < 60) {
    r1 = c
    g1 = x
    b1 = 0
  } else if (h < 120) {
    r1 = x
    g1 = c
    b1 = 0
  } else if (h < 180) {
    r1 = 0
    g1 = c
    b1 = x
  } else if (h < 240) {
    r1 = 0
    g1 = x
    b1 = c
  } else if (h < 300) {
    r1 = x
    g1 = 0
    b1 = c
  } else {
    r1 = c
    g1 = 0
    b1 = x
  }

  const ri = Math.round((r1 + m) * 255)
  const gi = Math.round((g1 + m) * 255)
  const bi = Math.round((b1 + m) * 255)
  return (ri << 16) | (gi << 8) | bi
}

// ═══════════════════════════════════════════════════════════════
// Shared Floor Rendering
// ═══════════════════════════════════════════════════════════════

/**
 * Draw floor tiles onto a Phaser Graphics object.
 * Shared between PhaserOfficeScene and PhaserEditorScene to eliminate
 * the duplicated floor rendering loop.
 */
export function drawFloorTiles(
  g: Phaser.GameObjects.Graphics,
  tileMap: TileTypeVal[][],
  layout: OfficeLayout
): void {
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = tileMap[r][c]
      if (tile === TileType.VOID || tile === TileType.WALL) continue

      const x = c * TILE_SIZE
      const y = r * TILE_SIZE

      // Floor: use layout tileColors if available, otherwise warm wood plank palette
      const colorIdx = r * layout.cols + c
      const flrColor = layout.tileColors?.[colorIdx]
      const baseColor = flrColor ? floorColorToHex(flrColor) : PLANK_COLORS[r % PLANK_COLORS.length]

      g.fillStyle(baseColor, 1)
      g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

      // Add subtle plank grain line on top edge
      g.lineStyle(1, 0x2a1a0a, 0.15)
      g.lineBetween(x, y, x + TILE_SIZE, y)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Shared Furniture Rendering
// ═══════════════════════════════════════════════════════════════

/**
 * Get or create a cached Phaser texture key for a SpriteData.
 * Shared texture caching logic used by both scenes.
 */
export function getOrCreateFurnitureTexture(
  scene: Phaser.Scene,
  sprite: SpriteData,
  cache: Map<SpriteData, string>,
  counter: { value: number },
  prefix: string,
  registerFn: (scene: Phaser.Scene, key: string, sprite: SpriteData) => void
): string {
  const cached = cache.get(sprite)
  if (cached) return cached

  const key = `${prefix}-${counter.value++}`
  registerFn(scene, key, sprite)
  cache.set(sprite, key)
  return key
}

/**
 * Create Phaser Image sprites for all furniture instances.
 * Returns the created sprites array.
 *
 * @param centered - If true, sets origin at center (editor mode). If false, sets origin at top-left.
 */
export function createFurnitureSprites(
  scene: Phaser.Scene,
  instances: FurnitureInstance[],
  cache: Map<SpriteData, string>,
  counter: { value: number },
  prefix: string,
  registerFn: (scene: Phaser.Scene, key: string, sprite: SpriteData) => void,
  centered: boolean
): Phaser.GameObjects.Image[] {
  const sprites: Phaser.GameObjects.Image[] = []

  for (const fi of instances) {
    const key = getOrCreateFurnitureTexture(scene, fi.sprite, cache, counter, prefix, registerFn)
    let img: Phaser.GameObjects.Image
    if (centered) {
      const spriteH = fi.sprite.length
      const spriteW = fi.sprite[0]?.length ?? 0
      img = scene.add.image(fi.x + spriteW / 2, fi.y + spriteH / 2, key)
    } else {
      img = scene.add.image(fi.x, fi.y, key)
      img.setOrigin(0, 0)
    }
    img.setDepth(fi.zY)
    if (fi.mirrored) img.setFlipX(true)
    sprites.push(img)
  }

  return sprites
}

/**
 * Destroy all furniture sprites in the array.
 */
export function clearFurnitureSprites(sprites: Phaser.GameObjects.Image[]): void {
  for (const sprite of sprites) {
    sprite.destroy()
  }
  sprites.length = 0
}

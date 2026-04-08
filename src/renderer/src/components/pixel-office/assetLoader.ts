/**
 * Asset loader for the Pixel Office — decodes PNG sprites in the browser using Canvas API.
 *
 * Loads floor tiles, wall tiles, character sprite sheets, and furniture sprites
 * from the bundled assets directory, converts them to SpriteData (string[][]),
 * and feeds them into the engine modules.
 *
 * No pngjs needed — uses browser-native Image + Canvas for decoding.
 */

import { setFloorSprites } from './floorTiles'
import { setWallSprites } from './wallTiles'
import { setCharacterTemplates } from './sprites/spriteData'
import { loadImage, imageToSpriteData, fullImageToSpriteData } from './sprites/imageUtils'
import type { SpriteData } from './engine/types'
import { buildDynamicCatalog } from './layout/furnitureCatalog'
import { FURNITURE_PNG_MAP, FURNITURE_CATALOG } from './furnitureLoader'

// ── Constants ──
const CHAR_FRAME_W = 32
const CHAR_FRAME_H = 32
const CHAR_FRAMES_PER_ROW = 7
const WALL_PIECE_W = 16
const WALL_PIECE_H = 32
const WALL_GRID_COLS = 4
const WALL_BITMASK_COUNT = 16

// ── Import floor tile PNGs ──
import floor0 from '@renderer/assets/pixel-office/floors/floor_0.png'
import floor1 from '@renderer/assets/pixel-office/floors/floor_1.png'
import floor2 from '@renderer/assets/pixel-office/floors/floor_2.png'
import floor3 from '@renderer/assets/pixel-office/floors/floor_3.png'
import floor4 from '@renderer/assets/pixel-office/floors/floor_4.png'
import floor5 from '@renderer/assets/pixel-office/floors/floor_5.png'
import floor6 from '@renderer/assets/pixel-office/floors/floor_6.png'
import floor7 from '@renderer/assets/pixel-office/floors/floor_7.png'
import floor8 from '@renderer/assets/pixel-office/floors/floor_8.png'

const FLOOR_URLS = [floor0, floor1, floor2, floor3, floor4, floor5, floor6, floor7, floor8]

// ── Import wall tile PNG ──
import wall0 from '@renderer/assets/pixel-office/walls/wall_0.png'
const WALL_URLS = [wall0]

// ── Import character sprite sheets ──
import char0 from '@renderer/assets/pixel-office/characters/char_0.png'
import char1 from '@renderer/assets/pixel-office/characters/char_1.png'
import char2 from '@renderer/assets/pixel-office/characters/char_2.png'
import char3 from '@renderer/assets/pixel-office/characters/char_3.png'
import char4 from '@renderer/assets/pixel-office/characters/char_4.png'
import char5 from '@renderer/assets/pixel-office/characters/char_5.png'

const CHAR_URLS = [char0, char1, char2, char3, char4, char5]

// ── Loaders ──

async function loadFloorTiles(ctx: CanvasRenderingContext2D): Promise<SpriteData[]> {
  const sprites: SpriteData[] = []
  for (const url of FLOOR_URLS) {
    try {
      const img = await loadImage(url)
      sprites.push(fullImageToSpriteData(ctx, img))
    } catch {
      // Skip missing floor tiles
      console.warn('Failed to load floor tile:', url)
    }
  }
  return sprites
}

async function loadWallTiles(ctx: CanvasRenderingContext2D): Promise<SpriteData[][]> {
  const sets: SpriteData[][] = []
  for (const url of WALL_URLS) {
    try {
      const img = await loadImage(url)
      const wallSet: SpriteData[] = []
      for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
        const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_W
        const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_H
        wallSet.push(imageToSpriteData(ctx, img, ox, oy, WALL_PIECE_W, WALL_PIECE_H))
      }
      sets.push(wallSet)
    } catch {
      console.warn('Failed to load wall tile:', url)
    }
  }
  return sets
}

interface CharacterDirectionSprites {
  down: SpriteData[]
  up: SpriteData[]
  right: SpriteData[]
}

async function loadCharacterSprites(
  ctx: CanvasRenderingContext2D
): Promise<CharacterDirectionSprites[]> {
  const characters: CharacterDirectionSprites[] = []
  for (const url of CHAR_URLS) {
    try {
      const img = await loadImage(url)
      const directions: ['down', 'up', 'right'] = ['down', 'up', 'right']
      const charData: CharacterDirectionSprites = { down: [], up: [], right: [] }

      for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
        const dir = directions[dirIdx]
        const rowY = dirIdx * CHAR_FRAME_H
        const frames: SpriteData[] = []

        for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
          const frameX = f * CHAR_FRAME_W
          frames.push(imageToSpriteData(ctx, img, frameX, rowY, CHAR_FRAME_W, CHAR_FRAME_H))
        }
        charData[dir] = frames
      }
      characters.push(charData)
    } catch {
      console.warn('Failed to load character sprite:', url)
    }
  }
  return characters
}

async function loadFurnitureAssets(
  ctx: CanvasRenderingContext2D
): Promise<{ catalog: typeof FURNITURE_CATALOG; sprites: Record<string, SpriteData> }> {
  const sprites: Record<string, SpriteData> = {}

  // Load each furniture PNG in parallel
  const entries = Object.entries(FURNITURE_PNG_MAP)
  const loadPromises = entries.map(async ([id, url]) => {
    try {
      const img = await loadImage(url)
      sprites[id] = fullImageToSpriteData(ctx, img)
    } catch {
      console.warn(`[PixelOffice] Failed to load furniture: ${id}`)
    }
  })
  await Promise.all(loadPromises)

  return { catalog: FURNITURE_CATALOG, sprites }
}

// ── Main loader ──

let loaded = false

/**
 * Load all pixel office assets. Call once when the canvas component mounts.
 * Decodes PNGs using Canvas API and feeds SpriteData into engine modules.
 */
export async function loadAllAssets(): Promise<void> {
  if (loaded) return
  loaded = true

  // Create an offscreen canvas for PNG decoding
  const offscreen = document.createElement('canvas')
  const ctx = offscreen.getContext('2d')
  if (!ctx) {
    console.error('Failed to create canvas context for asset loading')
    return
  }
  ctx.imageSmoothingEnabled = false

  console.log('[PixelOffice] Loading assets...')

  try {
    // Load all asset types in parallel
    const [floorSprites, wallSets, charSprites] = await Promise.all([
      loadFloorTiles(ctx),
      loadWallTiles(ctx),
      loadCharacterSprites(ctx)
    ])

    // Feed into engine modules
    if (floorSprites.length > 0) {
      setFloorSprites(floorSprites)
      console.log(`[PixelOffice] Loaded ${floorSprites.length} floor tiles`)
    }

    if (wallSets.length > 0) {
      setWallSprites(wallSets)
      console.log(
        `[PixelOffice] Loaded ${wallSets.length} wall sets (${wallSets[0]?.length ?? 0} pieces each)`
      )
    }

    if (charSprites.length > 0) {
      setCharacterTemplates(charSprites)
      console.log(`[PixelOffice] Loaded ${charSprites.length} character sprites`)
    }

    // Furniture loading
    const furniture = await loadFurnitureAssets(ctx)
    const loadedSpriteCount = Object.keys(furniture.sprites).length
    if (loadedSpriteCount > 0) {
      // Convert catalog to the format buildDynamicCatalog expects
      // Cast to strip 'as const' narrowing — the engine expects mutable objects

      const catalogForEngine = JSON.parse(JSON.stringify(furniture.catalog))
      buildDynamicCatalog({ catalog: catalogForEngine, sprites: furniture.sprites })
      console.log(
        `[PixelOffice] Loaded ${loadedSpriteCount} furniture sprites, ${catalogForEngine.length} catalog entries`
      )
    }

    console.log('[PixelOffice] All assets loaded')
  } catch (err) {
    console.error('[PixelOffice] Asset loading failed:', err)
  }

  // Clean up offscreen canvas
  offscreen.width = 0
  offscreen.height = 0
}

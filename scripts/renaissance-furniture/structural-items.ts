import { PixelCanvas, type RgbaColor, createPixelCanvas } from './pixel-canvas'
import type {
  FurnitureAssetManifest,
  FurnitureCategory,
  GeneratedFurnitureItem,
  RenaissanceFurnitureId,
  RenaissanceFurnitureSpec
} from './types'

const TRANSPARENT: RgbaColor = { r: 0, g: 0, b: 0, a: 0 }
const OUTLINE: RgbaColor = { r: 33, g: 23, b: 20 }
const STONE_DARK: RgbaColor = { r: 98, g: 102, b: 111 }
const STONE_MID: RgbaColor = { r: 132, g: 138, b: 148 }
const STONE_LIGHT: RgbaColor = { r: 176, g: 182, b: 193 }
const CRIMSON_DARK: RgbaColor = { r: 96, g: 20, b: 32 }
const CRIMSON_MID: RgbaColor = { r: 144, g: 36, b: 52 }
const GOLD_DARK: RgbaColor = { r: 124, g: 90, b: 26 }
const GOLD_LIGHT: RgbaColor = { r: 201, g: 163, b: 62 }
const WOOD_DARK: RgbaColor = { r: 93, g: 63, b: 40 }
const WOOD_MID: RgbaColor = { r: 136, g: 96, b: 56 }
const PARCHMENT: RgbaColor = { r: 222, g: 205, b: 160 }
const BRONZE_DARK: RgbaColor = { r: 96, g: 69, b: 36 }
const BRONZE_MID: RgbaColor = { r: 136, g: 97, b: 52 }
const FLAME: RgbaColor = { r: 232, g: 180, b: 94 }

interface AssetOptions {
  id: RenaissanceFurnitureId
  name: string
  category: FurnitureCategory
  width: number
  height: number
  footprintW: number
  footprintH: number
  canPlaceOnWalls: boolean
  canPlaceOnSurfaces: boolean
  backgroundTiles: number
  draw: (canvas: PixelCanvas) => void
}

function fillAndOutline(
  canvas: PixelCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: RgbaColor,
  outline: RgbaColor = OUTLINE
): void {
  canvas.fillRect(x, y, width, height, fill)
  canvas.strokeRect(x, y, width, height, outline)
}

function createAssetItem(options: AssetOptions): GeneratedFurnitureItem {
  const canvas = createPixelCanvas(options.width, options.height)
  canvas.clear(TRANSPARENT)
  options.draw(canvas)

  const manifest: FurnitureAssetManifest = {
    id: options.id,
    name: options.name,
    category: options.category,
    type: 'asset',
    canPlaceOnWalls: options.canPlaceOnWalls,
    canPlaceOnSurfaces: options.canPlaceOnSurfaces,
    backgroundTiles: options.backgroundTiles,
    width: options.width,
    height: options.height,
    footprintW: options.footprintW,
    footprintH: options.footprintH
  }

  return {
    id: options.id,
    manifest,
    pngs: [{ fileName: `${options.id}.png`, png: canvas.png }]
  }
}

function generateStatue(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'STATUE',
    name: 'Statue',
    category: 'decor',
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    draw: (canvas) => {
      fillAndOutline(canvas, 3, 24, 10, 6, STONE_MID)
      canvas.fillRect(4, 25, 8, 1, STONE_LIGHT)
      fillAndOutline(canvas, 5, 11, 6, 13, STONE_MID)
      canvas.fillRect(6, 12, 2, 11, STONE_LIGHT)
      canvas.fillRect(4, 14, 1, 6, STONE_MID)
      canvas.fillRect(11, 14, 1, 6, STONE_DARK)
      fillAndOutline(canvas, 6, 7, 4, 4, STONE_LIGHT)
      canvas.setPixel(7, 8, OUTLINE)
      canvas.setPixel(8, 8, OUTLINE)
    }
  })
}

function generateBanner(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'BANNER',
    name: 'Banner',
    category: 'wall',
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    canPlaceOnWalls: true,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    draw: (canvas) => {
      canvas.vLine(7, 2, 27, GOLD_DARK)
      canvas.vLine(8, 2, 27, GOLD_LIGHT)
      fillAndOutline(canvas, 9, 6, 5, 18, CRIMSON_MID)
      canvas.fillRect(10, 7, 1, 16, CRIMSON_DARK)
      canvas.fillRect(12, 7, 1, 16, { r: 182, g: 58, b: 74 })
      canvas.fillRect(10, 24, 3, 1, GOLD_DARK)
      canvas.setPixel(9, 24, OUTLINE)
      canvas.setPixel(13, 24, OUTLINE)
      canvas.setPixel(10, 25, CRIMSON_MID)
      canvas.setPixel(12, 25, CRIMSON_DARK)
      canvas.setPixel(11, 26, OUTLINE)
      canvas.setPixel(9, 5, GOLD_DARK)
      canvas.setPixel(13, 5, GOLD_DARK)
    }
  })
}

function generateStonePillar(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'STONE_PILLAR',
    name: 'Stone Pillar',
    category: 'decor',
    width: 16,
    height: 48,
    footprintW: 1,
    footprintH: 3,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    draw: (canvas) => {
      fillAndOutline(canvas, 3, 38, 10, 8, STONE_MID)
      fillAndOutline(canvas, 4, 8, 8, 30, STONE_MID)
      canvas.fillRect(5, 9, 2, 28, STONE_LIGHT)
      canvas.fillRect(10, 9, 1, 28, STONE_DARK)
      fillAndOutline(canvas, 3, 4, 10, 5, STONE_LIGHT)
      canvas.fillRect(5, 5, 6, 1, STONE_DARK)
      canvas.hLine(4, 11, 18, STONE_DARK)
      canvas.hLine(4, 11, 28, STONE_DARK)
    }
  })
}

function generateScrollRack(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'SCROLL_RACK',
    name: 'Scroll Rack',
    category: 'storage',
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    draw: (canvas) => {
      fillAndOutline(canvas, 5, 22, 22, 6, WOOD_MID)
      fillAndOutline(canvas, 6, 12, 20, 10, WOOD_DARK)
      canvas.fillRect(9, 14, 3, 6, PARCHMENT)
      canvas.fillRect(13, 14, 3, 6, PARCHMENT)
      canvas.fillRect(17, 14, 3, 6, PARCHMENT)
      canvas.fillRect(21, 14, 3, 6, PARCHMENT)
      canvas.strokeRect(9, 14, 3, 6, OUTLINE)
      canvas.strokeRect(13, 14, 3, 6, OUTLINE)
      canvas.strokeRect(17, 14, 3, 6, OUTLINE)
      canvas.strokeRect(21, 14, 3, 6, OUTLINE)
      canvas.fillRect(4, 10, 2, 18, WOOD_DARK)
      canvas.fillRect(26, 10, 2, 18, WOOD_DARK)
      canvas.fillRect(5, 10, 1, 18, WOOD_MID)
      canvas.fillRect(26, 10, 1, 18, WOOD_MID)
      canvas.setPixel(10, 16, GOLD_DARK)
      canvas.setPixel(14, 16, GOLD_DARK)
      canvas.setPixel(18, 16, GOLD_DARK)
      canvas.setPixel(22, 16, GOLD_DARK)
    }
  })
}

function generateChandelier(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'CHANDELIER',
    name: 'Chandelier',
    category: 'decor',
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    draw: (canvas) => {
      canvas.vLine(16, 2, 8, BRONZE_DARK)
      canvas.vLine(15, 2, 8, BRONZE_MID)
      fillAndOutline(canvas, 10, 11, 12, 4, BRONZE_MID)
      canvas.fillRect(9, 14, 14, 2, BRONZE_DARK)
      canvas.hLine(8, 24, 16, BRONZE_MID)
      canvas.vLine(9, 14, 21, BRONZE_DARK)
      canvas.vLine(22, 14, 21, BRONZE_DARK)
      canvas.vLine(15, 15, 22, BRONZE_DARK)
      canvas.vLine(16, 15, 22, BRONZE_MID)
      fillAndOutline(canvas, 8, 20, 3, 3, GOLD_LIGHT)
      fillAndOutline(canvas, 14, 21, 4, 3, GOLD_LIGHT)
      fillAndOutline(canvas, 21, 20, 3, 3, GOLD_LIGHT)
      canvas.setPixel(9, 19, FLAME)
      canvas.setPixel(16, 20, FLAME)
      canvas.setPixel(22, 19, FLAME)
    }
  })
}

function generateArchway(): GeneratedFurnitureItem {
  return createAssetItem({
    id: 'ARCHWAY',
    name: 'Archway',
    category: 'wall',
    width: 32,
    height: 48,
    footprintW: 2,
    footprintH: 3,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    draw: (canvas) => {
      fillAndOutline(canvas, 5, 18, 7, 28, STONE_MID)
      fillAndOutline(canvas, 20, 18, 7, 28, STONE_MID)
      fillAndOutline(canvas, 10, 8, 12, 12, STONE_MID)
      canvas.fillRect(6, 19, 2, 26, STONE_LIGHT)
      canvas.fillRect(21, 19, 2, 26, STONE_LIGHT)
      canvas.fillRect(11, 9, 8, 2, STONE_LIGHT)
      canvas.fillRect(12, 12, 6, 2, STONE_DARK)
      canvas.fillRect(12, 20, 8, 26, TRANSPARENT)
      canvas.fillRect(12, 14, 2, 6, TRANSPARENT)
      canvas.fillRect(18, 14, 2, 6, TRANSPARENT)
      canvas.fillRect(14, 12, 4, 3, TRANSPARENT)
      canvas.strokeRect(12, 20, 8, 26, OUTLINE)
      canvas.setPixel(12, 20, TRANSPARENT)
      canvas.setPixel(19, 20, TRANSPARENT)
      canvas.setPixel(12, 45, TRANSPARENT)
      canvas.setPixel(19, 45, TRANSPARENT)
      canvas.hLine(12, 19, 20, STONE_DARK)
    }
  })
}

export const structuralItemSpecs: RenaissanceFurnitureSpec[] = [
  {
    id: 'STATUE',
    description: 'Tall stone statue',
    generator: generateStatue
  },
  {
    id: 'BANNER',
    description: 'Vertical hanging cloth banner',
    generator: generateBanner
  },
  {
    id: 'STONE_PILLAR',
    description: 'Stone support pillar',
    generator: generateStonePillar
  },
  {
    id: 'SCROLL_RACK',
    description: 'Scroll shelf and rack',
    generator: generateScrollRack
  },
  {
    id: 'CHANDELIER',
    description: 'Suspended ornate chandelier',
    generator: generateChandelier
  },
  {
    id: 'ARCHWAY',
    description: 'Stone arch opening',
    generator: generateArchway
  }
]

import { createPixelCanvas, type PixelCanvas } from './pixel-canvas'
import type {
  FurnitureCategory,
  FurnitureManifest,
  GeneratedFurnitureItem,
  RenaissanceFurnitureSpec
} from './types'

const TILE_SIZE = 16

type SimpleItemId = 'CANDELABRA' | 'FLOOR_CANDLES' | 'SPIDER_WEB' | 'TREASURE_CHEST' | 'WINE_BARREL'

interface SimpleItemConfig {
  id: SimpleItemId
  name: string
  description: string
  category: FurnitureCategory
  canPlaceOnWalls: boolean
  canPlaceOnSurfaces: boolean
  draw: (canvas: PixelCanvas) => void
}

const PALETTE = {
  outline: { r: 28, g: 20, b: 16 },
  brass: { r: 180, g: 136, b: 68 },
  brassHighlight: { r: 222, g: 188, b: 102 },
  wax: { r: 238, g: 224, b: 188 },
  waxShade: { r: 206, g: 184, b: 150 },
  flameCore: { r: 255, g: 242, b: 170 },
  flameGlow: { r: 242, g: 148, b: 64 },
  web: { r: 212, g: 214, b: 226, a: 208 },
  webDim: { r: 160, g: 164, b: 182, a: 170 },
  wood: { r: 126, g: 74, b: 39 },
  woodDark: { r: 84, g: 48, b: 25 },
  woodLight: { r: 172, g: 110, b: 62 },
  metal: { r: 182, g: 152, b: 78 },
  shadow: { r: 0, g: 0, b: 0, a: 110 }
} as const

function makeSimpleManifest(config: SimpleItemConfig): FurnitureManifest {
  return {
    id: config.id,
    name: config.name,
    category: config.category,
    type: 'asset',
    canPlaceOnWalls: config.canPlaceOnWalls,
    canPlaceOnSurfaces: config.canPlaceOnSurfaces,
    backgroundTiles: 0,
    width: TILE_SIZE,
    height: TILE_SIZE,
    footprintW: 1,
    footprintH: 1
  }
}

function makeSimpleItem(config: SimpleItemConfig): GeneratedFurnitureItem {
  const canvas = createPixelCanvas(TILE_SIZE, TILE_SIZE)
  config.draw(canvas)

  return {
    id: config.id,
    manifest: makeSimpleManifest(config),
    pngs: [
      {
        fileName: `${config.id}.png`,
        png: canvas.png
      }
    ]
  }
}

function drawCandelabra(canvas: PixelCanvas): void {
  const x = 4
  const y = 2

  canvas.fillRect(x + 1, y + 10, 6, 1, PALETTE.brass)
  canvas.strokeRect(x + 1, y + 10, 6, 1, PALETTE.outline)
  canvas.fillRect(x + 3, y + 6, 2, 5, PALETTE.brass)
  canvas.strokeRect(x + 3, y + 6, 2, 5, PALETTE.outline)
  canvas.fillRect(x + 2, y + 5, 4, 1, PALETTE.brass)
  canvas.strokeRect(x + 2, y + 5, 4, 1, PALETTE.outline)

  const candleXs = [x + 2, x + 4, x + 6]
  for (const candleX of candleXs) {
    canvas.fillRect(candleX, y + 3, 1, 3, PALETTE.wax)
    canvas.setPixel(candleX, y + 5, PALETTE.waxShade)
    canvas.setPixel(candleX, y + 2, PALETTE.flameGlow)
    canvas.setPixel(candleX, y + 1, PALETTE.flameCore)
  }

  canvas.hLine(x + 2, x + 6, y + 11, PALETTE.shadow)
}

function drawFloorCandles(canvas: PixelCanvas): void {
  const baseX = 4
  const baseY = 4
  const candles = [
    { x: baseX + 1, y: baseY + 3, h: 5 },
    { x: baseX + 4, y: baseY + 2, h: 6 },
    { x: baseX + 7, y: baseY + 4, h: 4 }
  ]

  for (const candle of candles) {
    canvas.fillRect(candle.x, candle.y, 1, candle.h, PALETTE.wax)
    canvas.setPixel(candle.x, candle.y + candle.h - 1, PALETTE.waxShade)
    canvas.setPixel(candle.x, candle.y - 1, PALETTE.flameGlow)
    canvas.setPixel(candle.x, candle.y - 2, PALETTE.flameCore)
  }

  canvas.fillRect(baseX, baseY + 8, 10, 1, PALETTE.brass)
  canvas.strokeRect(baseX, baseY + 8, 10, 1, PALETTE.outline)
  canvas.hLine(baseX + 1, baseX + 9, baseY + 9, PALETTE.shadow)
}

function drawSpiderWeb(canvas: PixelCanvas): void {
  const cx = 7
  const cy = 7

  canvas.setPixel(cx, cy, PALETTE.web)
  canvas.hLine(3, 11, cy, PALETTE.webDim)
  canvas.vLine(cx, 3, 11, PALETTE.webDim)
  canvas.hLine(4, 10, 5, PALETTE.web)
  canvas.hLine(4, 10, 9, PALETTE.web)
  canvas.vLine(5, 4, 10, PALETTE.web)
  canvas.vLine(9, 4, 10, PALETTE.web)

  const spokes = [
    [4, 4],
    [10, 4],
    [4, 10],
    [10, 10]
  ]

  for (const [sx, sy] of spokes) {
    canvas.setPixel(sx, sy, PALETTE.web)
    const midX = Math.round((sx + cx) / 2)
    const midY = Math.round((sy + cy) / 2)
    canvas.setPixel(midX, midY, PALETTE.web)
  }
}

function drawTreasureChest(canvas: PixelCanvas): void {
  const x = 3
  const y = 5

  canvas.fillRect(x, y + 3, 10, 5, PALETTE.wood)
  canvas.strokeRect(x, y + 3, 10, 5, PALETTE.outline)
  canvas.fillRect(x + 1, y, 8, 4, PALETTE.woodLight)
  canvas.strokeRect(x + 1, y, 8, 4, PALETTE.outline)

  canvas.hLine(x + 1, x + 8, y + 2, PALETTE.woodDark)
  canvas.vLine(x + 2, y + 4, y + 7, PALETTE.metal)
  canvas.vLine(x + 5, y + 4, y + 7, PALETTE.metal)
  canvas.vLine(x + 8, y + 4, y + 7, PALETTE.metal)

  canvas.fillRect(x + 4, y + 4, 2, 2, PALETTE.metal)
  canvas.setPixel(x + 4, y + 5, PALETTE.outline)
  canvas.setPixel(x + 5, y + 5, PALETTE.outline)
  canvas.hLine(x + 2, x + 9, y + 8, PALETTE.shadow)
}

function drawWineBarrel(canvas: PixelCanvas): void {
  const x = 4
  const y = 3

  canvas.fillRect(x + 1, y, 6, 1, PALETTE.woodDark)
  canvas.fillRect(x, y + 1, 8, 8, PALETTE.wood)
  canvas.fillRect(x + 1, y + 9, 6, 1, PALETTE.woodDark)
  canvas.strokeRect(x, y + 1, 8, 8, PALETTE.outline)
  canvas.hLine(x + 1, x + 6, y, PALETTE.outline)
  canvas.hLine(x + 1, x + 6, y + 9, PALETTE.outline)

  canvas.hLine(x, x + 7, y + 3, PALETTE.metal)
  canvas.hLine(x, x + 7, y + 7, PALETTE.metal)
  canvas.vLine(x + 2, y + 2, y + 8, PALETTE.woodLight)
  canvas.vLine(x + 4, y + 2, y + 8, PALETTE.woodLight)
  canvas.vLine(x + 6, y + 2, y + 8, PALETTE.woodLight)
  canvas.hLine(x + 1, x + 6, y + 10, PALETTE.shadow)
}

const SIMPLE_ITEM_CONFIGS: SimpleItemConfig[] = [
  {
    id: 'CANDELABRA',
    name: 'Candelabra',
    description: 'Simple floor candelabra with three candles',
    category: 'decor',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: true,
    draw: drawCandelabra
  },
  {
    id: 'FLOOR_CANDLES',
    name: 'Floor Candles',
    description: 'Clustered floor candles with warm highlights',
    category: 'decor',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    draw: drawFloorCandles
  },
  {
    id: 'SPIDER_WEB',
    name: 'Spider Web',
    description: 'Thin cobweb decorative sprite',
    category: 'wall',
    canPlaceOnWalls: true,
    canPlaceOnSurfaces: false,
    draw: drawSpiderWeb
  },
  {
    id: 'TREASURE_CHEST',
    name: 'Treasure Chest',
    description: 'Closed chest with metallic trim',
    category: 'storage',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    draw: drawTreasureChest
  },
  {
    id: 'WINE_BARREL',
    name: 'Wine Barrel',
    description: 'Rounded barrel with wood slats and metal bands',
    category: 'storage',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    draw: drawWineBarrel
  }
]

export const simpleItemSpecs: RenaissanceFurnitureSpec[] = SIMPLE_ITEM_CONFIGS.map((config) => ({
  id: config.id,
  description: config.description,
  generator: () => makeSimpleItem(config)
}))

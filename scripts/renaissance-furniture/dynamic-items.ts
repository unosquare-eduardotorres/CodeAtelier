import { createPixelCanvas, type PixelCanvas, type RgbaColor } from './pixel-canvas'
import type {
  FurnitureAssetNode,
  FurnitureGroupManifest,
  GeneratedFurnitureItem,
  GeneratedPng,
  RenaissanceFurnitureSpec
} from './types'

const COLORS = {
  outline: { r: 36, g: 24, b: 18 } as RgbaColor,
  shadow: { r: 62, g: 49, b: 44 } as RgbaColor,
  stone: { r: 125, g: 120, b: 114 } as RgbaColor,
  stoneLight: { r: 165, g: 160, b: 152 } as RgbaColor,
  wood: { r: 123, g: 85, b: 52 } as RgbaColor,
  woodLight: { r: 162, g: 117, b: 70 } as RgbaColor,
  bronze: { r: 155, g: 103, b: 45 } as RgbaColor,
  bronzeLight: { r: 201, g: 151, b: 77 } as RgbaColor,
  coal: { r: 48, g: 41, b: 37 } as RgbaColor,
  water: { r: 72, g: 145, b: 180 } as RgbaColor,
  waterLight: { r: 122, g: 198, b: 227 } as RgbaColor,
  fireOuter: { r: 228, g: 97, b: 34 } as RgbaColor,
  fireCore: { r: 255, g: 197, b: 70 } as RgbaColor,
  flameGlow: { r: 245, g: 151, b: 54 } as RgbaColor,
  cloth: { r: 112, g: 44, b: 29 } as RgbaColor,
  glassBlue: { r: 92, g: 162, b: 194 } as RgbaColor,
  glassGreen: { r: 119, g: 172, b: 110 } as RgbaColor,
  glassPink: { r: 182, g: 118, b: 156 } as RgbaColor
}

function makePng(
  fileName: string,
  width: number,
  height: number,
  draw: (canvas: PixelCanvas) => void
): GeneratedPng {
  const canvas = createPixelCanvas(width, height)
  draw(canvas)
  return { fileName, png: canvas.png }
}

function animatedMembers(
  idPrefix: string,
  fileNames: string[],
  width: number,
  height: number,
  footprintW: number,
  footprintH: number
): FurnitureAssetNode[] {
  return fileNames.map((file, frame) => ({
    type: 'asset',
    id: `${idPrefix}_${frame + 1}`,
    file,
    width,
    height,
    footprintW,
    footprintH,
    frame
  }))
}

function drawTorchSconceFrame(canvas: PixelCanvas, frame: number): void {
  const tipX = [8, 7, 9][frame % 3]
  const tipY = [6, 7, 7][frame % 3]
  const sideSpark = [
    { x: 6, y: 8 },
    { x: 10, y: 9 },
    { x: 6, y: 9 }
  ][frame % 3]

  canvas.fillRect(7, 13, 2, 12, COLORS.shadow)
  canvas.fillRect(5, 22, 6, 3, COLORS.bronze)
  canvas.strokeRect(5, 22, 6, 3, COLORS.outline)
  canvas.fillRect(6, 14, 4, 3, COLORS.bronze)
  canvas.strokeRect(6, 14, 4, 3, COLORS.outline)
  canvas.fillRect(7, 24, 2, 3, COLORS.bronzeLight)
  canvas.strokeRect(7, 24, 2, 3, COLORS.outline)

  canvas.setPixel(tipX, tipY, COLORS.fireCore)
  canvas.setPixel(8, 7, COLORS.fireCore)
  canvas.setPixel(7, 8, COLORS.flameGlow)
  canvas.setPixel(8, 8, COLORS.fireOuter)
  canvas.setPixel(9, 8, COLORS.flameGlow)
  canvas.setPixel(8, 9, COLORS.fireOuter)
  canvas.setPixel(sideSpark.x, sideSpark.y, COLORS.fireCore)
}

function drawFountainFrame(canvas: PixelCanvas, frame: number): void {
  const columnHeight = [8, 10, 9][frame % 3]
  const splashOffsets = [
    [
      { x: 15, y: 10 },
      { x: 17, y: 10 },
      { x: 14, y: 11 }
    ],
    [
      { x: 14, y: 9 },
      { x: 18, y: 9 },
      { x: 16, y: 8 }
    ],
    [
      { x: 15, y: 9 },
      { x: 17, y: 9 },
      { x: 18, y: 11 }
    ]
  ][frame % 3]

  canvas.fillRect(6, 21, 20, 9, COLORS.stone)
  canvas.strokeRect(6, 21, 20, 9, COLORS.outline)
  canvas.fillRect(9, 23, 14, 4, COLORS.water)
  canvas.hLine(10, 21, 24, COLORS.waterLight)

  canvas.fillRect(14, 21 - columnHeight, 4, columnHeight, COLORS.water)
  canvas.hLine(14, 17, 21 - columnHeight, COLORS.waterLight)
  canvas.hLine(15, 16, 22 - columnHeight, COLORS.waterLight)
  canvas.fillRect(13, 20, 6, 2, COLORS.stoneLight)
  canvas.strokeRect(13, 20, 6, 2, COLORS.outline)

  for (const droplet of splashOffsets) {
    canvas.setPixel(droplet.x, droplet.y, COLORS.waterLight)
  }
  canvas.setPixel(12, 24 + (frame % 2), COLORS.waterLight)
  canvas.setPixel(20, 24 + ((frame + 1) % 2), COLORS.waterLight)
}

function drawFirepitFrame(canvas: PixelCanvas, frame: number): void {
  const flamePatterns = [
    [
      { x: 15, y: 6, c: COLORS.fireCore },
      { x: 14, y: 7, c: COLORS.flameGlow },
      { x: 15, y: 7, c: COLORS.fireOuter },
      { x: 16, y: 7, c: COLORS.flameGlow },
      { x: 14, y: 8, c: COLORS.fireOuter },
      { x: 15, y: 8, c: COLORS.fireCore },
      { x: 16, y: 8, c: COLORS.fireOuter }
    ],
    [
      { x: 16, y: 5, c: COLORS.fireCore },
      { x: 15, y: 6, c: COLORS.flameGlow },
      { x: 16, y: 6, c: COLORS.fireOuter },
      { x: 17, y: 6, c: COLORS.flameGlow },
      { x: 15, y: 7, c: COLORS.fireOuter },
      { x: 16, y: 7, c: COLORS.fireCore },
      { x: 17, y: 7, c: COLORS.fireOuter }
    ],
    [
      { x: 14, y: 6, c: COLORS.fireCore },
      { x: 13, y: 7, c: COLORS.flameGlow },
      { x: 14, y: 7, c: COLORS.fireOuter },
      { x: 15, y: 7, c: COLORS.flameGlow },
      { x: 14, y: 8, c: COLORS.fireCore },
      { x: 15, y: 8, c: COLORS.fireOuter },
      { x: 16, y: 8, c: COLORS.flameGlow }
    ]
  ][frame % 3]

  canvas.fillRect(6, 8, 20, 7, COLORS.stone)
  canvas.strokeRect(6, 8, 20, 7, COLORS.outline)
  canvas.fillRect(9, 9, 14, 4, COLORS.coal)
  canvas.hLine(11, 20, 12, COLORS.wood)
  canvas.hLine(10, 21, 11, COLORS.woodLight)

  for (const px of flamePatterns) {
    canvas.setPixel(px.x, px.y, px.c)
  }
  canvas.setPixel(18, 7 + (frame % 2), COLORS.fireCore)
}

function drawAlchemyFront(canvas: PixelCanvas): void {
  canvas.fillRect(4, 12, 24, 4, COLORS.woodLight)
  canvas.strokeRect(4, 12, 24, 4, COLORS.outline)
  canvas.fillRect(5, 18, 22, 3, COLORS.wood)
  canvas.strokeRect(5, 18, 22, 3, COLORS.outline)
  canvas.fillRect(6, 16, 3, 12, COLORS.wood)
  canvas.fillRect(23, 16, 3, 12, COLORS.wood)
  canvas.strokeRect(6, 16, 3, 12, COLORS.outline)
  canvas.strokeRect(23, 16, 3, 12, COLORS.outline)
  canvas.fillRect(12, 13, 2, 3, COLORS.glassBlue)
  canvas.fillRect(17, 13, 2, 3, COLORS.glassGreen)
  canvas.setPixel(13, 12, COLORS.fireCore)
  canvas.setPixel(18, 12, COLORS.fireCore)
  canvas.fillRect(15, 18, 2, 3, COLORS.glassPink)
  canvas.fillRect(10, 18, 3, 2, COLORS.bronze)
  canvas.fillRect(19, 18, 3, 2, COLORS.cloth)
}

function drawAlchemySide(canvas: PixelCanvas): void {
  canvas.fillRect(2, 12, 12, 4, COLORS.woodLight)
  canvas.strokeRect(2, 12, 12, 4, COLORS.outline)
  canvas.fillRect(3, 18, 10, 3, COLORS.wood)
  canvas.strokeRect(3, 18, 10, 3, COLORS.outline)
  canvas.fillRect(3, 16, 3, 12, COLORS.wood)
  canvas.fillRect(10, 16, 3, 12, COLORS.wood)
  canvas.strokeRect(3, 16, 3, 12, COLORS.outline)
  canvas.strokeRect(10, 16, 3, 12, COLORS.outline)
  canvas.fillRect(7, 13, 2, 3, COLORS.glassBlue)
  canvas.setPixel(8, 12, COLORS.fireCore)
  canvas.fillRect(6, 18, 2, 3, COLORS.glassGreen)
}

function generateTorchSconce(): GeneratedFurnitureItem {
  const frameFiles = ['TORCH_SCONCE_1.png', 'TORCH_SCONCE_2.png', 'TORCH_SCONCE_3.png']
  const pngs = frameFiles.map((file, index) => makePng(file, 16, 32, (canvas) => drawTorchSconceFrame(canvas, index)))
  const manifest: FurnitureGroupManifest = {
    id: 'TORCH_SCONCE',
    name: 'Torch Sconce',
    category: 'wall',
    type: 'group',
    groupType: 'animation',
    canPlaceOnWalls: true,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    members: animatedMembers('TORCH_SCONCE', frameFiles, 16, 32, 1, 2)
  }
  return { id: 'TORCH_SCONCE', manifest, pngs }
}

function generateFountain(): GeneratedFurnitureItem {
  const frameFiles = ['FOUNTAIN_1.png', 'FOUNTAIN_2.png', 'FOUNTAIN_3.png']
  const pngs = frameFiles.map((file, index) => makePng(file, 32, 32, (canvas) => drawFountainFrame(canvas, index)))
  const manifest: FurnitureGroupManifest = {
    id: 'FOUNTAIN',
    name: 'Fountain',
    category: 'decor',
    type: 'group',
    groupType: 'animation',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    members: animatedMembers('FOUNTAIN', frameFiles, 32, 32, 2, 2)
  }
  return { id: 'FOUNTAIN', manifest, pngs }
}

function generateFirepit(): GeneratedFurnitureItem {
  const frameFiles = ['FIREPIT_1.png', 'FIREPIT_2.png', 'FIREPIT_3.png']
  const pngs = frameFiles.map((file, index) => makePng(file, 32, 16, (canvas) => drawFirepitFrame(canvas, index)))
  const manifest: FurnitureGroupManifest = {
    id: 'FIREPIT',
    name: 'Firepit',
    category: 'decor',
    type: 'group',
    groupType: 'animation',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    members: animatedMembers('FIREPIT', frameFiles, 32, 16, 2, 1)
  }
  return { id: 'FIREPIT', manifest, pngs }
}

function generateAlchemyTable(): GeneratedFurnitureItem {
  const pngs: GeneratedPng[] = [
    makePng('ALCHEMY_TABLE_FRONT.png', 32, 32, drawAlchemyFront),
    makePng('ALCHEMY_TABLE_SIDE.png', 16, 32, drawAlchemySide)
  ]

  const manifest: FurnitureGroupManifest = {
    id: 'ALCHEMY_TABLE',
    name: 'Alchemy Table',
    category: 'desks',
    type: 'group',
    groupType: 'rotation',
    rotationScheme: '2-way',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 1,
    members: [
      {
        type: 'asset',
        id: 'ALCHEMY_TABLE_FRONT',
        file: 'ALCHEMY_TABLE_FRONT.png',
        width: 32,
        height: 32,
        footprintW: 2,
        footprintH: 2,
        orientation: 'front'
      },
      {
        type: 'asset',
        id: 'ALCHEMY_TABLE_SIDE',
        file: 'ALCHEMY_TABLE_SIDE.png',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        orientation: 'side'
      }
    ]
  }

  return { id: 'ALCHEMY_TABLE', manifest, pngs }
}

export const dynamicItemSpecs: RenaissanceFurnitureSpec[] = [
  {
    id: 'TORCH_SCONCE',
    description: 'Wall torch with flame animation frames',
    generator: generateTorchSconce
  },
  {
    id: 'FOUNTAIN',
    description: 'Animated water fountain',
    generator: generateFountain
  },
  {
    id: 'FIREPIT',
    description: 'Animated firepit embers and flame',
    generator: generateFirepit
  },
  {
    id: 'ALCHEMY_TABLE',
    description: 'Rotation-aware workstation table',
    generator: generateAlchemyTable
  }
]

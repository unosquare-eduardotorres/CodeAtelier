import type { PNG } from 'pngjs'

export const RENAISSANCE_FURNITURE_IDS = [
  'CANDELABRA',
  'FLOOR_CANDLES',
  'SPIDER_WEB',
  'TREASURE_CHEST',
  'WINE_BARREL',
  'STATUE',
  'BANNER',
  'STONE_PILLAR',
  'SCROLL_RACK',
  'CHANDELIER',
  'ARCHWAY',
  'TORCH_SCONCE',
  'FOUNTAIN',
  'FIREPIT',
  'ALCHEMY_TABLE'
] as const

export type RenaissanceFurnitureId = (typeof RENAISSANCE_FURNITURE_IDS)[number]
export type FurnitureCategory =
  | 'desks'
  | 'chairs'
  | 'storage'
  | 'decor'
  | 'electronics'
  | 'wall'
  | 'misc'
export type RotationScheme = '2-way' | '3-way-mirror'
export type GroupType = 'rotation' | 'state' | 'animation'
export type Orientation = 'front' | 'back' | 'left' | 'right' | 'side'
export type AssetState = 'on' | 'off'

export interface FurnitureAssetNode {
  type: 'asset'
  id: string
  file?: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  orientation?: Orientation
  state?: AssetState
  mirrorSide?: boolean
  frame?: number
}

export interface FurnitureGroupNode {
  type: 'group'
  groupType: GroupType
  members: FurnitureNode[]
  orientation?: Orientation
  state?: AssetState
  rotationScheme?: RotationScheme
}

export type FurnitureNode = FurnitureAssetNode | FurnitureGroupNode

export interface FurnitureManifestBase {
  id: RenaissanceFurnitureId
  name: string
  category: FurnitureCategory
  canPlaceOnWalls: boolean
  canPlaceOnSurfaces: boolean
  backgroundTiles: number
}

export type FurnitureAssetManifest = FurnitureManifestBase &
  FurnitureAssetNode & {
    type: 'asset'
  }

export type FurnitureGroupManifest = FurnitureManifestBase &
  FurnitureGroupNode & {
    type: 'group'
  }

export type FurnitureManifest = FurnitureAssetManifest | FurnitureGroupManifest

export interface GeneratedPng {
  fileName: string
  png: PNG
}

export interface GeneratedFurnitureItem {
  id: RenaissanceFurnitureId
  manifest: FurnitureManifest
  pngs: GeneratedPng[]
}

export type FurnitureGenerator = () => GeneratedFurnitureItem | Promise<GeneratedFurnitureItem>

export interface RenaissanceFurnitureSpec {
  id: RenaissanceFurnitureId
  description: string
  generator?: FurnitureGenerator
}

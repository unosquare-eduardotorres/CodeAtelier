// Adapted from pixel-agents: webview-ui/src/office/layout/index.ts

export type { CatalogEntryWithCategory, FurnitureCategory } from './furnitureCatalog';
export { FURNITURE_CATEGORIES, getCatalogByCategory, getCatalogEntry } from './furnitureCatalog';
export {
  createDefaultLayout,
  deserializeLayout,
  getBlockedTiles,
  getSeatTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  serializeLayout,
} from './layoutSerializer';
export { findPath, getWalkableTiles, isWalkable } from './tileMap';

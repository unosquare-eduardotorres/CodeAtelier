// Barrel exports for the office editor module
export { default as OfficeEditorPage } from './OfficeEditorPage'
export { default as EditorToolbar } from './EditorToolbar'
export { default as FurniturePalette } from './FurniturePalette'
export { default as PropertyPanel } from './PropertyPanel'
export { default as ColorPicker } from './ColorPicker'
export { default as PhaserEditorCanvas } from './PhaserEditorCanvas'
export { PhaserEditorScene } from './PhaserEditorScene'
export { EditorState } from './editorState'
export { useEditorActions } from './useEditorActions'
export { useEditorKeyboard } from './useEditorKeyboard'

// Re-export editor action pure functions
export {
  paintTile,
  placeFurniture,
  removeFurniture,
  moveFurniture,
  rotateFurniture,
  toggleFurnitureState,
  canPlaceFurniture,
  expandLayout,
  getWallPlacementRow
} from './editorActions'
export type { ExpandDirection } from './editorActions'

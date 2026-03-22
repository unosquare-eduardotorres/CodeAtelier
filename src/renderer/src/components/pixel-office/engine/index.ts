// Adapted from pixel-agents: webview-ui/src/office/engine/index.ts
// Barrel exports for the engine module.

export {
  createCharacter,
  getCharacterSprite,
  isReadingTool,
  updateCharacter,
} from './characters';
export type { GameLoopCallbacks } from './gameLoop';
export { startGameLoop } from './gameLoop';
export { OfficeState } from './officeState';
export type { DeleteButtonBounds, EditorRenderState, SelectionRenderState } from './renderer';
export {
  renderDeleteButton,
  renderFrame,
  renderGhostPreview,
  renderGridOverlay,
  renderScene,
  renderSelectionHighlight,
  renderTileGrid,
} from './renderer';

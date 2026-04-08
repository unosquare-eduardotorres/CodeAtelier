/**
 * TilePaintInput — Handles tile paint, wall paint, and erase pointer dispatch.
 *
 * Extracted from PhaserEditorScene.setupInputHandlers to isolate
 * tile-level input concerns.
 */

import { EditTool, TILE_SIZE } from '../../engine/types'
import type { EditorState } from '../editorState'
import type { EditorInputCallbacks } from './types'

/**
 * Handle pointerdown for non-SELECT painting tools.
 * Fires the tile action and starts drag painting.
 */
export function handlePaintPointerDown(
  editorState: EditorState,
  col: number,
  row: number,
  callbacks: EditorInputCallbacks
): void {
  callbacks.onTileAction?.(col, row)
  editorState.isDragging = true

  // Reset wallDragAdding on new click for wall paint
  if (editorState.activeTool === EditTool.WALL_PAINT) {
    editorState.wallDragAdding = null
  }
}

/**
 * Handle pointermove drag painting for floor/wall/erase tools.
 */
export function handlePaintDrag(
  pointer: Phaser.Input.Pointer,
  editorState: EditorState,
  isDragging: boolean,
  camera: Phaser.Cameras.Scene2D.Camera,
  callbacks: EditorInputCallbacks
): void {
  const worldPoint = camera.getWorldPoint(pointer.x, pointer.y)
  const col = Math.floor(worldPoint.x / TILE_SIZE)
  const row = Math.floor(worldPoint.y / TILE_SIZE)

  // Drag painting for floor/wall/erase
  if (isDragging && pointer.leftButtonDown()) {
    const tool = editorState.activeTool
    if (tool === EditTool.TILE_PAINT || tool === EditTool.WALL_PAINT || tool === EditTool.ERASE) {
      callbacks.onTileAction?.(col, row)
    }
  }

  // Drag erasing with right button or Ctrl+left
  if (
    isDragging &&
    (pointer.rightButtonDown() || (pointer.leftButtonDown() && pointer.event.ctrlKey))
  ) {
    callbacks.onEraseAction?.(col, row)
  }
}

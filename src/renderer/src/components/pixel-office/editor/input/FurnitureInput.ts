/**
 * FurnitureInput — Handles SELECT mode interactions: select, drag-move furniture.
 *
 * Extracted from PhaserEditorScene.setupInputHandlers to isolate
 * furniture selection and drag-move concerns.
 */

import type { EditorState } from '../editorState'
import type { EditorInputCallbacks } from './types'

export interface FurnitureDragState {
  dragStartPointerX: number
  dragStartPointerY: number
}

export function createFurnitureDragState(): FurnitureDragState {
  return {
    dragStartPointerX: 0,
    dragStartPointerY: 0
  }
}

const DRAG_THRESHOLD = 2

/**
 * Handle SELECT mode pointerdown: hit-test furniture for selection or start camera pan.
 * Returns true if handled (caller should return early), false if no hit (caller should start camera pan).
 */
export function handleSelectPointerDown(
  editorState: EditorState,
  col: number,
  row: number,
  pointer: Phaser.Input.Pointer,
  dragState: FurnitureDragState,
  findFurniture: (col: number, row: number) => { uid: string; col: number; row: number } | null,
  canvas: HTMLCanvasElement,
  callbacks: EditorInputCallbacks
): boolean {
  const hit = findFurniture(col, row)
  if (hit) {
    // Select the furniture and start drag tracking
    editorState.selectedFurnitureUid = hit.uid
    editorState.startDrag(hit.uid, hit.col, hit.row, col - hit.col, row - hit.row)
    dragState.dragStartPointerX = pointer.x
    dragState.dragStartPointerY = pointer.y
    canvas.style.cursor = 'move'
    callbacks.onSelectionChange?.()
    return true
  } else {
    // No furniture hit → deselect and let caller start camera pan
    editorState.selectedFurnitureUid = null
    callbacks.onSelectionChange?.()
    return false
  }
}

/**
 * Handle furniture drag-move during pointermove in SELECT mode.
 * Returns true if drag-move was active (caller should return early).
 */
export function handleFurnitureDragMove(
  pointer: Phaser.Input.Pointer,
  editorState: EditorState,
  col: number,
  row: number,
  dragState: FurnitureDragState,
  callbacks: EditorInputCallbacks
): boolean {
  if (!editorState.dragUid || !pointer.leftButtonDown()) return false

  const dist = Math.sqrt(
    (pointer.x - dragState.dragStartPointerX) ** 2 +
    (pointer.y - dragState.dragStartPointerY) ** 2
  )
  if (dist > DRAG_THRESHOLD) {
    editorState.isDragMoving = true
    const newCol = col - editorState.dragOffsetCol
    const newRow = row - editorState.dragOffsetRow
    callbacks.onDragMove?.(editorState.dragUid, newCol, newRow)
  }
  return true
}

/**
 * Finalize furniture drag-move on pointer up.
 */
export function endFurnitureDrag(
  editorState: EditorState | null,
  updateCursor: () => void
): void {
  if (editorState?.dragUid) {
    editorState.clearDrag()
    updateCursor()
  }
}

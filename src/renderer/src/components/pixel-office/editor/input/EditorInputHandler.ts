/**
 * EditorInputHandler — Orchestrates all editor input by composing focused handlers.
 *
 * Replaces the 190-line setupInputHandlers monolith (complexity 31) with
 * a composition of focused handlers:
 * - CameraPanHandler: camera drag state + scroll
 * - TilePaintInput: paint/erase pointer dispatch
 * - FurnitureInput: SELECT mode selection + drag-move
 *
 * Each handler is testable independently with mock Phaser input.
 */

import { EditTool, TILE_SIZE } from '../../engine/types'
import type { EditorState } from '../editorState'
import type { EditorInputCallbacks } from './types'
import {
  type CameraPanState,
  createCameraPanState,
  endCameraPan,
  handleCameraPanMove,
  setupCameraKeyboardHandlers,
  setupScrollHandler,
  tryStartCameraPan
} from './CameraPanHandler'
import { handlePaintPointerDown, handlePaintDrag } from './TilePaintInput'
import {
  type FurnitureDragState,
  createFurnitureDragState,
  endFurnitureDrag,
  handleFurnitureDragMove,
  handleSelectPointerDown
} from './FurnitureInput'

interface InputHandlerDeps {
  scene: Phaser.Scene
  getEditorState: () => EditorState | null
  getCallbacks: () => EditorInputCallbacks
  findFurnitureAtTile: (
    col: number,
    row: number
  ) => { uid: string; col: number; row: number } | null
  updateCursor: () => void
  setIsDragging: (dragging: boolean) => void
  getIsDragging: () => boolean
}

/**
 * Set up all editor input handlers on the given Phaser scene.
 * Composes CameraPanHandler, TilePaintInput, and FurnitureInput.
 */
export function setupEditorInput(deps: InputHandlerDeps): void {
  const {
    scene,
    getEditorState,
    getCallbacks,
    findFurnitureAtTile,
    updateCursor,
    setIsDragging,
    getIsDragging
  } = deps

  const cameraPan: CameraPanState = createCameraPanState()
  const furnitureDrag: FurnitureDragState = createFurnitureDragState()

  // ── Keyboard ──
  setupCameraKeyboardHandlers(scene, cameraPan, updateCursor)

  // ── Pointer Down ──
  scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    const editorState = getEditorState()
    if (!editorState) return
    const callbacks = getCallbacks()

    const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y)
    const col = Math.floor(worldPoint.x / TILE_SIZE)
    const row = Math.floor(worldPoint.y / TILE_SIZE)

    // Right-click OR Ctrl+Left-click: erase
    if (pointer.rightButtonDown() || (pointer.leftButtonDown() && pointer.event.ctrlKey)) {
      callbacks.onEraseAction?.(col, row)
      setIsDragging(true)
      return
    }

    // Camera pan (middle-click or Space+click)
    if (tryStartCameraPan(pointer, cameraPan, scene.input.manager.canvas)) {
      return
    }

    // Left-click: tool-dependent action
    if (pointer.leftButtonDown()) {
      if (editorState.activeTool === EditTool.SELECT) {
        const handled = handleSelectPointerDown(
          editorState,
          col,
          row,
          pointer,
          furnitureDrag,
          findFurnitureAtTile,
          scene.input.manager.canvas,
          callbacks
        )
        if (!handled) {
          // No furniture hit → start camera pan
          cameraPan.cameraDragging = true
          cameraPan.lastPointerX = pointer.x
          cameraPan.lastPointerY = pointer.y
          scene.input.manager.canvas.style.cursor = 'grabbing'
        }
        return
      }

      // Non-SELECT tools: fire tile action and start drag painting
      handlePaintPointerDown(editorState, col, row, callbacks)
      setIsDragging(true)
    }
  })

  // ── Pointer Move ──
  scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
    const editorState = getEditorState()
    if (!editorState) return
    const callbacks = getCallbacks()
    const camera = scene.cameras.main

    // Camera pan takes priority
    if (handleCameraPanMove(pointer, cameraPan, camera)) return

    const worldPoint = camera.getWorldPoint(pointer.x, pointer.y)
    const col = Math.floor(worldPoint.x / TILE_SIZE)
    const row = Math.floor(worldPoint.y / TILE_SIZE)

    // Update ghost position
    editorState.ghostCol = col
    editorState.ghostRow = row

    // Furniture drag-move in SELECT mode
    if (handleFurnitureDragMove(pointer, editorState, col, row, furnitureDrag, callbacks)) return

    // Drag painting for floor/wall/erase
    handlePaintDrag(pointer, editorState, getIsDragging(), camera, callbacks)
  })

  // ── Pointer Up ──
  scene.input.on('pointerup', () => {
    const editorState = getEditorState()

    endCameraPan(cameraPan, updateCursor)
    endFurnitureDrag(editorState, updateCursor)

    setIsDragging(false)
    if (editorState) {
      editorState.isDragging = false
      editorState.wallDragAdding = null
    }
  })

  // ── Scroll ──
  setupScrollHandler(scene)

  // ── Context Menu ──
  scene.input.mouse?.disableContextMenu()
}

/**
 * CameraPanHandler — Handles camera panning via middle-click, Space+click, and scroll wheel.
 *
 * Extracted from PhaserEditorScene.setupInputHandlers to isolate camera interaction.
 */

export interface CameraPanState {
  cameraDragging: boolean
  lastPointerX: number
  lastPointerY: number
  spaceDown: boolean
}

export function createCameraPanState(): CameraPanState {
  return {
    cameraDragging: false,
    lastPointerX: 0,
    lastPointerY: 0,
    spaceDown: false
  }
}

/**
 * Register keyboard listeners for Space key (camera pan modifier).
 */
export function setupCameraKeyboardHandlers(
  scene: Phaser.Scene,
  state: CameraPanState,
  updateCursor: () => void
): void {
  scene.input.keyboard?.on('keydown-SPACE', () => {
    state.spaceDown = true
    scene.input.manager.canvas.style.cursor = 'grab'
  })
  scene.input.keyboard?.on('keyup-SPACE', () => {
    state.spaceDown = false
    updateCursor()
  })
}

/**
 * Try to start camera pan from a pointer event.
 * Returns true if camera pan was started (caller should return early).
 */
export function tryStartCameraPan(
  pointer: Phaser.Input.Pointer,
  state: CameraPanState,
  canvas: HTMLCanvasElement
): boolean {
  // Middle-click: camera pan
  if (pointer.middleButtonDown()) {
    state.cameraDragging = true
    state.lastPointerX = pointer.x
    state.lastPointerY = pointer.y
    canvas.style.cursor = 'grabbing'
    return true
  }

  // Space + left-click: camera pan (any tool)
  if (pointer.leftButtonDown() && state.spaceDown) {
    state.cameraDragging = true
    state.lastPointerX = pointer.x
    state.lastPointerY = pointer.y
    canvas.style.cursor = 'grabbing'
    return true
  }

  return false
}

/**
 * Handle camera pan movement during pointermove.
 * Returns true if camera was panning (caller should return early).
 */
export function handleCameraPanMove(
  pointer: Phaser.Input.Pointer,
  state: CameraPanState,
  camera: Phaser.Cameras.Scene2D.Camera
): boolean {
  if (!state.cameraDragging) return false

  const dx = (state.lastPointerX - pointer.x) / camera.zoom
  const dy = (state.lastPointerY - pointer.y) / camera.zoom
  camera.scrollX += dx
  camera.scrollY += dy
  state.lastPointerX = pointer.x
  state.lastPointerY = pointer.y
  return true
}

/**
 * End camera pan on pointer up.
 */
export function endCameraPan(
  state: CameraPanState,
  updateCursor: () => void
): void {
  if (state.cameraDragging) {
    state.cameraDragging = false
    updateCursor()
  }
}

/**
 * Register scroll wheel handler for camera panning.
 */
export function setupScrollHandler(scene: Phaser.Scene): void {
  scene.input.on(
    'wheel',
    (_pointer: Phaser.Input.Pointer, _gos: unknown, dx: number, dy: number) => {
      const cam = scene.cameras.main
      cam.scrollX += dx / cam.zoom
      cam.scrollY += dy / cam.zoom
    }
  )
}

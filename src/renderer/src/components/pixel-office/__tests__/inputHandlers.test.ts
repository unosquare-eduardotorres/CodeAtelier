/**
 * Unit tests for editor input handler pure functions.
 * Tests state initialization and math-only logic that doesn't require Phaser.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createCameraPanState,
  tryStartCameraPan,
  handleCameraPanMove,
  endCameraPan
} from '../editor/input/CameraPanHandler'
import type { CameraPanState } from '../editor/input/CameraPanHandler'
import { createFurnitureDragState } from '../editor/input/FurnitureInput'

// ── createCameraPanState ────────────────────────────────────────

describe('createCameraPanState', () => {
  it('returns initial state with all defaults', () => {
    const state = createCameraPanState()
    assert.equal(state.cameraDragging, false)
    assert.equal(state.lastPointerX, 0)
    assert.equal(state.lastPointerY, 0)
    assert.equal(state.spaceDown, false)
  })

  it('returns a new object each call (no shared reference)', () => {
    const a = createCameraPanState()
    const b = createCameraPanState()
    assert.notEqual(a, b)
  })
})

// ─��� createFurnitureDragState ────────────────────────────────────

describe('createFurnitureDragState', () => {
  it('returns initial state with zero positions', () => {
    const state = createFurnitureDragState()
    assert.equal(state.dragStartPointerX, 0)
    assert.equal(state.dragStartPointerY, 0)
  })

  it('returns a new object each call', () => {
    const a = createFurnitureDragState()
    const b = createFurnitureDragState()
    assert.notEqual(a, b)
  })
})

// ── tryStartCameraPan ───────────────────────────────────────────

describe('tryStartCameraPan', () => {
  function makePointer(opts: {
    middleButtonDown?: boolean
    leftButtonDown?: boolean
    x?: number
    y?: number
  }) {
    return {
      middleButtonDown: () => opts.middleButtonDown ?? false,
      leftButtonDown: () => opts.leftButtonDown ?? false,
      x: opts.x ?? 100,
      y: opts.y ?? 200
    } as unknown as Phaser.Input.Pointer
  }

  function makeCanvas(): HTMLCanvasElement {
    return { style: { cursor: 'default' } } as unknown as HTMLCanvasElement
  }

  it('starts camera pan on middle-click', () => {
    const state = createCameraPanState()
    const canvas = makeCanvas()
    const result = tryStartCameraPan(
      makePointer({ middleButtonDown: true, x: 150, y: 250 }),
      state,
      canvas
    )
    assert.equal(result, true)
    assert.equal(state.cameraDragging, true)
    assert.equal(state.lastPointerX, 150)
    assert.equal(state.lastPointerY, 250)
    assert.equal(canvas.style.cursor, 'grabbing')
  })

  it('starts camera pan on Space + left-click', () => {
    const state = createCameraPanState()
    state.spaceDown = true
    const canvas = makeCanvas()
    const result = tryStartCameraPan(
      makePointer({ leftButtonDown: true, x: 50, y: 75 }),
      state,
      canvas
    )
    assert.equal(result, true)
    assert.equal(state.cameraDragging, true)
    assert.equal(state.lastPointerX, 50)
    assert.equal(state.lastPointerY, 75)
  })

  it('returns false when no qualifying button is pressed', () => {
    const state = createCameraPanState()
    const canvas = makeCanvas()
    const result = tryStartCameraPan(
      makePointer({ leftButtonDown: true }), // no space, no middle
      state,
      canvas
    )
    assert.equal(result, false)
    assert.equal(state.cameraDragging, false)
  })

  it('returns false on left-click without Space', () => {
    const state = createCameraPanState()
    const canvas = makeCanvas()
    const result = tryStartCameraPan(makePointer({ leftButtonDown: true }), state, canvas)
    assert.equal(result, false)
  })
})

// ── handleCameraPanMove ─────────────────────────────────────────

describe('handleCameraPanMove', () => {
  function makeCamera(scrollX: number, scrollY: number, zoom: number) {
    return { scrollX, scrollY, zoom } as unknown as Phaser.Cameras.Scene2D.Camera
  }

  it('returns false when not dragging', () => {
    const state = createCameraPanState()
    const camera = makeCamera(0, 0, 1)
    const result = handleCameraPanMove({ x: 100, y: 200 } as Phaser.Input.Pointer, state, camera)
    assert.equal(result, false)
  })

  it('moves camera by pointer delta / zoom', () => {
    const state: CameraPanState = {
      cameraDragging: true,
      lastPointerX: 100,
      lastPointerY: 200,
      spaceDown: false
    }
    const camera = makeCamera(0, 0, 2)
    const pointer = { x: 110, y: 220 } as Phaser.Input.Pointer

    const result = handleCameraPanMove(pointer, state, camera)
    assert.equal(result, true)
    // dx = (100 - 110) / 2 = -5, dy = (200 - 220) / 2 = -10
    assert.equal(camera.scrollX, -5)
    assert.equal(camera.scrollY, -10)
    assert.equal(state.lastPointerX, 110)
    assert.equal(state.lastPointerY, 220)
  })

  it('handles zoom factor of 1', () => {
    const state: CameraPanState = {
      cameraDragging: true,
      lastPointerX: 50,
      lastPointerY: 50,
      spaceDown: false
    }
    const camera = makeCamera(10, 20, 1)
    handleCameraPanMove({ x: 55, y: 60 } as Phaser.Input.Pointer, state, camera)
    // dx = (50 - 55) / 1 = -5, dy = (50 - 60) / 1 = -10
    assert.equal(camera.scrollX, 5) // 10 + (-5) = 5
    assert.equal(camera.scrollY, 10) // 20 + (-10) = 10
  })
})

// ── endCameraPan ────────────────────────────────────────────────

describe('endCameraPan', () => {
  it('resets cameraDragging and calls updateCursor when dragging', () => {
    const state: CameraPanState = {
      cameraDragging: true,
      lastPointerX: 100,
      lastPointerY: 200,
      spaceDown: false
    }
    let cursorUpdated = false
    endCameraPan(state, () => {
      cursorUpdated = true
    })

    assert.equal(state.cameraDragging, false)
    assert.equal(cursorUpdated, true)
  })

  it('does not call updateCursor when not dragging', () => {
    const state = createCameraPanState()
    let cursorUpdated = false
    endCameraPan(state, () => {
      cursorUpdated = true
    })

    assert.equal(cursorUpdated, false)
  })
})

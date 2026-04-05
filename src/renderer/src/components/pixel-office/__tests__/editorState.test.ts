/**
 * Unit tests for pixel-office EditorState class.
 * Pure class with zero external dependencies beyond constants/types — fully testable.
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import { EditorState } from '../editor/editorState'
import { EditTool } from '../engine/types'
import type { OfficeLayout } from '../engine/types'

/** Minimal layout factory for undo/redo tests */
function makeLayout(version: number): OfficeLayout {
  return {
    version,
    cols: 4,
    rows: 3,
    tiles: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    furniture: []
  }
}

// ── Initialization ───────────────────────────���──────────────────

describe('EditorState — initialization', () => {
  it('starts with default values', () => {
    const es = new EditorState()
    assert.equal(es.isEditMode, false)
    assert.equal(es.activeTool, EditTool.SELECT)
    assert.equal(es.selectedTileType, 1)
    assert.equal(es.selectedFurnitureType, '')
    assert.equal(es.selectedFurnitureUid, null)
    assert.equal(es.isDragging, false)
    assert.equal(es.wallDragAdding, null)
    assert.equal(es.isDirty, false)
    assert.equal(es.dragUid, null)
    assert.equal(es.isDragMoving, false)
  })

  it('starts with empty undo/redo stacks', () => {
    const es = new EditorState()
    assert.equal(es.undoStack.length, 0)
    assert.equal(es.redoStack.length, 0)
  })

  it('starts with invalid ghost position', () => {
    const es = new EditorState()
    assert.equal(es.ghostCol, -1)
    assert.equal(es.ghostRow, -1)
    assert.equal(es.ghostValid, false)
  })
})

// ── Undo stack ──────────────────────────────────────────────────

describe('EditorState — undo stack', () => {
  let es: EditorState

  beforeEach(() => {
    es = new EditorState()
  })

  it('pushUndo adds layout to stack', () => {
    es.pushUndo(makeLayout(1))
    assert.equal(es.undoStack.length, 1)
  })

  it('popUndo returns the last pushed layout', () => {
    es.pushUndo(makeLayout(1))
    es.pushUndo(makeLayout(2))
    const popped = es.popUndo()
    assert.equal(popped?.version, 2)
    assert.equal(es.undoStack.length, 1)
  })

  it('popUndo returns null when stack is empty', () => {
    assert.equal(es.popUndo(), null)
  })

  it('pushUndo trims oldest entry when exceeding max size', () => {
    // UNDO_STACK_MAX_SIZE = 50
    for (let i = 0; i < 55; i++) {
      es.pushUndo(makeLayout(i))
    }
    assert.equal(es.undoStack.length, 50)
    // First entry should be version 5 (0-4 shifted off)
    assert.equal(es.undoStack[0].version, 5)
  })
})

// ── Redo stack ──────────────────────────────────────────────────

describe('EditorState — redo stack', () => {
  let es: EditorState

  beforeEach(() => {
    es = new EditorState()
  })

  it('pushRedo adds layout to stack', () => {
    es.pushRedo(makeLayout(1))
    assert.equal(es.redoStack.length, 1)
  })

  it('popRedo returns the last pushed layout', () => {
    es.pushRedo(makeLayout(1))
    es.pushRedo(makeLayout(2))
    const popped = es.popRedo()
    assert.equal(popped?.version, 2)
    assert.equal(es.redoStack.length, 1)
  })

  it('popRedo returns null when stack is empty', () => {
    assert.equal(es.popRedo(), null)
  })

  it('clearRedo empties the redo stack', () => {
    es.pushRedo(makeLayout(1))
    es.pushRedo(makeLayout(2))
    es.clearRedo()
    assert.equal(es.redoStack.length, 0)
  })

  it('pushRedo trims oldest entry when exceeding max size', () => {
    for (let i = 0; i < 55; i++) {
      es.pushRedo(makeLayout(i))
    }
    assert.equal(es.redoStack.length, 50)
    assert.equal(es.redoStack[0].version, 5)
  })
})

// ── Selection ───────────────────────────────────────────────────

describe('EditorState — selection', () => {
  it('clearSelection sets selectedFurnitureUid to null', () => {
    const es = new EditorState()
    es.selectedFurnitureUid = 'furn-123'
    es.clearSelection()
    assert.equal(es.selectedFurnitureUid, null)
  })
})

// ── Ghost preview ───────────────────────────────────────────────

describe('EditorState — ghost', () => {
  it('clearGhost resets ghost position and validity', () => {
    const es = new EditorState()
    es.ghostCol = 5
    es.ghostRow = 3
    es.ghostValid = true
    es.clearGhost()
    assert.equal(es.ghostCol, -1)
    assert.equal(es.ghostRow, -1)
    assert.equal(es.ghostValid, false)
  })
})

// ── Drag-to-move ────────────────────────────────────────────────

describe('EditorState — drag', () => {
  let es: EditorState

  beforeEach(() => {
    es = new EditorState()
  })

  it('startDrag sets all drag properties', () => {
    es.startDrag('furn-abc', 3, 4, 1, 2)
    assert.equal(es.dragUid, 'furn-abc')
    assert.equal(es.dragStartCol, 3)
    assert.equal(es.dragStartRow, 4)
    assert.equal(es.dragOffsetCol, 1)
    assert.equal(es.dragOffsetRow, 2)
    assert.equal(es.isDragMoving, false)
  })

  it('clearDrag resets drag state', () => {
    es.startDrag('furn-abc', 3, 4, 1, 2)
    es.isDragMoving = true
    es.clearDrag()
    assert.equal(es.dragUid, null)
    assert.equal(es.isDragMoving, false)
  })
})

// ── Reset ───────────────────────────────────────────────────────

describe('EditorState — reset', () => {
  it('reset restores all state to defaults', () => {
    const es = new EditorState()
    // Dirty up the state
    es.activeTool = EditTool.TILE_PAINT
    es.selectedFurnitureUid = 'furn-xyz'
    es.ghostCol = 5
    es.ghostRow = 3
    es.ghostValid = true
    es.isDragging = true
    es.wallDragAdding = true
    es.pushUndo(makeLayout(1))
    es.pushRedo(makeLayout(2))
    es.isDirty = true
    es.startDrag('furn-abc', 1, 2, 0, 0)
    es.isDragMoving = true

    es.reset()

    assert.equal(es.activeTool, EditTool.SELECT)
    assert.equal(es.selectedFurnitureUid, null)
    assert.equal(es.ghostCol, -1)
    assert.equal(es.ghostRow, -1)
    assert.equal(es.ghostValid, false)
    assert.equal(es.isDragging, false)
    assert.equal(es.undoStack.length, 0)
    assert.equal(es.redoStack.length, 0)
    assert.equal(es.isDirty, false)
    assert.equal(es.dragUid, null)
    assert.equal(es.isDragMoving, false)
  })
})

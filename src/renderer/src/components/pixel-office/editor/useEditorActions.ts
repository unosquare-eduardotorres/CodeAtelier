/**
 * useEditorActions — Orchestrator hook that composes focused sub-hooks.
 *
 * Previously a 562 LOC monolith (complexity 92). Now delegates to:
 * - useLayoutPersistence: debounced save, dirty tracking
 * - useUndoRedo: undo/redo stack, applyEdit, reset
 * - useTilePainting: tile paint, wall paint, erase, eyedropper, grid expansion
 * - useFurnitureOps: place, delete, rotate, toggle, color, pick, select
 * - useDragMove: drag-move validation + application
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import type { EditorState } from './editorState'
import type { EditorHookContext } from './hooks'
import { useLayoutPersistence } from './hooks/useLayoutPersistence'
import { useUndoRedo } from './hooks/useUndoRedo'
import { useTilePainting } from './hooks/useTilePainting'
import { useFurnitureOps } from './hooks/useFurnitureOps'
import { useDragMove } from './hooks/useDragMove'
import { EditTool, TileType } from '../engine/types'
import type {
  EditTool as EditToolType,
  FloorColor,
  OfficeLayout,
  TileType as TileTypeVal
} from '../engine/types'
import type { OfficeState } from '../engine/officeState'

interface EditorActions {
  editorTick: number
  isDirty: boolean
  setLastSavedLayout: (layout: OfficeLayout) => void
  handleToolChange: (tool: EditToolType) => void
  handleTileTypeChange: (type: TileTypeVal) => void
  handleFloorColorChange: (color: FloorColor) => void
  handleWallColorChange: (color: FloorColor) => void
  handleWallSetChange: (setIndex: number) => void
  handleSelectedFurnitureColorChange: (color: FloorColor | null) => void
  handleFurnitureTypeChange: (type: string) => void
  handleDeleteSelected: () => void
  handleRotateSelected: () => void
  handleToggleState: () => void
  handleUndo: () => void
  handleRedo: () => void
  handleReset: () => void
  handleSave: () => void
  handleEditorTileAction: (col: number, row: number) => void
  handleEditorEraseAction: (col: number, row: number) => void
  handleEditorSelectionChange: () => void
  handleDragMove: (uid: string, newCol: number, newRow: number) => void
}

export function useEditorActions(
  getOfficeState: () => OfficeState,
  editorState: EditorState
): EditorActions {
  const [editorTick, setEditorTick] = useState(0)

  // ── Persistence ──
  const persistence = useLayoutPersistence(getOfficeState, editorState)

  // ── Undo/Redo ──
  const undoCtx: Omit<EditorHookContext, 'applyEdit'> = useMemo(() => ({
    getOfficeState,
    editorState,
    saveLayout: persistence.saveLayout,
    setIsDirty: persistence.setIsDirty,
    setEditorTick
  }), [getOfficeState, editorState, persistence.saveLayout, persistence.setIsDirty, setEditorTick])

  const undoRedo = useUndoRedo(undoCtx, persistence.lastSavedLayoutRef)

  // ── Shared context for sub-hooks (includes applyEdit from undoRedo) ──
  const ctx: EditorHookContext = useMemo(() => ({
    ...undoCtx,
    applyEdit: undoRedo.applyEdit
  }), [undoCtx, undoRedo.applyEdit])

  // ── Tile Painting ──
  const tilePainting = useTilePainting(ctx)

  // ── Furniture Operations ──
  const furnitureOps = useFurnitureOps(ctx)

  // ── Drag Move ──
  const dragMove = useDragMove(ctx)

  // ── Tool Change (resets selection/ghost state) ──
  const handleToolChange = useCallback(
    (tool: EditToolType) => {
      if (editorState.activeTool === tool) {
        editorState.activeTool = EditTool.SELECT
      } else {
        editorState.activeTool = tool
      }
      editorState.clearSelection()
      editorState.clearGhost()
      editorState.clearDrag()
      furnitureOps.resetColorEdit()
      wallColorEditActiveRef.current = false
      setEditorTick((n) => n + 1)
    },
    [editorState, furnitureOps, setEditorTick]
  )

  // Track whether we've already pushed undo for the current wall color editing session
  const wallColorEditActiveRef = useRef(false)

  // ── Wall Color Change (with undo batching for continuous edits) ──
  const handleWallColorChange = useCallback(
    (color: FloorColor) => {
      editorState.wallColor = color

      // Update all existing wall tiles to the new color
      const os = getOfficeState()
      const layout = os.getLayout()
      const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null)
      const newColors = [...existingColors]
      let changed = false
      for (let i = 0; i < layout.tiles.length; i++) {
        if (layout.tiles[i] === TileType.WALL && layout.tileColors) {
          newColors[i] = { ...color }
          changed = true
        }
      }
      if (changed) {
        if (!wallColorEditActiveRef.current) {
          editorState.pushUndo(layout)
          editorState.clearRedo()
          wallColorEditActiveRef.current = true
        }
        const newLayout = { ...layout, tileColors: newColors }
        editorState.isDirty = true
        persistence.setIsDirty(true)
        os.rebuildFromLayout(newLayout)
        persistence.saveLayout(newLayout)
      }
      setEditorTick((n) => n + 1)
    },
    [getOfficeState, editorState, persistence, setEditorTick]
  )

  // ── Main Tile Action Dispatcher ──
  const handleEditorTileAction = useCallback(
    (col: number, row: number) => {
      const os = getOfficeState()
      let layout = os.getLayout()
      let effectiveCol = col
      let effectiveRow = row

      // Handle ghost border expansion for floor/wall tools
      if (
        editorState.activeTool === EditTool.TILE_PAINT ||
        editorState.activeTool === EditTool.WALL_PAINT
      ) {
        const expansion = tilePainting.maybeExpand(layout, col, row)
        if (expansion) {
          layout = expansion.layout
          effectiveCol = expansion.col
          effectiveRow = expansion.row
          os.rebuildFromLayout(layout, expansion.shift)
        }
      }

      let newLayout: ReturnType<typeof tilePainting.handleTilePaint> = null

      if (editorState.activeTool === EditTool.TILE_PAINT) {
        newLayout = tilePainting.handleTilePaint(layout, effectiveCol, effectiveRow, os)
      } else if (editorState.activeTool === EditTool.WALL_PAINT) {
        newLayout = tilePainting.handleWallPaint(layout, effectiveCol, effectiveRow, os)
      } else if (editorState.activeTool === EditTool.ERASE) {
        newLayout = tilePainting.handleErase(layout, col, row)
      } else if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
        newLayout = furnitureOps.handleFurniturePlaceTile(layout, col, row)
      } else if (editorState.activeTool === EditTool.FURNITURE_PICK) {
        furnitureOps.handleFurniturePick(layout, col, row)
        return
      } else if (editorState.activeTool === EditTool.EYEDROPPER) {
        tilePainting.handleEyedropper(layout, col, row)
        return
      } else if (editorState.activeTool === EditTool.SELECT) {
        furnitureOps.handleSelectTile(layout, col, row)
        return
      }

      if (newLayout) {
        undoRedo.applyEdit(newLayout)
      }
    },
    [getOfficeState, editorState, tilePainting, furnitureOps, undoRedo]
  )

  // ── Erase Action ──
  const handleEditorEraseAction = useCallback(
    (col: number, row: number) => {
      const os = getOfficeState()
      const layout = os.getLayout()
      const newLayout = tilePainting.handleErase(layout, col, row)
      if (newLayout) {
        undoRedo.applyEdit(newLayout)
      }
    },
    [getOfficeState, tilePainting, undoRedo]
  )

  return {
    editorTick,
    isDirty: persistence.isDirty,
    setLastSavedLayout: persistence.setLastSavedLayout,
    handleToolChange,
    handleTileTypeChange: tilePainting.handleTileTypeChange,
    handleFloorColorChange: tilePainting.handleFloorColorChange,
    handleWallColorChange,
    handleWallSetChange: tilePainting.handleWallSetChange,
    handleSelectedFurnitureColorChange: furnitureOps.handleSelectedFurnitureColorChange,
    handleFurnitureTypeChange: furnitureOps.handleFurnitureTypeChange,
    handleDeleteSelected: furnitureOps.handleDeleteSelected,
    handleRotateSelected: furnitureOps.handleRotateSelected,
    handleToggleState: furnitureOps.handleToggleState,
    handleUndo: undoRedo.handleUndo,
    handleRedo: undoRedo.handleRedo,
    handleReset: undoRedo.handleReset,
    handleSave: persistence.handleSave,
    handleEditorTileAction,
    handleEditorEraseAction,
    handleEditorSelectionChange: furnitureOps.handleEditorSelectionChange,
    handleDragMove: dragMove.handleDragMove
  }
}

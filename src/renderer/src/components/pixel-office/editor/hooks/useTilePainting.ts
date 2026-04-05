/**
 * useTilePainting — Handles tile paint, wall paint, erase, and eyedropper actions.
 *
 * Extracted from useEditorActions to isolate tile-level editing logic.
 */

import { useCallback, useRef } from 'react'

import type { EditorHookContext } from './index'
import type { ExpandDirection } from '../editorActions'
import {
  expandLayout,
  resolveEraseAction,
  resolveEyedropperAction,
  resolveTilePaintAction,
  resolveWallPaintAction
} from '../editorActions'
import { EditTool } from '../../engine/types'
import type { FloorColor, OfficeLayout } from '../../engine/types'
import type { OfficeState } from '../../engine/officeState'

interface TilePaintingActions {
  handleTileTypeChange: (type: (typeof TileType)[keyof typeof TileType]) => void
  handleFloorColorChange: (color: FloorColor) => void
  handleWallColorChange: (color: FloorColor) => void
  handleWallSetChange: (setIndex: number) => void
  /** Execute tile action at (col, row) based on active tool */
  handleTilePaint: (
    layout: OfficeLayout,
    col: number,
    row: number,
    os: OfficeState
  ) => OfficeLayout | null
  /** Execute wall paint action at (col, row) */
  handleWallPaint: (
    layout: OfficeLayout,
    col: number,
    row: number,
    os: OfficeState
  ) => OfficeLayout | null
  /** Execute erase action at (col, row) */
  handleErase: (layout: OfficeLayout, col: number, row: number) => OfficeLayout | null
  /** Execute eyedropper action at (col, row) */
  handleEyedropper: (layout: OfficeLayout, col: number, row: number) => void
  /** Try to expand layout if click is on a ghost border tile */
  maybeExpand: (
    layout: OfficeLayout,
    col: number,
    row: number
  ) => {
    layout: OfficeLayout
    col: number
    row: number
    shift: { col: number; row: number }
  } | null
  /** Reset wall color edit tracking (call on tool change) */
  resetWallColorEdit: () => void
}

export function useTilePainting(ctx: Pick<EditorHookContext, 'editorState' | 'setEditorTick'>): TilePaintingActions {
  const { editorState, setEditorTick } = ctx
  const wallColorEditActiveRef = useRef(false)

  const handleTileTypeChange = useCallback(
    (type: (typeof TileType)[keyof typeof TileType]) => {
      editorState.selectedTileType = type
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const handleFloorColorChange = useCallback(
    (color: FloorColor) => {
      editorState.floorColor = color
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const handleWallColorChange = useCallback(
    (color: FloorColor) => {
      editorState.wallColor = color
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const handleWallSetChange = useCallback(
    (setIndex: number) => {
      editorState.selectedWallSet = setIndex
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const maybeExpand = useCallback(
    (
      layout: OfficeLayout,
      col: number,
      row: number
    ): {
      layout: OfficeLayout
      col: number
      row: number
      shift: { col: number; row: number }
    } | null => {
      if (col >= 0 && col < layout.cols && row >= 0 && row < layout.rows) return null

      const directions: ExpandDirection[] = []
      if (col < 0) directions.push('left')
      if (col >= layout.cols) directions.push('right')
      if (row < 0) directions.push('up')
      if (row >= layout.rows) directions.push('down')

      let current = layout
      let totalShiftCol = 0
      let totalShiftRow = 0
      for (const dir of directions) {
        const result = expandLayout(current, dir)
        if (!result) return null
        current = result.layout
        totalShiftCol += result.shift.col
        totalShiftRow += result.shift.row
      }

      return {
        layout: current,
        col: col + totalShiftCol,
        row: row + totalShiftRow,
        shift: { col: totalShiftCol, row: totalShiftRow }
      }
    },
    []
  )

  const handleTilePaint = useCallback(
    (
      layout: OfficeLayout,
      col: number,
      row: number,
      _os: OfficeState
    ): OfficeLayout | null => {
      return resolveTilePaintAction(layout, col, row, editorState.selectedTileType, editorState.floorColor)
    },
    [editorState]
  )

  const handleWallPaint = useCallback(
    (
      layout: OfficeLayout,
      col: number,
      row: number,
      _os: OfficeState
    ): OfficeLayout | null => {
      const result = resolveWallPaintAction(
        layout, col, row,
        editorState.wallDragAdding,
        editorState.wallColor,
        editorState.selectedTileType,
        editorState.floorColor
      )
      editorState.wallDragAdding = result.wallDragAdding
      return result.layout
    },
    [editorState]
  )

  const handleErase = useCallback(
    (layout: OfficeLayout, col: number, row: number): OfficeLayout | null => {
      return resolveEraseAction(layout, col, row)
    },
    []
  )

  const handleEyedropper = useCallback(
    (layout: OfficeLayout, col: number, row: number): void => {
      const result = resolveEyedropperAction(layout, col, row)
      if (result) {
        editorState.activeTool = result.tool
        if (result.tileType !== undefined) {
          editorState.selectedTileType = result.tileType
        }
        if (result.color) {
          if (result.tool === EditTool.TILE_PAINT) {
            editorState.floorColor = result.color
          } else {
            editorState.wallColor = result.color
          }
        }
      }
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const resetWallColorEdit = useCallback(() => {
    wallColorEditActiveRef.current = false
  }, [])

  return {
    handleTileTypeChange,
    handleFloorColorChange,
    handleWallColorChange,
    handleWallSetChange,
    handleTilePaint,
    handleWallPaint,
    handleErase,
    handleEyedropper,
    maybeExpand,
    resetWallColorEdit
  }
}

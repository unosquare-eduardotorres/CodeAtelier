/**
 * useFurnitureOps — Handles furniture placement, deletion, rotation, toggle, color, and picking.
 *
 * Extracted from useEditorActions to isolate furniture-related editing logic.
 */

import { useCallback, useRef } from 'react'

import type { EditorHookContext } from './index'
import {
  findFurnitureAtTile,
  removeFurniture,
  resolveFurniturePlacement,
  rotateFurniture,
  toggleFurnitureState
} from '../editorActions'
import { getRotatedType, getToggledType } from '../../layout/furnitureCatalog'
import { EditTool } from '../../engine/types'
import type { FloorColor, OfficeLayout } from '../../engine/types'

interface FurnitureOpsActions {
  handleFurnitureTypeChange: (type: string) => void
  handleDeleteSelected: () => void
  handleRotateSelected: () => void
  handleToggleState: () => void
  handleSelectedFurnitureColorChange: (color: FloorColor | null) => void
  /** Handle furniture placement or selection at (col, row) */
  handleFurniturePlaceTile: (layout: OfficeLayout, col: number, row: number) => OfficeLayout | null
  /** Handle furniture pick tool at (col, row) */
  handleFurniturePick: (layout: OfficeLayout, col: number, row: number) => void
  /** Handle select tool at (col, row) */
  handleSelectTile: (layout: OfficeLayout, col: number, row: number) => void
  /** Reset color edit tracking (call on tool change) */
  resetColorEdit: () => void
  /** Handle selection change callback */
  handleEditorSelectionChange: () => void
}

export function useFurnitureOps(ctx: EditorHookContext): FurnitureOpsActions {
  const { getOfficeState, editorState, applyEdit, saveLayout, setIsDirty, setEditorTick } = ctx
  const colorEditUidRef = useRef<string | null>(null)

  const handleFurnitureTypeChange = useCallback(
    (type: string) => {
      if (editorState.selectedFurnitureType === type) {
        editorState.selectedFurnitureType = ''
        editorState.clearGhost()
      } else {
        editorState.selectedFurnitureType = type
      }
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const handleDeleteSelected = useCallback(() => {
    const uid = editorState.selectedFurnitureUid
    if (!uid) return
    const os = getOfficeState()
    const newLayout = removeFurniture(os.getLayout(), uid)
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout)
      editorState.clearSelection()
      colorEditUidRef.current = null
    }
  }, [getOfficeState, editorState, applyEdit])

  const handleRotateSelected = useCallback(() => {
    if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const rotated = getRotatedType(editorState.selectedFurnitureType, 'cw')
      if (rotated) {
        editorState.selectedFurnitureType = rotated
        setEditorTick((n) => n + 1)
      }
      return
    }
    const uid = editorState.selectedFurnitureUid
    if (!uid) return
    const os = getOfficeState()
    const newLayout = rotateFurniture(os.getLayout(), uid, 'cw')
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout)
    }
  }, [getOfficeState, editorState, applyEdit, setEditorTick])

  const handleToggleState = useCallback(() => {
    if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const toggled = getToggledType(editorState.selectedFurnitureType)
      if (toggled) {
        editorState.selectedFurnitureType = toggled
        setEditorTick((n) => n + 1)
      }
      return
    }
    const uid = editorState.selectedFurnitureUid
    if (!uid) return
    const os = getOfficeState()
    const newLayout = toggleFurnitureState(os.getLayout(), uid)
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout)
    }
  }, [getOfficeState, editorState, applyEdit, setEditorTick])

  const handleSelectedFurnitureColorChange = useCallback(
    (color: FloorColor | null) => {
      const uid = editorState.selectedFurnitureUid
      if (!uid) return
      const os = getOfficeState()
      const layout = os.getLayout()

      if (colorEditUidRef.current !== uid) {
        editorState.pushUndo(layout)
        editorState.clearRedo()
        colorEditUidRef.current = uid
      }

      const newFurniture = layout.furniture.map((f) =>
        f.uid === uid ? { ...f, color: color ?? undefined } : f
      )
      const newLayout = { ...layout, furniture: newFurniture }

      editorState.isDirty = true
      setIsDirty(true)
      os.rebuildFromLayout(newLayout)
      saveLayout(newLayout)
      setEditorTick((n) => n + 1)
    },
    [getOfficeState, editorState, saveLayout, setIsDirty, setEditorTick]
  )

  const handleFurniturePlaceTile = useCallback(
    (layout: OfficeLayout, col: number, row: number): OfficeLayout | null => {
      const type = editorState.selectedFurnitureType
      if (type === '') {
        // No furniture type selected — select existing furniture at click
        const hit = findFurnitureAtTile(layout.furniture, col, row)
        editorState.selectedFurnitureUid = hit ? hit.uid : null
        setEditorTick((n) => n + 1)
        return null
      }

      const result = resolveFurniturePlacement(
        layout, col, row, type, editorState.pickedFurnitureColor
      )
      return result ? result.layout : null
    },
    [editorState, setEditorTick]
  )

  const handleFurniturePick = useCallback(
    (layout: OfficeLayout, col: number, row: number): void => {
      const hit = findFurnitureAtTile(layout.furniture, col, row)
      if (hit) {
        editorState.selectedFurnitureType = hit.type
        editorState.pickedFurnitureColor = hit.color ? { ...hit.color } : null
        editorState.activeTool = EditTool.FURNITURE_PLACE
      }
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const handleSelectTile = useCallback(
    (layout: OfficeLayout, col: number, row: number): void => {
      const hit = findFurnitureAtTile(layout.furniture, col, row)
      editorState.selectedFurnitureUid = hit ? hit.uid : null
      setEditorTick((n) => n + 1)
    },
    [editorState, setEditorTick]
  )

  const resetColorEdit = useCallback(() => {
    colorEditUidRef.current = null
  }, [])

  const handleEditorSelectionChange = useCallback(() => {
    colorEditUidRef.current = null
    setEditorTick((n) => n + 1)
  }, [setEditorTick])

  return {
    handleFurnitureTypeChange,
    handleDeleteSelected,
    handleRotateSelected,
    handleToggleState,
    handleSelectedFurnitureColorChange,
    handleFurniturePlaceTile,
    handleFurniturePick,
    handleSelectTile,
    resetColorEdit,
    handleEditorSelectionChange
  }
}

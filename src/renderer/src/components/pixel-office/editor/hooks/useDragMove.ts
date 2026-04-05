/**
 * useDragMove — Handles drag-move validation and application for furniture.
 *
 * Extracted from useEditorActions to isolate drag-move concerns.
 */

import { useCallback } from 'react'

import type { EditorHookContext } from './index'
import { moveFurniture } from '../editorActions'

interface DragMoveActions {
  handleDragMove: (uid: string, newCol: number, newRow: number) => void
}

export function useDragMove(ctx: Pick<EditorHookContext, 'getOfficeState' | 'applyEdit'>): DragMoveActions {
  const { getOfficeState, applyEdit } = ctx

  const handleDragMove = useCallback(
    (uid: string, newCol: number, newRow: number) => {
      const os = getOfficeState()
      const layout = os.getLayout()
      const newLayout = moveFurniture(layout, uid, newCol, newRow)
      if (newLayout !== layout) {
        applyEdit(newLayout)
      }
    },
    [getOfficeState, applyEdit]
  )

  return { handleDragMove }
}

/**
 * useUndoRedo — Manages undo/redo stack operations for the office editor.
 *
 * Extracted from useEditorActions to reduce complexity.
 * Pure state management: push, pop, undo, redo, reset.
 */

import { useCallback } from 'react'

import type { EditorHookContext } from './index'
import type { OfficeLayout } from '../../engine/types'

interface UndoRedoActions {
  handleUndo: () => void
  handleRedo: () => void
  handleReset: () => void
  /** Apply a layout edit: push undo, clear redo, rebuild state, save, mark dirty */
  applyEdit: (newLayout: OfficeLayout) => void
}

export function useUndoRedo(
  ctx: Omit<EditorHookContext, 'applyEdit'>,
  lastSavedLayoutRef: React.MutableRefObject<OfficeLayout | null>
): UndoRedoActions {
  const { getOfficeState, editorState, saveLayout, setIsDirty, setEditorTick } = ctx
  const applyEdit = useCallback(
    (newLayout: OfficeLayout) => {
      const os = getOfficeState()
      editorState.pushUndo(os.getLayout())
      editorState.clearRedo()
      editorState.isDirty = true
      setIsDirty(true)
      os.rebuildFromLayout(newLayout)
      saveLayout(newLayout)
      setEditorTick((n) => n + 1)
    },
    [getOfficeState, editorState, saveLayout, setIsDirty, setEditorTick]
  )

  const handleUndo = useCallback(() => {
    const prev = editorState.popUndo()
    if (!prev) return
    const os = getOfficeState()
    editorState.pushRedo(os.getLayout())
    os.rebuildFromLayout(prev)
    saveLayout(prev)
    editorState.isDirty = true
    setIsDirty(true)
    setEditorTick((n) => n + 1)
  }, [getOfficeState, editorState, saveLayout, setIsDirty, setEditorTick])

  const handleRedo = useCallback(() => {
    const next = editorState.popRedo()
    if (!next) return
    const os = getOfficeState()
    editorState.pushUndo(os.getLayout())
    os.rebuildFromLayout(next)
    saveLayout(next)
    editorState.isDirty = true
    setIsDirty(true)
    setEditorTick((n) => n + 1)
  }, [getOfficeState, editorState, saveLayout, setIsDirty, setEditorTick])

  const handleReset = useCallback(() => {
    if (!lastSavedLayoutRef.current) return
    const saved = structuredClone(lastSavedLayoutRef.current)
    applyEdit(saved)
    editorState.reset()
    setIsDirty(false)
  }, [editorState, applyEdit, lastSavedLayoutRef, setIsDirty])

  return { handleUndo, handleRedo, handleReset, applyEdit }
}

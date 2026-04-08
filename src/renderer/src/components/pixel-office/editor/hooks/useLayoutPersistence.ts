/**
 * useLayoutPersistence — Handles debounced layout saving via IPC and dirty tracking.
 *
 * Extracted from useEditorActions to isolate persistence concerns.
 */

/* eslint-disable react-hooks/immutability -- editorState is mutable Phaser game state, not React state */

import { useCallback, useRef, useState } from 'react'

import { LAYOUT_SAVE_DEBOUNCE_MS } from '../../constants'
import type { OfficeLayout } from '../../engine/types'
import type { OfficeState } from '../../engine/officeState'
import type { EditorState } from '../editorState'

interface LayoutPersistenceState {
  isDirty: boolean
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>
  saveLayout: (layout: OfficeLayout) => void
  handleSave: () => void
  setLastSavedLayout: (layout: OfficeLayout) => void
  lastSavedLayoutRef: React.MutableRefObject<OfficeLayout | null>
}

export function useLayoutPersistence(
  getOfficeState: () => OfficeState,
  editorState: EditorState
): LayoutPersistenceState {
  const [isDirty, setIsDirty] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedLayoutRef = useRef<OfficeLayout | null>(null)

  const setLastSavedLayout = useCallback((layout: OfficeLayout) => {
    lastSavedLayoutRef.current = structuredClone(layout)
  }, [])

  const saveLayout = useCallback((layout: OfficeLayout) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.api
        .saveOfficeLayout({ layout: JSON.stringify(layout) })
        .catch((err: unknown) => console.error('Failed to save layout:', err))
    }, LAYOUT_SAVE_DEBOUNCE_MS)
  }, [])

  const handleSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const os = getOfficeState()
    const layout = os.getLayout()
    lastSavedLayoutRef.current = structuredClone(layout)
    window.api
      .saveOfficeLayout({ layout: JSON.stringify(layout) })
      .catch((err: unknown) => console.error('Failed to save layout:', err))
    editorState.isDirty = false
    setIsDirty(false)
  }, [getOfficeState, editorState])

  return {
    isDirty,
    setIsDirty,
    saveLayout,
    handleSave,
    setLastSavedLayout,
    lastSavedLayoutRef
  }
}

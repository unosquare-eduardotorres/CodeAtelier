// Barrel exports for editor sub-hooks
import type { EditorState } from '../editorState'
import type { OfficeLayout } from '../../engine/types'
import type { OfficeState } from '../../engine/officeState'

/**
 * Shared context object for editor sub-hooks.
 * Replaces 4-6 positional parameters with a single typed object.
 */
export interface EditorHookContext {
  getOfficeState: () => OfficeState
  editorState: EditorState
  applyEdit: (newLayout: OfficeLayout) => void
  saveLayout: (layout: OfficeLayout) => void
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>
  setEditorTick: React.Dispatch<React.SetStateAction<number>>
}

export { useUndoRedo } from './useUndoRedo'

export { useLayoutPersistence } from './useLayoutPersistence'

export { useTilePainting } from './useTilePainting'

export { useFurnitureOps } from './useFurnitureOps'

export { useDragMove } from './useDragMove'

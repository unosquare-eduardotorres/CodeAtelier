/**
 * Shared types for editor input handlers.
 */

/** Callbacks from the PhaserEditorScene to the editor hooks */
export interface EditorInputCallbacks {
  onTileAction?: (col: number, row: number) => void
  onEraseAction?: (col: number, row: number) => void
  onSelectionChange?: () => void
  onDragMove?: (uid: string, newCol: number, newRow: number) => void
}

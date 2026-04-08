/**
 * OfficeEditorPage — Full editor page rendered as a Workspace Settings tab content.
 *
 * Layout:
 * ┌──────────────────────────────────────────────────────────┐
 * │  EditorToolbar (tools + undo/redo/save/reset)            │
 * ├──────────────────────────────────────┬───────────────────┤
 * │                                      │  Right Panel      │
 * │  PhaserEditorCanvas                  │  FurniturePalette │
 * │  (office grid + editing)             │  PropertyPanel    │
 * │                                      │                   │
 * ├──────────────────────────────────────┴───────────────────┤
 * │  Status bar                                              │
 * └──────────────────────────────────────────────────────────┘
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Castle } from 'lucide-react'

import { EditorState } from './editorState'
import { useEditorActions } from './useEditorActions'
import { useEditorKeyboard } from './useEditorKeyboard'
import EditorToolbar from './EditorToolbar'
import FurniturePalette from './FurniturePalette'
import PropertyPanel from './PropertyPanel'
import PhaserEditorCanvas from './PhaserEditorCanvas'
import type { OfficeState } from '../engine/officeState'
import { EditTool } from '../engine/types'

export default function OfficeEditorPage(): React.JSX.Element {
  // Create a single EditorState instance for the editor's lifetime
  const editorStateRef = useRef<EditorState | null>(null)
  if (!editorStateRef.current) {
    editorStateRef.current = new EditorState()
    editorStateRef.current.isEditMode = true
  }
  const editorState = editorStateRef.current

  // Ref to get OfficeState from the Phaser scene
  const getOfficeStateRef = useRef<(() => OfficeState) | null>(null)
  const getOfficeState = useCallback((): OfficeState => {
    if (!getOfficeStateRef.current) throw new Error('OfficeState not initialized yet')
    return getOfficeStateRef.current()
  }, [])

  // Grid visibility
  const [showGrid, setShowGrid] = useState(true)

  // Editor actions hook
  const actions = useEditorActions(getOfficeState, editorState)

  // Keyboard shortcuts
  const editorTick = useCallback(() => {
    // Force a re-render by triggering the next editorTick
    actions.handleEditorSelectionChange()
  }, [actions])

  useEditorKeyboard(
    true, // always in edit mode on this page
    editorState,
    actions.handleDeleteSelected,
    actions.handleRotateSelected,
    actions.handleToggleState,
    actions.handleUndo,
    actions.handleRedo,
    editorTick
  )

  // Determine selected furniture details for the property panel
  const selectedFurniture = useMemo(() => {
    try {
      const os = getOfficeStateRef.current?.()
      if (!os) return []
      return os.getLayout().furniture
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.editorTick])

  // Show furniture palette when in furniture tools
  const showFurniturePalette =
    editorState.activeTool === EditTool.FURNITURE_PLACE ||
    editorState.activeTool === EditTool.FURNITURE_PICK

  // Show property panel when applicable
  const showPropertyPanel =
    editorState.activeTool === EditTool.TILE_PAINT ||
    editorState.activeTool === EditTool.WALL_PAINT ||
    editorState.selectedFurnitureUid !== null

  const showRightPanel = showFurniturePalette || showPropertyPanel

  return (
    <div className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle bg-surface-raised">
        <Castle size={16} className="text-accent flex-shrink-0" />
        <h2 className="text-sm font-semibold text-text-primary">Office Editor</h2>
        <span className="text-[10px] text-text-muted ml-1">Design your pixel office layout</span>
        {actions.isDirty && (
          <span className="ml-auto text-[10px] text-warning font-medium px-1.5 py-0.5 rounded bg-warning/10">
            Unsaved changes
          </span>
        )}
      </div>

      {/* Toolbar */}
      <EditorToolbar
        activeTool={editorState.activeTool}
        isDirty={actions.isDirty}
        canUndo={editorState.undoStack.length > 0}
        canRedo={editorState.redoStack.length > 0}
        showGrid={showGrid}
        onToolChange={actions.handleToolChange}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        onSave={actions.handleSave}
        onReset={actions.handleReset}
        onToggleGrid={() => setShowGrid((v) => !v)}
      />

      {/* Main content: Canvas + Right panel */}
      <div className="flex-1 flex min-h-0">
        {/* Canvas area */}
        <div className="flex-1 min-w-0">
          <PhaserEditorCanvas
            editorState={editorState}
            editorTick={actions.editorTick}
            onTileAction={actions.handleEditorTileAction}
            onEraseAction={actions.handleEditorEraseAction}
            onSelectionChange={actions.handleEditorSelectionChange}
            onDragMove={actions.handleDragMove}
            getOfficeStateRef={getOfficeStateRef}
          />
        </div>

        {/* Right side panel */}
        {showRightPanel && (
          <div className="w-56 flex-shrink-0 border-l border-border-subtle bg-surface-raised overflow-y-auto">
            {/* Furniture palette (when in furniture tools) */}
            {showFurniturePalette && (
              <div className="border-b border-border-subtle">
                <div className="px-3 py-2 border-b border-border-subtle">
                  <span className="text-[11px] font-semibold text-text-primary">
                    Furniture Catalog
                  </span>
                </div>
                <FurniturePalette
                  selectedFurnitureType={editorState.selectedFurnitureType}
                  onFurnitureTypeChange={actions.handleFurnitureTypeChange}
                />
              </div>
            )}

            {/* Property panel */}
            {showPropertyPanel && (
              <div>
                <div className="px-3 py-2 border-b border-border-subtle">
                  <span className="text-[11px] font-semibold text-text-primary">Properties</span>
                </div>
                <PropertyPanel
                  activeTool={editorState.activeTool}
                  selectedFurnitureUid={editorState.selectedFurnitureUid}
                  furniture={selectedFurniture}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedTileType={editorState.selectedTileType}
                  onFloorColorChange={actions.handleFloorColorChange}
                  onWallColorChange={actions.handleWallColorChange}
                  onSelectedFurnitureColorChange={actions.handleSelectedFurnitureColorChange}
                  onDeleteSelected={actions.handleDeleteSelected}
                  onRotateSelected={actions.handleRotateSelected}
                  onToggleState={actions.handleToggleState}
                  onTileTypeChange={actions.handleTileTypeChange}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 px-4 py-1.5 border-t border-border-subtle bg-surface-raised text-[10px] text-text-muted">
        <span>
          Tool:{' '}
          <strong className="text-text-secondary">{formatToolName(editorState.activeTool)}</strong>
        </span>
        {editorState.selectedFurnitureUid && (
          <span>
            Selected:{' '}
            <strong className="text-text-secondary">
              {editorState.selectedFurnitureUid.slice(0, 12)}
            </strong>
          </span>
        )}
        <span className="ml-auto">
          Undo: {editorState.undoStack.length} · Redo: {editorState.redoStack.length}
        </span>
        <span>
          Shortcuts: <kbd className="px-1 py-0.5 rounded bg-surface-overlay text-[9px]">R</kbd>{' '}
          Rotate ·<kbd className="px-1 py-0.5 rounded bg-surface-overlay text-[9px]">T</kbd> Toggle
          ·<kbd className="px-1 py-0.5 rounded bg-surface-overlay text-[9px]">Del</kbd> Delete ·
          <kbd className="px-1 py-0.5 rounded bg-surface-overlay text-[9px]">Esc</kbd> Deselect
        </span>
      </div>
    </div>
  )
}

function formatToolName(tool: string): string {
  const names: Record<string, string> = {
    [EditTool.SELECT]: 'Select',
    [EditTool.TILE_PAINT]: 'Floor Paint',
    [EditTool.WALL_PAINT]: 'Wall Paint',
    [EditTool.FURNITURE_PLACE]: 'Furniture',
    [EditTool.FURNITURE_PICK]: 'Pick',
    [EditTool.EYEDROPPER]: 'Eyedropper',
    [EditTool.ERASE]: 'Erase'
  }
  return names[tool] ?? tool
}

// Editor tool selection bar — top row of the editor page.
// Tools: Select, Floor, Wall, Furniture, Erase, Eyedropper, Pick

import {
  MousePointer2,
  PaintBucket,
  Blocks,
  Armchair,
  Eraser,
  Pipette,
  Copy,
  Undo2,
  Redo2,
  Save,
  RotateCcw,
  Grid3x3
} from 'lucide-react'
import type { EditTool as EditToolType } from '../engine/types'
import { EditTool } from '../engine/types'

interface EditorToolbarProps {
  activeTool: EditToolType
  isDirty: boolean
  canUndo: boolean
  canRedo: boolean
  showGrid: boolean
  onToolChange: (tool: EditToolType) => void
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onReset: () => void
  onToggleGrid: () => void
}

const TOOLS: Array<{
  id: EditToolType
  label: string
  icon: typeof MousePointer2
  shortcut?: string
}> = [
  { id: EditTool.SELECT, label: 'Select', icon: MousePointer2 },
  { id: EditTool.TILE_PAINT, label: 'Floor', icon: PaintBucket },
  { id: EditTool.WALL_PAINT, label: 'Wall', icon: Blocks },
  { id: EditTool.FURNITURE_PLACE, label: 'Furniture', icon: Armchair },
  { id: EditTool.ERASE, label: 'Erase', icon: Eraser },
  { id: EditTool.EYEDROPPER, label: 'Eyedropper', icon: Pipette },
  { id: EditTool.FURNITURE_PICK, label: 'Pick', icon: Copy }
]

export default function EditorToolbar({
  activeTool,
  isDirty,
  canUndo,
  canRedo,
  showGrid,
  onToolChange,
  onUndo,
  onRedo,
  onSave,
  onReset,
  onToggleGrid
}: EditorToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-border-subtle bg-surface-base">
      {/* Tool buttons */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map((tool) => {
          const Icon = tool.icon
          const isActive = activeTool === tool.id
          return (
            <button
              key={tool.id}
              onClick={() => onToolChange(tool.id)}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-primary-muted text-primary-text border border-primary/30'
                  : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
              }`}
              title={tool.label}
            >
              <Icon size={14} />
              <span className="hidden lg:inline">{tool.label}</span>
            </button>
          )
        })}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border-subtle mx-1" />

      {/* Grid toggle */}
      <button
        onClick={onToggleGrid}
        className={`p-1.5 rounded-md transition-colors ${
          showGrid
            ? 'bg-primary-muted text-primary-text'
            : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary'
        }`}
        title="Toggle grid"
      >
        <Grid3x3 size={14} />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action buttons */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="p-1.5 rounded-md text-text-secondary hover:bg-surface-overlay hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={14} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="p-1.5 rounded-md text-text-secondary hover:bg-surface-overlay hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={14} />
        </button>

        <div className="w-px h-5 bg-border-subtle mx-1" />

        <button
          onClick={onSave}
          disabled={!isDirty}
          className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
            isDirty
              ? 'bg-success/20 text-success hover:bg-success/30 border border-success/30'
              : 'text-text-muted border border-transparent cursor-not-allowed'
          }`}
          title="Save layout"
        >
          <Save size={12} />
          <span>Save</span>
        </button>
        <button
          onClick={onReset}
          disabled={!isDirty}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:bg-surface-overlay hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Reset to last save"
        >
          <RotateCcw size={12} />
          <span>Reset</span>
        </button>
      </div>
    </div>
  )
}

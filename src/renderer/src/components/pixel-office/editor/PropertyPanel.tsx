// Property panel for selected furniture or floor/wall color editing.
// Shows HSBC color sliders + action buttons (rotate, delete) for selected items.

import { RotateCw, Trash2, ToggleLeft, Palette } from 'lucide-react'
import ColorPicker from './ColorPicker'
import type { FloorColor, EditTool as EditToolType, TileType as TileTypeVal } from '../engine/types'
import { EditTool, TileType } from '../engine/types'
import { getCatalogEntry, isRotatable } from '../layout/furnitureCatalog'
import type { PlacedFurniture } from '../engine/types'

interface PropertyPanelProps {
  activeTool: EditToolType
  selectedFurnitureUid: string | null
  furniture: PlacedFurniture[]
  floorColor: FloorColor
  wallColor: FloorColor
  selectedTileType: TileTypeVal
  onFloorColorChange: (color: FloorColor) => void
  onWallColorChange: (color: FloorColor) => void
  onSelectedFurnitureColorChange: (color: FloorColor | null) => void
  onDeleteSelected: () => void
  onRotateSelected: () => void
  onToggleState: () => void
  onTileTypeChange: (type: TileTypeVal) => void
}

const FLOOR_PATTERNS: Array<{ type: TileTypeVal; label: string }> = [
  { type: TileType.FLOOR_1, label: 'Pattern 1' },
  { type: TileType.FLOOR_2, label: 'Pattern 2' },
  { type: TileType.FLOOR_3, label: 'Pattern 3' },
  { type: TileType.FLOOR_4, label: 'Pattern 4' },
  { type: TileType.FLOOR_5, label: 'Pattern 5' },
  { type: TileType.FLOOR_6, label: 'Pattern 6' },
  { type: TileType.FLOOR_7, label: 'Pattern 7' }
]

export default function PropertyPanel({
  activeTool,
  selectedFurnitureUid,
  furniture,
  floorColor,
  wallColor,
  selectedTileType,
  onFloorColorChange,
  onWallColorChange,
  onSelectedFurnitureColorChange,
  onDeleteSelected,
  onRotateSelected,
  onToggleState,
  onTileTypeChange
}: PropertyPanelProps): React.JSX.Element {
  // Find the selected furniture item
  const selectedItem = selectedFurnitureUid
    ? furniture.find((f) => f.uid === selectedFurnitureUid)
    : null
  const selectedEntry = selectedItem ? getCatalogEntry(selectedItem.type) : null

  // Determine what to show based on active tool
  const showFloorProps = activeTool === EditTool.TILE_PAINT
  const showWallProps = activeTool === EditTool.WALL_PAINT
  const showFurnitureProps = selectedItem && selectedEntry

  if (!showFloorProps && !showWallProps && !showFurnitureProps) {
    return (
      <div className="p-3">
        <p className="text-[10px] text-text-muted text-center">
          Select a tool or furniture item to edit properties
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Floor properties */}
      {showFloorProps && (
        <>
          <div className="flex items-center gap-1.5">
            <Palette size={12} className="text-text-secondary" />
            <span className="text-[11px] font-semibold text-text-primary">Floor Pattern</span>
          </div>

          {/* Pattern selection */}
          <div className="flex flex-wrap gap-1">
            {FLOOR_PATTERNS.map((pattern) => (
              <button
                key={pattern.type}
                onClick={() => onTileTypeChange(pattern.type)}
                className={`w-7 h-7 rounded border text-[9px] font-mono transition-colors ${
                  selectedTileType === pattern.type
                    ? 'bg-primary-muted border-primary/40 text-primary-text'
                    : 'bg-surface-overlay border-border-subtle text-text-muted hover:border-border-default'
                }`}
                title={pattern.label}
              >
                {pattern.type}
              </button>
            ))}
          </div>

          <ColorPicker
            color={floorColor}
            onChange={onFloorColorChange}
            showColorize
            compact
            label="Floor Color"
          />
        </>
      )}

      {/* Wall properties */}
      {showWallProps && (
        <>
          <div className="flex items-center gap-1.5">
            <Palette size={12} className="text-text-secondary" />
            <span className="text-[11px] font-semibold text-text-primary">Wall Color</span>
          </div>

          <ColorPicker
            color={wallColor}
            onChange={onWallColorChange}
            showColorize
            compact
            label="Wall Color"
          />
        </>
      )}

      {/* Furniture properties */}
      {showFurnitureProps && selectedItem && selectedEntry && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-text-primary">
              {selectedEntry.label}
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            {isRotatable(selectedItem.type) && (
              <button
                onClick={onRotateSelected}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-info/15 text-info hover:bg-info/25 transition-colors"
                title="Rotate (R)"
              >
                <RotateCw size={11} />
                <span>Rotate</span>
              </button>
            )}
            <button
              onClick={onToggleState}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-warning/15 text-warning hover:bg-warning/25 transition-colors"
              title="Toggle state (T)"
            >
              <ToggleLeft size={11} />
              <span>Toggle</span>
            </button>
            <button
              onClick={onDeleteSelected}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-danger/15 text-danger hover:bg-danger/25 transition-colors"
              title="Delete (Del)"
            >
              <Trash2 size={11} />
              <span>Delete</span>
            </button>
          </div>

          {/* Furniture color */}
          <ColorPicker
            color={selectedItem.color ?? { h: 0, s: 0, b: 0, c: 0 }}
            onChange={onSelectedFurnitureColorChange}
            showColorize
            compact
            label="Furniture Color"
          />
          {selectedItem.color && (
            <button
              onClick={() => onSelectedFurnitureColorChange(null)}
              className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
            >
              Clear color override
            </button>
          )}
        </>
      )}
    </div>
  )
}

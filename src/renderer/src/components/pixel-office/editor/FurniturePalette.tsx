// Furniture catalog panel — categorized furniture items for placement.
// Renders sprite previews for each furniture item in the catalog.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FurnitureCategory } from '../layout/furnitureCatalog'
import {
  getActiveCatalog,
  getActiveCategories,
  getCatalogByCategory
} from '../layout/furnitureCatalog'
import type { SpriteData } from '../engine/types'

interface FurniturePaletteProps {
  selectedFurnitureType: string
  onFurnitureTypeChange: (type: string) => void
}

/** Render a furniture sprite preview to a canvas */
function SpritePreview({
  sprite,
  selected,
  onClick,
  label
}: {
  sprite: SpriteData
  selected: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewSize = 40

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sprite || sprite.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const spriteH = sprite.length
    const spriteW = sprite[0]?.length ?? 0
    if (spriteW === 0 || spriteH === 0) return

    canvas.width = previewSize
    canvas.height = previewSize
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, previewSize, previewSize)

    // Scale to fit within preview, maintaining aspect ratio
    const scale = Math.min(previewSize / spriteW, previewSize / spriteH)
    const zoom = Math.max(1, Math.floor(scale))
    const offsetX = Math.floor((previewSize - spriteW * zoom) / 2)
    const offsetY = Math.floor((previewSize - spriteH * zoom) / 2)

    for (let r = 0; r < spriteH; r++) {
      const row = sprite[r]
      if (!row) continue
      for (let c = 0; c < spriteW; c++) {
        const pixel = row[c]
        if (!pixel || pixel === '') continue
        ctx.fillStyle = pixel
        ctx.fillRect(offsetX + c * zoom, offsetY + r * zoom, zoom, zoom)
      }
    }
  }, [sprite])

  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 p-1.5 rounded-md transition-colors ${
        selected
          ? 'bg-primary-muted border border-primary/30 ring-1 ring-primary/20'
          : 'hover:bg-surface-overlay border border-transparent'
      }`}
      title={label}
    >
      <canvas
        ref={canvasRef}
        width={previewSize}
        height={previewSize}
        className="block"
        style={{ imageRendering: 'pixelated' }}
      />
      <span className="text-[9px] text-text-muted truncate max-w-[48px]">{label}</span>
    </button>
  )
}

export default function FurniturePalette({
  selectedFurnitureType,
  onFurnitureTypeChange
}: FurniturePaletteProps): React.JSX.Element {
  const categories = getActiveCategories()
  const [activeCategory, setActiveCategory] = useState<FurnitureCategory>(
    categories[0]?.id ?? 'desks'
  )

  const items = getCatalogByCategory(activeCategory)
  const hasCatalog = getActiveCatalog().length > 0

  const handleCategoryChange = useCallback((category: FurnitureCategory) => {
    setActiveCategory(category)
  }, [])

  if (!hasCatalog) {
    return (
      <div className="p-3 text-center">
        <p className="text-[11px] text-text-muted">Loading furniture catalog...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Category tabs */}
      <div className="flex flex-wrap gap-0.5 px-2 py-1.5 border-b border-border-subtle">
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => handleCategoryChange(cat.id)}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              activeCategory === cat.id
                ? 'bg-primary-muted text-primary-text'
                : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Items grid */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-3 gap-1">
          {items.map((item) => (
            <SpritePreview
              key={item.type}
              sprite={item.sprite}
              selected={selectedFurnitureType === item.type}
              onClick={() => onFurnitureTypeChange(item.type)}
              label={item.label}
            />
          ))}
        </div>
        {items.length === 0 && (
          <p className="text-[10px] text-text-muted text-center py-4">No items in this category</p>
        )}
      </div>
    </div>
  )
}

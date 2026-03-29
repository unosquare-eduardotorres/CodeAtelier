import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { X, Check } from 'lucide-react'
import type { Specialist } from '../../../../shared/types'
import {
  PIXEL_SPRITE_CATALOG,
  getVariants,
  type PixelSpriteEntry
} from '@renderer/assets/pixel-office/sprites'

// ── Vite glob import: resolve all sprite PNGs at build time ──

const spriteModules = import.meta.glob<string>(
  '@renderer/assets/pixel-office/sprites/**/*.png',
  { eager: true, import: 'default' }
)

/** Resolve a catalog entry's src path to an actual Vite-resolved URL */
function resolveSpriteSrc(entry: PixelSpriteEntry): string {
  // The glob keys are absolute from the project root alias, e.g.
  // "/src/renderer/src/assets/pixel-office/sprites/Male/Male 01-1.png"
  // The entry.src is relative: "./Male/Male 01-1.png"
  const relative = entry.src.replace('./', '')
  // Try matching by suffix
  for (const [key, url] of Object.entries(spriteModules)) {
    if (key.endsWith(relative)) return url
  }
  return entry.src
}

// ── Types ──

type CategoryFilter = 'all' | 'male' | 'female' | 'soldier' | 'enemy' | 'other' | 'xmas'

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  male: 'Male',
  female: 'Female',
  soldier: 'Soldier',
  enemy: 'Enemy',
  other: 'Other',
  xmas: 'Xmas'
}

interface PixelSpritePickerProps {
  value: string | null
  onChange: (id: string | null) => void
  /** All specialists (for "in use" validation) */
  specialists: Specialist[]
  /** The specialist being edited (excluded from "in use" check) */
  currentSpecialistId?: string
}

// ── Sprite Thumbnail — crops center frame of row 0 (idle-down) ──

function SpriteThumbnail({
  entry,
  size = 48,
  selected = false,
  onClick
}: {
  entry: PixelSpriteEntry
  size?: number
  selected?: boolean
  onClick?: () => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = (): void => {
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, size, size)
      // Center frame of row 0 = x:32 y:0 size 32x32
      ctx.drawImage(img, 32, 0, 32, 32, 0, 0, size, size)
      setLoaded(true)
    }
    img.src = resolveSpriteSrc(entry)
  }, [entry, size])

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        relative rounded-lg transition-all duration-150 cursor-pointer
        border-2 p-0.5
        ${selected
          ? 'border-primary ring-2 ring-primary/30 scale-105'
          : 'border-transparent hover:border-border-default hover:scale-105'
        }
        ${!loaded ? 'bg-surface-base' : ''}
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
      `}
      aria-label={`${entry.label}${entry.variant ? ` variant ${entry.variant}` : ''}`}
      title={`${entry.label}${entry.variant ? ` (v${entry.variant})` : ''}`}
    >
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="block"
        style={{ width: size, height: size, imageRendering: 'pixelated' }}
      />
      {selected && (
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
          <Check size={10} className="text-white" />
        </div>
      )}
    </button>
  )
}

// ── Main Component ──

export default function PixelSpritePicker({
  value,
  onChange,
  specialists,
  currentSpecialistId
}: PixelSpritePickerProps): React.JSX.Element {
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  // Get unique design groups with their first entry (for thumbnail)
  const designGroups = useMemo(() => {
    const groups: { designGroup: string; firstEntry: PixelSpriteEntry; totalVariants: number }[] = []
    const seen = new Set<string>()

    for (const entry of PIXEL_SPRITE_CATALOG) {
      if (seen.has(entry.designGroup)) continue
      seen.add(entry.designGroup)

      if (filter !== 'all' && entry.category !== filter) continue

      groups.push({
        designGroup: entry.designGroup,
        firstEntry: entry,
        totalVariants: entry.totalVariants
      })
    }

    return groups
  }, [filter])

  // Check which sprite IDs are in use by other specialists
  const usageMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const spec of specialists) {
      if (spec.pixelSpriteId && spec.id !== currentSpecialistId) {
        map.set(spec.pixelSpriteId, spec.displayName)
      }
    }
    return map
  }, [specialists, currentSpecialistId])

  // Find the selected entry
  const selectedEntry = useMemo(() => {
    if (!value) return null
    return PIXEL_SPRITE_CATALOG.find((e) => e.id === value) ?? null
  }, [value])

  const handleDesignClick = useCallback(
    (designGroup: string, totalVariants: number) => {
      if (totalVariants <= 1) {
        // Single variant — select directly
        const entry = PIXEL_SPRITE_CATALOG.find((e) => e.designGroup === designGroup)
        if (entry) onChange(entry.id)
        setExpandedGroup(null)
      } else {
        // Multiple variants — toggle expansion
        setExpandedGroup((prev) => (prev === designGroup ? null : designGroup))
      }
    },
    [onChange]
  )

  const handleVariantClick = useCallback(
    (id: string) => {
      onChange(id)
    },
    [onChange]
  )

  return (
    <div className="space-y-3">
      {/* Category filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CATEGORY_LABELS) as CategoryFilter[]).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setFilter(cat)
              setExpandedGroup(null)
            }}
            className={`
              px-3 py-1 rounded-md text-xs font-medium transition-colors
              ${filter === cat
                ? 'bg-primary text-white'
                : 'bg-surface-base text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle'
              }
            `}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* Sprite grid */}
      <div className="border border-border-subtle rounded-lg bg-surface-base p-3 max-h-[320px] overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          {designGroups.map(({ designGroup, firstEntry, totalVariants }) => {
            // Check if any variant in this group is selected
            const groupVariants = getVariants(designGroup)
            const isGroupSelected = groupVariants.some((v) => v.id === value)

            return (
              <div key={designGroup} className="flex flex-col">
                <SpriteThumbnail
                  entry={firstEntry}
                  size={48}
                  selected={isGroupSelected}
                  onClick={() => handleDesignClick(designGroup, totalVariants)}
                />
                {/* Variant count badge */}
                {totalVariants > 1 && (
                  <span className="text-center text-[9px] text-text-muted mt-0.5">
                    {totalVariants}v
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {/* Expanded variant row */}
        {expandedGroup && (
          <div className="mt-3 pt-3 border-t border-border-subtle">
            <p className="text-xs text-text-secondary mb-2">
              Variants for{' '}
              <span className="font-medium text-text-primary">
                {PIXEL_SPRITE_CATALOG.find((e) => e.designGroup === expandedGroup)?.label}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {getVariants(expandedGroup).map((variant) => {
                const usedBy = usageMap.get(variant.id)
                return (
                  <div key={variant.id} className="flex flex-col items-center">
                    <SpriteThumbnail
                      entry={variant}
                      size={48}
                      selected={variant.id === value}
                      onClick={() => handleVariantClick(variant.id)}
                    />
                    <span className="text-[9px] text-text-muted mt-0.5">
                      v{variant.variant}
                    </span>
                    {usedBy && (
                      <span className="text-[8px] text-warning mt-0.5 truncate max-w-[52px]">
                        in use
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Selection info */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-text-secondary">
          {selectedEntry ? (
            <>
              <span className="font-medium text-text-primary">
                {selectedEntry.label}
                {selectedEntry.variant !== null ? ` (v${selectedEntry.variant})` : ''}
              </span>
              {' — '}
              {usageMap.has(selectedEntry.id) ? (
                <span className="text-warning">
                  Used by {usageMap.get(selectedEntry.id)}
                </span>
              ) : (
                <span className="text-success">Available</span>
              )}
            </>
          ) : (
            <span className="text-text-muted italic">No pixel sprite selected</span>
          )}
        </div>

        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            <X size={12} />
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

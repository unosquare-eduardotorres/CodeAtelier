import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { X, Check, ChevronDown } from 'lucide-react'
import type { Specialist } from '../../../../shared/types'
import {
  PIXEL_SPRITE_CATALOG,
  getVariants,
  type PixelSpriteEntry
} from '@renderer/assets/pixel-office/sprites'

// ── Vite glob import: resolve all sprite PNGs at build time ──

const spriteModules = import.meta.glob<string>('@renderer/assets/pixel-office/sprites/**/*.png', {
  eager: true,
  import: 'default'
})

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
  disabled = false,
  onClick
}: {
  entry: PixelSpriteEntry
  size?: number
  selected?: boolean
  disabled?: boolean
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
      onClick={disabled ? undefined : onClick}
      className={`
        relative rounded-lg transition-all duration-150
        border-2 p-0.5
        ${
          selected
            ? 'border-primary ring-2 ring-primary/40 scale-110 bg-primary/10 cursor-pointer'
            : disabled
              ? 'border-transparent opacity-40 grayscale cursor-default'
              : 'border-transparent hover:border-border-default hover:scale-105 cursor-pointer'
        }
        ${!loaded ? 'bg-surface-base' : ''}
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
      `}
      aria-label={`${entry.label}${entry.variant ? ` variant ${entry.variant}` : ''}${disabled ? ' (taken)' : ''}`}
      title={`${entry.label}${entry.variant ? ` (v${entry.variant})` : ''}${disabled ? ' (taken)' : ''}`}
      tabIndex={disabled ? -1 : 0}
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
  const variantRowRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to expanded variant panel
  useEffect(() => {
    if (expandedGroup && variantRowRef.current) {
      variantRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [expandedGroup])

  // Get unique design groups with their first entry (for thumbnail)
  const designGroups = useMemo(() => {
    const groups: { designGroup: string; firstEntry: PixelSpriteEntry; totalVariants: number }[] =
      []
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

  // Check which sprite IDs are in use by other specialists — includes alias info
  const usageMap = useMemo(() => {
    const map = new Map<string, { displayName: string; alias: string | null }>()
    for (const spec of specialists) {
      if (spec.pixelSpriteId && spec.id !== currentSpecialistId) {
        map.set(spec.pixelSpriteId, {
          displayName: spec.displayName,
          alias: spec.alias
        })
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
        const isAlreadyExpanded = expandedGroup === designGroup
        setExpandedGroup(isAlreadyExpanded ? null : designGroup)
        // Auto-select the first variant if expanding (not collapsing)
        if (!isAlreadyExpanded) {
          const variants = getVariants(designGroup)
          if (variants.length > 0) {
            onChange(variants[0].id)
          }
        }
      }
    },
    [onChange, expandedGroup]
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
              ${
                filter === cat
                  ? 'bg-primary text-white'
                  : 'bg-surface-base text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle'
              }
            `}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* Currently selected — prominent display */}
      {selectedEntry && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
          <SpriteThumbnail entry={selectedEntry} size={36} selected={false} />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium text-text-primary">
              {selectedEntry.label}
              {selectedEntry.variant !== null ? ` (v${selectedEntry.variant})` : ''}
            </span>
            <span className="text-[11px] text-text-muted ml-1">&mdash; Selected</span>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            <X size={12} />
            Clear
          </button>
        </div>
      )}

      {/* Sprite grid */}
      <div className="border border-border-subtle rounded-lg bg-surface-base p-3 max-h-[320px] overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          {designGroups.map(({ designGroup, firstEntry, totalVariants }) => {
            // Check if any variant in this group is selected
            const groupVariants = getVariants(designGroup)
            const isGroupSelected = groupVariants.some((v) => v.id === value)

            // Check if the entire group is taken (any variant used by someone else)
            const groupUsageEntry = groupVariants.map((v) => usageMap.get(v.id)).find(Boolean)
            const isGroupTaken = !!groupUsageEntry && !isGroupSelected

            return (
              <div key={designGroup} className="flex flex-col items-center">
                <div className="relative">
                  <SpriteThumbnail
                    entry={firstEntry}
                    size={48}
                    selected={isGroupSelected}
                    disabled={isGroupTaken}
                    onClick={() => handleDesignClick(designGroup, totalVariants)}
                  />
                  {/* Expand indicator for multi-variant sprites */}
                  {totalVariants > 1 && !isGroupTaken && (
                    <div className="absolute bottom-0 right-0 w-4 h-4 rounded-tl-md bg-surface-overlay/80 flex items-center justify-center">
                      <ChevronDown size={10} className="text-text-muted" />
                    </div>
                  )}
                </div>
                {/* Name — show owner for taken sprites, character name otherwise */}
                {isGroupTaken ? (
                  <span className="text-[9px] text-warning mt-0.5 truncate max-w-[60px] text-center leading-tight">
                    {groupUsageEntry!.alias || groupUsageEntry!.displayName}
                  </span>
                ) : (
                  <span className="text-[9px] text-text-muted mt-0.5 truncate max-w-[52px] text-center leading-tight">
                    {firstEntry.label}
                  </span>
                )}
                {/* Variant count */}
                {totalVariants > 1 && !isGroupTaken && (
                  <span className="text-[8px] text-text-muted opacity-60">
                    {totalVariants} variants
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Expanded variant row — separate section below grid */}
      {expandedGroup && (
        <div
          ref={variantRowRef}
          className="border border-border-subtle rounded-lg bg-surface-base p-3"
        >
          <p className="text-xs text-text-secondary mb-2">
            Variants for{' '}
            <span className="font-medium text-text-primary">
              {PIXEL_SPRITE_CATALOG.find((e) => e.designGroup === expandedGroup)?.label}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {getVariants(expandedGroup).map((variant) => {
              const usage = usageMap.get(variant.id)
              const isTaken = !!usage
              return (
                <div key={variant.id} className="flex flex-col items-center">
                  <SpriteThumbnail
                    entry={variant}
                    size={48}
                    selected={variant.id === value}
                    disabled={isTaken}
                    onClick={() => handleVariantClick(variant.id)}
                  />
                  <span className="text-[9px] text-text-muted mt-0.5">
                    {variant.label} v{variant.variant}
                  </span>
                  {isTaken && (
                    <span className="text-[8px] text-warning mt-0.5 truncate max-w-[60px] text-center">
                      {usage!.alias || usage!.displayName}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Selection info (when nothing is selected) */}
      {!selectedEntry && (
        <div className="text-xs text-text-muted italic">No pixel sprite selected</div>
      )}

      {/* Prominent duplicate warning */}
      {selectedEntry && usageMap.has(selectedEntry.id) && (
        <div className="px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
          ⚠️ This avatar is already assigned to{' '}
          <strong>
            {usageMap.get(selectedEntry.id)!.alias || usageMap.get(selectedEntry.id)!.displayName}
          </strong>
          . Consider choosing a unique avatar for each specialist.
        </div>
      )}
    </div>
  )
}

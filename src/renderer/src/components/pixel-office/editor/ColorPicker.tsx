// HSBC Color Picker — Hue, Saturation, Brightness, Contrast sliders
// Reused for floor, wall, and furniture color editing.

import { useCallback, useMemo } from 'react'
import type { FloorColor } from '../engine/types'

/** Convert HSBC FloorColor to a CSS hsl() string for visual preview */
function floorColorToCSS(color: FloorColor): string {
  const h = ((color.h % 360) + 360) % 360
  const l = Math.max(6, Math.min(55, 25 + color.b / 1.5))
  const s = Math.max(8, Math.min(50, 25 + color.s / 2))
  return `hsl(${h}, ${s}%, ${l}%)`
}

interface ColorSliderProps {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  colorClass?: string
}

function ColorSlider({
  label,
  value,
  min,
  max,
  onChange,
  colorClass
}: ColorSliderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`text-[10px] font-medium w-4 text-right ${colorClass ?? 'text-text-secondary'}`}
      >
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1 accent-primary cursor-pointer"
        style={{ minWidth: 80 }}
      />
      <span className="text-[10px] text-text-muted w-8 text-right tabular-nums">{value}</span>
    </div>
  )
}

interface ColorPickerProps {
  color: FloorColor
  onChange: (color: FloorColor) => void
  /** Show the "Colorize" checkbox toggle */
  showColorize?: boolean
  /** Compact mode for inline use */
  compact?: boolean
  /** Label for the picker section */
  label?: string
}

export default function ColorPicker({
  color,
  onChange,
  showColorize = false,
  compact = false,
  label
}: ColorPickerProps): React.JSX.Element {
  const handleChange = useCallback(
    (key: keyof FloorColor, value: number | boolean) => {
      onChange({ ...color, [key]: value })
    },
    [color, onChange]
  )

  // Determine ranges based on colorize mode
  const isColorize = !!color.colorize
  const hMin = isColorize ? 0 : -180
  const hMax = isColorize ? 360 : 180
  const sMin = isColorize ? 0 : -100
  const sMax = 100

  const previewColor = useMemo(() => floorColorToCSS(color), [color])

  return (
    <div className={`flex flex-col ${compact ? 'gap-1' : 'gap-1.5'}`}>
      {label && (
        <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
          {label}
        </span>
      )}
      {/* Color preview swatch */}
      <div
        className="w-full h-6 rounded border border-border-subtle"
        style={{ backgroundColor: previewColor }}
      />
      <ColorSlider
        label="H"
        value={color.h}
        min={hMin}
        max={hMax}
        onChange={(v) => handleChange('h', v)}
        colorClass="text-red-400"
      />
      <ColorSlider
        label="S"
        value={color.s}
        min={sMin}
        max={sMax}
        onChange={(v) => handleChange('s', v)}
        colorClass="text-green-400"
      />
      <ColorSlider
        label="B"
        value={color.b}
        min={-100}
        max={100}
        onChange={(v) => handleChange('b', v)}
        colorClass="text-blue-400"
      />
      <ColorSlider
        label="C"
        value={color.c}
        min={-100}
        max={100}
        onChange={(v) => handleChange('c', v)}
        colorClass="text-yellow-400"
      />
      {showColorize && (
        <label className="flex items-center gap-2 cursor-pointer mt-0.5">
          <input
            type="checkbox"
            checked={isColorize}
            onChange={(e) => handleChange('colorize', e.target.checked)}
            className="accent-primary"
          />
          <span className="text-[10px] text-text-secondary">Colorize</span>
        </label>
      )}
    </div>
  )
}

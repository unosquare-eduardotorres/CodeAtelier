import { useAppTheme, useAppPreferenceActions } from '@renderer/store'
import type { AppTheme } from '../../../../shared/types'

const THEME_OPTIONS: {
  value: AppTheme
  label: string
  description: string
  preview: string[]
}[] = [
  {
    value: 'code-atelier',
    label: 'Code Atelier',
    description: 'Renaissance gold & teal',
    preview: ['#090d0f', '#111c21', '#b8976a', '#c4714a']
  },
  {
    value: 'neon-forge',
    label: 'Neon Forge',
    description: 'Cyberpunk cyan & magenta',
    preview: ['#0a0e1a', '#111827', '#06b6d4', '#e879f9']
  },
  {
    value: 'porcelain',
    label: 'Porcelain',
    description: 'Ceramic elegance, cool whites',
    preview: ['#f8f9fb', '#f0f1f4', '#475569', '#0284c7']
  }
]

export default function ThemeSection(): React.JSX.Element {
  const currentTheme = useAppTheme()
  const { setPreference } = useAppPreferenceActions()

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Theme</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-3">
        Choose the visual style for the entire application.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => void setPreference('appTheme', opt.value).catch(console.error)}
            className={`flex flex-col items-center gap-2 px-3 py-3 rounded-lg border text-xs font-medium transition-colors ${
              currentTheme === opt.value
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            {/* Color swatches preview */}
            <div className="flex gap-1">
              {opt.preview.map((color, i) => (
                <div
                  key={i}
                  className="w-5 h-5 rounded-sm border border-border-subtle"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <span>{opt.label}</span>
            <span className="text-[10px] text-text-muted font-normal">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

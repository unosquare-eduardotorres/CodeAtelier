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
    preview: ['#111a1e', '#182428', '#b8976a', '#7bb8c9']
  },
  {
    value: 'glass',
    label: 'Glass',
    description: 'Frosted glass, violet depth',
    preview: ['#0b0e18', '#161a2c', '#8b5cf6', '#67e8f9']
  },
  {
    value: 'porcelain',
    label: 'Porcelain',
    description: 'Ceramic elegance, cool whites',
    preview: ['#f8f9fb', '#f0f1f4', '#475569', '#0284c7']
  },
  {
    value: 'developer',
    label: 'Developer',
    description: 'Neutral dark, zero distraction',
    preview: ['#1e1e1e', '#252526', '#569cd6', '#4ec9b0']
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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

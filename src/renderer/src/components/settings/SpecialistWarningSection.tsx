import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import {
  useAppPreferenceActions,
  useSpecialistWarningPreferences,
  useAppPreferenceStatus
} from '@renderer/store'

export default function SpecialistWarningPreferencesSection(): React.JSX.Element {
  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()
  const { loadPreferences, setPreference } = useAppPreferenceActions()
  const { isLoading, savingKeys, error } = useAppPreferenceStatus()

  useEffect(() => {
    void loadPreferences().catch((loadError) => {
      console.error('Failed to load specialist warning preferences:', loadError)
    })
  }, [loadPreferences])

  const rows: Array<{
    key: 'specialistWarningBuild' | 'specialistWarningPlan' | 'specialistWarningAlways'
    label: string
    description: string
    checked: boolean
  }> = [
    {
      key: 'specialistWarningBuild',
      label: 'Build mode warnings',
      description: 'Warn before build actions when specialist activation can increase token usage.',
      checked: specialistWarningBuild
    },
    {
      key: 'specialistWarningPlan',
      label: 'Plan mode warnings',
      description: 'Warn before plan actions when specialist activation can increase token usage.',
      checked: specialistWarningPlan
    },
    {
      key: 'specialistWarningAlways',
      label: 'Always show warning dialog',
      description:
        'Always show specialist warning dialog regardless of mode-specific warning toggles.',
      checked: specialistWarningAlways
    }
  ]

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-text-primary">Specialist Activation Warnings</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            Control when confirmation dialogs appear before specialist-enhanced actions.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <div className="text-xs text-text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Loading preferences...
          </div>
        ) : (
          rows.map((row) => {
            const isSavingRow = savingKeys[row.key] ?? false
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface-base px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-text-body">{row.label}</p>
                  <p className="text-xs text-text-secondary">{row.description}</p>
                </div>

                <button
                  onClick={() => {
                    void setPreference(row.key, !row.checked).catch((setError) => {
                      console.error(`Failed to update preference "${row.key}":`, setError)
                    })
                  }}
                  disabled={isSavingRow}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    row.checked ? 'bg-primary' : 'bg-surface-base border border-border-default'
                  }`}
                  role="switch"
                  aria-checked={row.checked}
                  aria-label={row.label}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                      row.checked ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )
          })
        )}
      </div>

      {error && (
        <p className="text-xs text-danger mt-3">Failed to update warning preferences: {error}</p>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react'
import {
  useAppPreferenceActions,
  useAppPreferenceStatus,
  useSpecialistWarningPreferences
} from '@renderer/store'

export type SpecialistWarningType = 'build' | 'plan' | 'always'

interface SpecialistWarningDialogProps {
  isOpen: boolean
  warningType: SpecialistWarningType
  activeSpecialistCount: number
  estimatedTokens?: number
  onConfirm: () => void
  onCancel: () => void
}

type PreferenceKey = 'specialistWarningBuild' | 'specialistWarningPlan' | 'specialistWarningAlways'

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US')

const warningPreferenceMap: Record<SpecialistWarningType, PreferenceKey> = {
  build: 'specialistWarningBuild',
  plan: 'specialistWarningPlan',
  always: 'specialistWarningAlways'
}

const warningTitleMap: Record<SpecialistWarningType, string> = {
  build: 'Specialists will be used for this build action',
  plan: 'Specialists will be used for this plan action',
  always: 'Specialists are active in this conversation'
}

const warningDescriptionMap: Record<SpecialistWarningType, string> = {
  build:
    'Conversation specialist settings can increase prompt size and may impact run cost. Continue with specialists enabled?',
  plan: 'Specialists can add more context for planning. Continue with specialist configuration?',
  always:
    'This conversation currently has specialist overrides configured. Continue with the current setup?'
}

export default function SpecialistWarningDialog({
  isOpen,
  warningType,
  activeSpecialistCount,
  estimatedTokens,
  onConfirm,
  onCancel
}: SpecialistWarningDialogProps): React.JSX.Element | null {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()
  const { loadPreferences, setPreference } = useAppPreferenceActions()
  const { isLoading, savingKeys, error } = useAppPreferenceStatus()

  useEffect(() => {
    if (!isOpen) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on dialog open
    setDontShowAgain(false)
    void loadPreferences().catch(() => undefined)
  }, [isOpen, loadPreferences])

  const preferenceKey = warningPreferenceMap[warningType]

  const isWarningEnabled = useMemo(() => {
    if (warningType === 'build') return specialistWarningBuild
    if (warningType === 'plan') return specialistWarningPlan
    return specialistWarningAlways
  }, [specialistWarningAlways, specialistWarningBuild, specialistWarningPlan, warningType])

  const handleContinue = async (): Promise<void> => {
    setIsSubmitting(true)
    try {
      if (dontShowAgain) {
        await setPreference(preferenceKey, false)
      }
      // onConfirm is now sync (closes dialog + fires send in background)
      onConfirm()
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-label="Close specialist warning"
      />

      <div className="relative w-full max-w-md mx-4 rounded-xl border border-border-default bg-surface-float shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border-subtle bg-warning-muted/40">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-warning-muted border border-warning/30 flex items-center justify-center text-warning shrink-0">
              <ShieldAlert size={18} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {warningTitleMap[warningType]}
              </h3>
              <p className="text-xs text-text-secondary mt-1">
                {warningDescriptionMap[warningType]}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="rounded-lg border border-border-subtle bg-surface-overlay/70 px-3 py-2">
            <p className="text-xs text-text-secondary">
              <span className="text-text-primary font-medium">{activeSpecialistCount}</span> active
              specialist
              {activeSpecialistCount === 1 ? '' : 's'}
              {typeof estimatedTokens === 'number' ? (
                <>
                  {' '}
                  · Estimated prompt impact:{' '}
                  <span className="text-text-primary font-medium">
                    ~{TOKEN_FORMATTER.format(estimatedTokens)} tokens
                  </span>
                </>
              ) : null}
            </p>
          </div>

          {!isWarningEnabled && (
            <div className="rounded-lg border border-info/25 bg-info-muted px-3 py-2 text-xs text-info flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>This warning is currently disabled in your preferences.</span>
            </div>
          )}

          <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => setDontShowAgain(event.target.checked)}
              className="mt-0.5 rounded border-border-default bg-surface-base text-primary focus:ring-primary/50"
              disabled={isSubmitting || isLoading}
            />
            <span>
              Don&apos;t show this {warningType} warning again
              {savingKeys[preferenceKey] && (
                <span className="inline-flex items-center gap-1 ml-2 text-text-muted">
                  <Loader2 size={11} className="animate-spin" />
                  Saving…
                </span>
              )}
            </span>
          </label>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleContinue()}
            disabled={isSubmitting || isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-warning text-white hover:brightness-110 transition-colors disabled:opacity-50"
          >
            {isSubmitting && <Loader2 size={12} className="animate-spin" />}
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

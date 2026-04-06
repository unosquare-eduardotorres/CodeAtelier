import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import type { AppPreferences } from '../../../shared/types'

type AppPreferenceKey = keyof AppPreferences

const defaultPreferences: AppPreferences = {
  specialistWarningBuild: true,
  specialistWarningPlan: true,
  specialistWarningAlways: false
}

const preferenceStorageKeys: Record<AppPreferenceKey, string> = {
  specialistWarningBuild: 'specialist_warning_build',
  specialistWarningPlan: 'specialist_warning_plan',
  specialistWarningAlways: 'specialist_warning_always'
}

interface AppPreferenceState {
  preferences: AppPreferences
  isLoading: boolean
  isSaving: boolean
  savingKeys: Partial<Record<AppPreferenceKey, boolean>>
  error: string | null

  loadPreferences: () => Promise<void>
  setPreference: (key: AppPreferenceKey, value: boolean) => Promise<void>
  reset: () => void
}

const normalizePreferences = (
  preferences: Partial<AppPreferences> | null | undefined
): AppPreferences => ({
  ...defaultPreferences,
  ...preferences
})

export const useAppPreferenceStore = create<AppPreferenceState>((set) => ({
  preferences: defaultPreferences,
  isLoading: false,
  isSaving: false,
  savingKeys: {},
  error: null,

  loadPreferences: async () => {
    set({ isLoading: true, error: null })
    try {
      const preferences = await window.api.getAppPreferences()
      set({
        preferences: normalizePreferences(preferences),
        isLoading: false
      })
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to load app preferences:', error)
      set({
        isLoading: false,
        error: message
      })
      throw error
    }
  },

  setPreference: async (key: AppPreferenceKey, value: boolean) => {
    const previous = useAppPreferenceStore.getState().preferences
    set((state) => ({
      preferences: {
        ...state.preferences,
        [key]: value
      },
      isSaving: true,
      savingKeys: {
        ...state.savingKeys,
        [key]: true
      },
      error: null
    }))

    try {
      await window.api.setAppPreference({
        key: preferenceStorageKeys[key],
        value: value ? 'true' : 'false'
      })
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to save app preference:', error)
      set({
        preferences: previous,
        error: message
      })
      throw error
    } finally {
      set((state) => {
        const nextSavingKeys = {
          ...state.savingKeys,
          [key]: false
        }
        return {
          isSaving: Object.values(nextSavingKeys).some(Boolean),
          savingKeys: nextSavingKeys
        }
      })
    }
  },

  reset: () => {
    set({
      preferences: defaultPreferences,
      isLoading: false,
      isSaving: false,
      savingKeys: {},
      error: null
    })
  }
}))

export const useAppPreferenceActions = (): Pick<
  AppPreferenceState,
  'loadPreferences' | 'setPreference' | 'reset'
> =>
  useAppPreferenceStore(
    useShallow((state) => ({
      loadPreferences: state.loadPreferences,
      setPreference: state.setPreference,
      reset: state.reset
    }))
  )

export const useSpecialistWarningPreferences = (): Pick<
  AppPreferences,
  'specialistWarningBuild' | 'specialistWarningPlan' | 'specialistWarningAlways'
> =>
  useAppPreferenceStore(
    useShallow((state) => ({
      specialistWarningBuild: state.preferences.specialistWarningBuild,
      specialistWarningPlan: state.preferences.specialistWarningPlan,
      specialistWarningAlways: state.preferences.specialistWarningAlways
    }))
  )

export const useAppPreferenceStatus = (): Pick<
  AppPreferenceState,
  'isLoading' | 'isSaving' | 'error' | 'savingKeys'
> =>
  useAppPreferenceStore(
    useShallow((state) => ({
      isLoading: state.isLoading,
      isSaving: state.isSaving,
      error: state.error,
      savingKeys: state.savingKeys
    }))
  )

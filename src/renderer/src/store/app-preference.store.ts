import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import type { AppPreferences, AppTheme, ChatBubbleSize, UserAvatarVariant } from '../../../shared/types'

type AppPreferenceKey = keyof AppPreferences

const defaultPreferences: AppPreferences = {
  specialistWarningBuild: true,
  specialistWarningPlan: true,
  specialistWarningAlways: false,
  chatBubbleSize: 'xl',
  appTheme: 'code-atelier',
  updateSource: 'drive',
  updateDrivePath: '',
  updateGithubOwner: '',
  updateGithubRepo: '',
  context7ApiKey: '',
  notificationsEnabled: true,
  parallelBuildAgents: 3,
  leanBuildMcp: false,
  userAvatarVariant: '1' as UserAvatarVariant,
  maxStreamLifetimeMin: 30
}

const preferenceStorageKeys: Record<AppPreferenceKey, string> = {
  specialistWarningBuild: 'specialist_warning_build',
  specialistWarningPlan: 'specialist_warning_plan',
  specialistWarningAlways: 'specialist_warning_always',
  chatBubbleSize: 'chat_bubble_size',
  appTheme: 'app_theme',
  updateSource: 'update_source',
  updateDrivePath: 'update_drive_path',
  updateGithubOwner: 'update_github_owner',
  updateGithubRepo: 'update_github_repo',
  context7ApiKey: 'context7_api_key',
  notificationsEnabled: 'notifications_enabled',
  parallelBuildAgents: 'parallel_build_agents',
  leanBuildMcp: 'lean_build_mcp',
  userAvatarVariant: 'user_avatar_variant',
  maxStreamLifetimeMin: 'max_stream_lifetime_min'
}

interface AppPreferenceState {
  preferences: AppPreferences
  isLoading: boolean
  isSaving: boolean
  savingKeys: Partial<Record<AppPreferenceKey, boolean>>
  error: string | null

  loadPreferences: () => Promise<void>
  setPreference: (key: AppPreferenceKey, value: boolean | string | number) => Promise<void>
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

  setPreference: async (key: AppPreferenceKey, value: boolean | string | number) => {
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
        value: typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
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

export const useChatBubbleSize = (): ChatBubbleSize =>
  useAppPreferenceStore((state) => state.preferences.chatBubbleSize)

export const useAppTheme = (): AppTheme =>
  useAppPreferenceStore((state) => state.preferences.appTheme)

export const useNotificationsEnabled = (): boolean =>
  useAppPreferenceStore((state) => state.preferences.notificationsEnabled)

export const useParallelBuildAgents = (): number =>
  useAppPreferenceStore((state) => state.preferences.parallelBuildAgents)

export const useLeanBuildMcp = (): boolean =>
  useAppPreferenceStore((state) => state.preferences.leanBuildMcp)

export const useMaxStreamLifetimeMin = (): number =>
  useAppPreferenceStore((state) => state.preferences.maxStreamLifetimeMin)

export const useUserAvatarVariant = (): UserAvatarVariant =>
  useAppPreferenceStore((state) => state.preferences.userAvatarVariant)

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

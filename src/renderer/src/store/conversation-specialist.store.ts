import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import type { ConversationSpecialist, SpecialistTokenEstimate } from '../../../shared/types'

interface UpsertConversationSpecialistInput {
  conversationId: string
  specialistId: string
  isActive?: boolean
}

interface ConversationSpecialistState {
  specialistsByConversation: Record<string, ConversationSpecialist[]>
  tokenEstimatesByConversation: Record<string, SpecialistTokenEstimate[]>
  isLoadingByConversation: Record<string, boolean>
  isMutatingByConversation: Record<string, boolean>
  isEstimatingByConversation: Record<string, boolean>
  errorByConversation: Record<string, string | null>

  loadConversationSpecialists: (conversationId: string) => Promise<ConversationSpecialist[]>
  upsertConversationSpecialist: (args: UpsertConversationSpecialistInput) => Promise<void>
  removeConversationSpecialist: (args: {
    conversationId: string
    specialistId: string
  }) => Promise<void>
  resetConversationSpecialists: (conversationId: string) => Promise<void>
  estimateConversationTokens: (conversationId: string) => Promise<SpecialistTokenEstimate[]>
  hydrateConversationSpecialists: (conversationId: string) => Promise<void>
  clearConversationState: (conversationId: string) => void
  reset: () => void
}

const initialState = {
  specialistsByConversation: {},
  tokenEstimatesByConversation: {},
  isLoadingByConversation: {},
  isMutatingByConversation: {},
  isEstimatingByConversation: {},
  errorByConversation: {}
}

const ensureConversationId = (conversationId: string): void => {
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    throw new Error('Conversation ID is required')
  }
}

const removeConversationKey = <T>(
  record: Record<string, T>,
  conversationId: string
): Record<string, T> => {
  if (!(conversationId in record)) {
    return record
  }

  const nextRecord = { ...record }
  delete nextRecord[conversationId]
  return nextRecord
}

export const useConversationSpecialistStore = create<ConversationSpecialistState>((set, get) => ({
  ...initialState,

  loadConversationSpecialists: async (conversationId: string) => {
    ensureConversationId(conversationId)
    set((state) => ({
      isLoadingByConversation: {
        ...state.isLoadingByConversation,
        [conversationId]: true
      },
      errorByConversation: {
        ...state.errorByConversation,
        [conversationId]: null
      }
    }))

    try {
      const specialists = await window.api.listConvSpecialists({ conversationId })
      set((state) => ({
        specialistsByConversation: {
          ...state.specialistsByConversation,
          [conversationId]: specialists
        },
        isLoadingByConversation: {
          ...state.isLoadingByConversation,
          [conversationId]: false
        }
      }))
      return specialists
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to load conversation specialists:', error)
      set((state) => ({
        isLoadingByConversation: {
          ...state.isLoadingByConversation,
          [conversationId]: false
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: message
        }
      }))
      throw error
    }
  },

  upsertConversationSpecialist: async (args: UpsertConversationSpecialistInput) => {
    ensureConversationId(args.conversationId)
    set((state) => ({
      isMutatingByConversation: {
        ...state.isMutatingByConversation,
        [args.conversationId]: true
      },
      errorByConversation: {
        ...state.errorByConversation,
        [args.conversationId]: null
      }
    }))

    try {
      await window.api.upsertConvSpecialist(args)
      await Promise.all([
        get().loadConversationSpecialists(args.conversationId),
        get().estimateConversationTokens(args.conversationId)
      ])
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to upsert conversation specialist:', error)
      set((state) => ({
        errorByConversation: {
          ...state.errorByConversation,
          [args.conversationId]: message
        }
      }))
      throw error
    } finally {
      set((state) => ({
        isMutatingByConversation: {
          ...state.isMutatingByConversation,
          [args.conversationId]: false
        }
      }))
    }
  },

  removeConversationSpecialist: async (args: { conversationId: string; specialistId: string }) => {
    ensureConversationId(args.conversationId)
    set((state) => ({
      isMutatingByConversation: {
        ...state.isMutatingByConversation,
        [args.conversationId]: true
      },
      errorByConversation: {
        ...state.errorByConversation,
        [args.conversationId]: null
      }
    }))

    try {
      await window.api.removeConvSpecialist(args)
      await Promise.all([
        get().loadConversationSpecialists(args.conversationId),
        get().estimateConversationTokens(args.conversationId)
      ])
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to remove conversation specialist:', error)
      set((state) => ({
        errorByConversation: {
          ...state.errorByConversation,
          [args.conversationId]: message
        }
      }))
      throw error
    } finally {
      set((state) => ({
        isMutatingByConversation: {
          ...state.isMutatingByConversation,
          [args.conversationId]: false
        }
      }))
    }
  },

  resetConversationSpecialists: async (conversationId: string) => {
    ensureConversationId(conversationId)
    set((state) => ({
      isMutatingByConversation: {
        ...state.isMutatingByConversation,
        [conversationId]: true
      },
      errorByConversation: {
        ...state.errorByConversation,
        [conversationId]: null
      }
    }))

    try {
      await window.api.resetConvSpecialists({ conversationId })
      await Promise.all([
        get().loadConversationSpecialists(conversationId),
        get().estimateConversationTokens(conversationId)
      ])
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to reset conversation specialists:', error)
      set((state) => ({
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: message
        }
      }))
      throw error
    } finally {
      set((state) => ({
        isMutatingByConversation: {
          ...state.isMutatingByConversation,
          [conversationId]: false
        }
      }))
    }
  },

  estimateConversationTokens: async (conversationId: string) => {
    ensureConversationId(conversationId)
    set((state) => ({
      isEstimatingByConversation: {
        ...state.isEstimatingByConversation,
        [conversationId]: true
      },
      errorByConversation: {
        ...state.errorByConversation,
        [conversationId]: null
      }
    }))

    try {
      const estimates = await window.api.estimateConvTokens({ conversationId })
      set((state) => ({
        tokenEstimatesByConversation: {
          ...state.tokenEstimatesByConversation,
          [conversationId]: estimates
        },
        isEstimatingByConversation: {
          ...state.isEstimatingByConversation,
          [conversationId]: false
        }
      }))
      return estimates
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to estimate conversation specialist tokens:', error)
      set((state) => ({
        isEstimatingByConversation: {
          ...state.isEstimatingByConversation,
          [conversationId]: false
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: message
        }
      }))
      throw error
    }
  },

  hydrateConversationSpecialists: async (conversationId: string) => {
    ensureConversationId(conversationId)
    await Promise.all([
      get().loadConversationSpecialists(conversationId),
      get().estimateConversationTokens(conversationId)
    ])
  },

  clearConversationState: (conversationId: string) => {
    ensureConversationId(conversationId)
    set((state) => ({
      specialistsByConversation: removeConversationKey(
        state.specialistsByConversation,
        conversationId
      ),
      tokenEstimatesByConversation: removeConversationKey(
        state.tokenEstimatesByConversation,
        conversationId
      ),
      isLoadingByConversation: removeConversationKey(state.isLoadingByConversation, conversationId),
      isMutatingByConversation: removeConversationKey(
        state.isMutatingByConversation,
        conversationId
      ),
      isEstimatingByConversation: removeConversationKey(
        state.isEstimatingByConversation,
        conversationId
      ),
      errorByConversation: removeConversationKey(state.errorByConversation, conversationId)
    }))
  },

  reset: () => {
    set(initialState)
  }
}))

export const useConversationSpecialistActions = (): Pick<
  ConversationSpecialistState,
  | 'loadConversationSpecialists'
  | 'upsertConversationSpecialist'
  | 'removeConversationSpecialist'
  | 'resetConversationSpecialists'
  | 'estimateConversationTokens'
  | 'hydrateConversationSpecialists'
  | 'clearConversationState'
  | 'reset'
> =>
  useConversationSpecialistStore(
    useShallow((state) => ({
      loadConversationSpecialists: state.loadConversationSpecialists,
      upsertConversationSpecialist: state.upsertConversationSpecialist,
      removeConversationSpecialist: state.removeConversationSpecialist,
      resetConversationSpecialists: state.resetConversationSpecialists,
      estimateConversationTokens: state.estimateConversationTokens,
      hydrateConversationSpecialists: state.hydrateConversationSpecialists,
      clearConversationState: state.clearConversationState,
      reset: state.reset
    }))
  )

const EMPTY_SPECIALISTS: ConversationSpecialist[] = []
const EMPTY_TOKEN_ESTIMATES: SpecialistTokenEstimate[] = []

export const useConversationSpecialists = (
  conversationId: string | null | undefined
): ConversationSpecialist[] =>
  useConversationSpecialistStore((state) =>
    conversationId
      ? (state.specialistsByConversation[conversationId] ?? EMPTY_SPECIALISTS)
      : EMPTY_SPECIALISTS
  )

export const useConversationTokenEstimates = (
  conversationId: string | null | undefined
): SpecialistTokenEstimate[] =>
  useConversationSpecialistStore((state) =>
    conversationId
      ? (state.tokenEstimatesByConversation[conversationId] ?? EMPTY_TOKEN_ESTIMATES)
      : EMPTY_TOKEN_ESTIMATES
  )

export const useConversationSpecialistStatus = (
  conversationId: string | null | undefined
): {
  isLoading: boolean
  isMutating: boolean
  isEstimating: boolean
  error: string | null
} =>
  useConversationSpecialistStore(
    useShallow((state) => ({
      isLoading: conversationId ? (state.isLoadingByConversation[conversationId] ?? false) : false,
      isMutating: conversationId
        ? (state.isMutatingByConversation[conversationId] ?? false)
        : false,
      isEstimating: conversationId
        ? (state.isEstimatingByConversation[conversationId] ?? false)
        : false,
      error: conversationId ? (state.errorByConversation[conversationId] ?? null) : null
    }))
  )

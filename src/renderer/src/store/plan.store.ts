/**
 * Plan store — manages state for the Plan Hub page.
 *
 * Simple CRUD store following the idea.store.ts pattern:
 *   - Load plans from IPC
 *   - Filter/search client-side
 *   - Optimistic updates after mutations
 */

import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { PlanRecord, PlanStatus, PlanStatusHistoryEntry } from '../../../shared/types'

// ── Store interface ─────────────────────────────────────────────────────

export type PlanStatusFilter = 'all' | 'active' | 'saved' | 'done'

interface PlanState {
  plans: PlanRecord[]
  isLoading: boolean
  statusFilter: PlanStatusFilter
  searchQuery: string

  // Detail view state
  selectedPlanId: string | null
  selectedPlan: PlanRecord | null
  statusHistory: PlanStatusHistoryEntry[]
  isLoadingDetail: boolean
  previousPlan: PlanRecord | null
  supersedingPlan: PlanRecord | null

  // Actions
  loadPlans: (workspaceId: string) => Promise<void>
  setStatusFilter: (filter: PlanStatusFilter) => void
  setSearchQuery: (query: string) => void
  updateStatus: (planId: string, status: PlanStatus) => Promise<void>
  deletePlan: (planId: string) => Promise<void>
  importPlan: (planId: string, workspaceId: string) => Promise<{ conversationId: string }>
  selectPlan: (planId: string) => Promise<void>
  clearSelectedPlan: () => void
  reset: () => void
}

// ── Filter helpers ──────────────────────────────────────────────────────

function matchesStatusFilter(plan: PlanRecord, filter: PlanStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'saved':
      return plan.status === 'saved'
    case 'active':
      return plan.status === 'handed_off' || plan.status === 'in_progress'
    case 'done':
      return plan.status === 'completed' || plan.status === 'archived'
  }
}

function matchesSearch(plan: PlanRecord, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return plan.title.toLowerCase().includes(q) || plan.summary.toLowerCase().includes(q)
}

// ── Store ───────────────────────────────────────────────────────────────

export const usePlanStore = create<PlanState>((set, get) => ({
  plans: [],
  isLoading: false,
  statusFilter: 'all',
  searchQuery: '',
  selectedPlanId: null,
  selectedPlan: null,
  statusHistory: [],
  isLoadingDetail: false,
  previousPlan: null,
  supersedingPlan: null,

  loadPlans: async (workspaceId) => {
    set({ isLoading: true })
    try {
      const plans = await window.api.planGetAll({ workspaceId })
      set({ plans, isLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load plans:', error)
      set({ isLoading: false })
    }
  },

  setStatusFilter: (filter) => {
    set({ statusFilter: filter })
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query })
  },

  updateStatus: async (planId, status) => {
    try {
      await window.api.planUpdateStatus({ planId, status })
      // Optimistic update for the list
      set((s) => ({
        plans: s.plans.map((p) =>
          p.id === planId ? { ...p, status, updatedAt: new Date().toISOString() } : p
        )
      }))
      // Refresh detail view if this plan is currently selected
      if (get().selectedPlanId === planId) {
        const [plan, history] = await Promise.all([
          window.api.planGetById({ planId }),
          window.api.planGetStatusHistory({ planId })
        ])
        set({ selectedPlan: plan, statusHistory: history })
      }
    } catch (error) {
      rendererLog.error('Failed to update plan status:', error)
    }
  },

  deletePlan: async (planId) => {
    try {
      await window.api.planDelete({ planId })
      set((s) => ({ plans: s.plans.filter((p) => p.id !== planId) }))
    } catch (error) {
      rendererLog.error('Failed to delete plan:', error)
    }
  },

  importPlan: async (planId, workspaceId) => {
    const result = await window.api.planImport({ planId, workspaceId })
    // Update the plan status optimistically
    set((s) => ({
      plans: s.plans.map((p) =>
        p.id === planId
          ? {
              ...p,
              status: 'handed_off' as PlanStatus,
              linkedConversationId: result.conversationId,
              updatedAt: new Date().toISOString()
            }
          : p
      )
    }))
    return result
  },

  selectPlan: async (planId) => {
    set({ selectedPlanId: planId, isLoadingDetail: true })
    try {
      const [plan, history] = await Promise.all([
        window.api.planGetById({ planId }),
        window.api.planGetStatusHistory({ planId })
      ])
      set({
        selectedPlan: plan,
        statusHistory: history,
        isLoadingDetail: false
      })
    } catch (error) {
      rendererLog.error('Failed to load plan detail:', error)
      set({ isLoadingDetail: false })
    }
  },

  clearSelectedPlan: () => {
    set({
      selectedPlanId: null,
      selectedPlan: null,
      statusHistory: [],
      isLoadingDetail: false,
      previousPlan: null,
      supersedingPlan: null
    })
  },

  reset: () =>
    set({
      plans: [],
      isLoading: false,
      statusFilter: 'all',
      searchQuery: '',
      selectedPlanId: null,
      selectedPlan: null,
      statusHistory: [],
      isLoadingDetail: false,
      previousPlan: null,
      supersedingPlan: null
    })
}))

// ── Selector: filtered plans ─────────────────────────────────────────────

export function useFilteredPlans(): PlanRecord[] {
  const { plans, statusFilter, searchQuery } = usePlanStore()
  return plans.filter((p) => matchesStatusFilter(p, statusFilter) && matchesSearch(p, searchQuery))
}

// ── Selector: status counts ──────────────────────────────────────────────

export function usePlanStatusCounts(): Record<PlanStatusFilter, number> {
  const { plans, searchQuery } = usePlanStore()
  const filtered = plans.filter((p) => matchesSearch(p, searchQuery))
  return {
    all: filtered.length,
    saved: filtered.filter((p) => p.status === 'saved').length,
    active: filtered.filter((p) => p.status === 'handed_off' || p.status === 'in_progress').length,
    done: filtered.filter((p) => p.status === 'completed' || p.status === 'archived').length
  }
}

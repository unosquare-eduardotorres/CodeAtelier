/**
 * Preset store — manages LLM preset state for the workspace settings UI.
 *
 * Handles CRUD operations on presets via IPC, tracks workspace default,
 * and provides selectors for preset summaries.
 */

import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { ActionModelConfig, LLMPreset, ModelAction } from '../../../shared/types'

// ── Store interface ─────────────────────────────────────────────────────

interface PresetState {
  presets: LLMPreset[]
  defaultPresetId: string | null
  loading: boolean
  editingPreset: LLMPreset | null

  // Actions
  fetchPresets: (workspaceId: string) => Promise<void>
  createPreset: (
    workspaceId: string,
    name: string,
    actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  ) => Promise<LLMPreset | null>
  updatePreset: (
    presetId: string,
    changes: { name?: string; actionConfig?: Partial<Record<ModelAction, ActionModelConfig>> }
  ) => Promise<boolean>
  deletePreset: (presetId: string) => Promise<boolean>
  setDefault: (workspaceId: string, presetId: string) => Promise<void>
  setEditingPreset: (preset: LLMPreset | null) => void
  reset: () => void
}

// ── Store ───────────────────────────────────────────────────────────────

export const usePresetStore = create<PresetState>((set, _get) => ({
  presets: [],
  defaultPresetId: null,
  loading: false,
  editingPreset: null,

  fetchPresets: async (workspaceId) => {
    set({ loading: true })
    try {
      const presets = (await window.api.getPresets({ workspaceId })) as LLMPreset[]
      // Also fetch workspace settings to get the default preset ID
      const settings = await window.api.getWorkspaceSettings({ workspaceId })
      set({
        presets,
        defaultPresetId: (settings as Record<string, unknown>)?.defaultPresetId as string | null,
        loading: false
      })
    } catch (error) {
      rendererLog.error('Failed to load presets:', error)
      set({ loading: false })
    }
  },

  createPreset: async (workspaceId, name, actionConfig) => {
    try {
      const result = (await window.api.createPreset({
        workspaceId,
        name,
        actionConfig: actionConfig as Record<string, unknown>
      })) as LLMPreset | { error: string }
      if ('error' in result) {
        rendererLog.error('Failed to create preset:', result.error)
        return null
      }
      // Optimistic add
      set((s) => ({ presets: [...s.presets, result] }))
      return result
    } catch (error) {
      rendererLog.error('Failed to create preset:', error)
      return null
    }
  },

  updatePreset: async (presetId, changes) => {
    try {
      const result = (await window.api.updatePreset({
        presetId,
        changes: changes as { name?: string; actionConfig?: Record<string, unknown> }
      })) as LLMPreset | { error: string }
      if ('error' in result) {
        rendererLog.error('Failed to update preset:', result.error)
        return false
      }
      // Optimistic update
      set((s) => ({
        presets: s.presets.map((p) => (p.id === presetId ? result : p))
      }))
      return true
    } catch (error) {
      rendererLog.error('Failed to update preset:', error)
      return false
    }
  },

  deletePreset: async (presetId) => {
    try {
      const result = (await window.api.deletePreset({ presetId })) as
        | { deleted: boolean }
        | { error: string }
      if ('error' in result) {
        rendererLog.error('Failed to delete preset:', result.error)
        return false
      }
      // Optimistic remove
      set((s) => ({
        presets: s.presets.filter((p) => p.id !== presetId),
        defaultPresetId:
          s.defaultPresetId === presetId ? null : s.defaultPresetId
      }))
      return true
    } catch (error) {
      rendererLog.error('Failed to delete preset:', error)
      return false
    }
  },

  setDefault: async (workspaceId, presetId) => {
    try {
      await window.api.setDefaultPreset({ workspaceId, presetId })
      set({ defaultPresetId: presetId })
    } catch (error) {
      rendererLog.error('Failed to set default preset:', error)
    }
  },

  setEditingPreset: (preset) => {
    set({ editingPreset: preset })
  },

  reset: () =>
    set({ presets: [], defaultPresetId: null, loading: false, editingPreset: null })
}))

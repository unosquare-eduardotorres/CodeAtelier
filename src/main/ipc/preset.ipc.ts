/**
 * preset.ipc — IPC handlers for LLM preset management.
 *
 * Provides CRUD on presets, workspace default assignment,
 * and mid-conversation preset switching (with handoff detection).
 */

import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { presetService } from '../services/preset.service'
import { conversationRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import type { ActionModelConfig, ModelAction } from '../../shared/types'

const presetLog = log.scope('preset-ipc')

export function registerPresetIpc(): void {
  // ── preset:get-all — List all presets for a workspace ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_GET_ALL,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      return presetService.getAllPresets(args.workspaceId)
    }
  )

  // ── preset:get-by-id — Fetch a single preset ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_GET_BY_ID,
    (event, args: { presetId: string }) => {
      validateSender(event)
      return presetService.getPreset(args.presetId)
    }
  )

  // ── preset:create — Create a custom preset ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_CREATE,
    (
      event,
      args: {
        workspaceId: string
        name: string
        actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
      }
    ) => {
      validateSender(event)

      // Validate before creating
      const validation = presetService.validatePreset(args.actionConfig)
      if (!validation.valid) {
        return { error: validation.errors[0]?.message ?? 'Invalid preset configuration' }
      }

      const preset = presetService.createPreset(args.workspaceId, args.name, args.actionConfig)
      presetLog.info(`[preset:create] ${preset.id} "${preset.name}" for workspace ${args.workspaceId}`)
      return preset
    }
  )

  // ── preset:update — Update a preset's name or action config ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_UPDATE,
    (
      event,
      args: {
        presetId: string
        changes: {
          name?: string
          actionConfig?: Partial<Record<ModelAction, ActionModelConfig>>
        }
      }
    ) => {
      validateSender(event)

      if (args.changes.actionConfig) {
        const validation = presetService.validatePreset(args.changes.actionConfig)
        if (!validation.valid) {
          return { error: validation.errors[0]?.message ?? 'Invalid preset configuration' }
        }
      }

      const updated = presetService.updatePreset(args.presetId, args.changes)
      if (!updated) return { error: 'Preset not found' }
      presetLog.info(`[preset:update] ${args.presetId}`)
      return updated
    }
  )

  // ── preset:delete — Delete a custom preset ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_DELETE,
    (event, args: { presetId: string }) => {
      validateSender(event)
      const deleted = presetService.deletePreset(args.presetId)
      if (!deleted) return { error: 'Cannot delete built-in presets' }
      presetLog.info(`[preset:delete] ${args.presetId}`)
      return { deleted: true }
    }
  )

  // ── preset:set-default — Set workspace default preset ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_SET_DEFAULT,
    (event, args: { workspaceId: string; presetId: string }) => {
      validateSender(event)
      presetService.setWorkspaceDefault(args.workspaceId, args.presetId)
      presetLog.info(`[preset:set-default] workspace ${args.workspaceId} → preset ${args.presetId}`)
      return { success: true }
    }
  )

  // ── preset:switch-conversation — Switch a conversation's preset ──
  ipcMain.handle(
    IPC_CHANNELS.PRESET_SWITCH,
    (event, args: { conversationId: string; presetId: string }) => {
      validateSender(event)

      const conversation = conversationRepository.findById(args.conversationId)
      if (!conversation) return { error: 'Conversation not found' }

      const newPreset = presetService.getPreset(args.presetId)
      if (!newPreset) return { error: 'Preset not found' }

      // Check if the chat provider is changing (triggers handoff)
      const currentPresetId = conversation.presetId ?? null
      const currentChatProvider = presetService.resolveProvider(currentPresetId, 'da-vinci:plan')
      const newChatProvider = presetService.resolveProvider(args.presetId, 'da-vinci:plan')
      const requiresHandoff = currentChatProvider !== newChatProvider

      // Update the preset on the conversation
      conversationRepository.updatePreset(args.conversationId, args.presetId)

      presetLog.info(
        `[preset:switch] conversation ${args.conversationId} → preset ${args.presetId} (handoff=${requiresHandoff})`
      )

      return {
        success: true,
        requiresHandoff,
        newPreset,
        previousProvider: currentChatProvider,
        newProvider: newChatProvider
      }
    }
  )
}

/**
 * IPC handlers for the Unified Handoff Protocol.
 *
 * Bridges renderer ↔ HandoffService for creating, executing, accepting,
 * rejecting, and querying cross-feature handoffs.
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { handoffService } from '../services/handoff.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString, optionalNumber } from './validate-args'
import type { CreateHandoffParams, HandoffRenderFormat } from '../../shared/handoff-types'
import log from 'electron-log'

const handoffLog = log.scope('handoff-ipc')

/** Extract CreateHandoffParams from validated IPC args. Centralises ~30 fields. */
function parseHandoffParams(
  args: Record<string, unknown>,
  ch: string,
  opts: { includeExpiresAt?: boolean } = {}
): CreateHandoffParams {
  return {
    source: requireString(args, 'source', ch) as CreateHandoffParams['source'],
    target: requireString(args, 'target', ch) as CreateHandoffParams['target'],
    workspaceId: requireString(args, 'workspaceId', ch),
    intent: requireString(args, 'intent', ch),
    originalGoal: requireString(args, 'originalGoal', ch),
    contextSummary: requireString(args, 'contextSummary', ch),

    completedWork: args.completedWork as CreateHandoffParams['completedWork'],
    remainingWork: args.remainingWork as CreateHandoffParams['remainingWork'],
    decisions: args.decisions as CreateHandoffParams['decisions'],
    constraints: args.constraints as CreateHandoffParams['constraints'],
    risks: args.risks as CreateHandoffParams['risks'],
    artifacts: args.artifacts as CreateHandoffParams['artifacts'],
    codeAnchors: args.codeAnchors as CreateHandoffParams['codeAnchors'],

    suggestedTools: args.suggestedTools as CreateHandoffParams['suggestedTools'],
    suggestedSkills: args.suggestedSkills as CreateHandoffParams['suggestedSkills'],
    filesToReadFirst: args.filesToReadFirst as CreateHandoffParams['filesToReadFirst'],
    commandsToRunFirst: args.commandsToRunFirst as CreateHandoffParams['commandsToRunFirst'],

    structuredPlanRef: optionalString(args, 'structuredPlanRef', ch),
    parentHandoffId: optionalString(args, 'parentHandoffId', ch),
    sourceSessionId: optionalString(args, 'sourceSessionId', ch),
    extensions: args.extensions as CreateHandoffParams['extensions'],

    priority: optionalString(args, 'priority', ch) as CreateHandoffParams['priority'],
    createdBy: optionalString(args, 'createdBy', ch) as CreateHandoffParams['createdBy'],
    ...(opts.includeExpiresAt ? { expiresAt: optionalString(args, 'expiresAt', ch) } : {}),
  }
}

export function registerHandoffIpc(): void {
  // ── handoff:create — Create + persist a handoff envelope ──────────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_CREATE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_CREATE
      const args = requireObject(rawArgs, ch)

      const params = parseHandoffParams(args, ch, { includeExpiresAt: true })

      const envelope = handoffService.createEnvelope(params)
      const record = handoffService.persist(envelope)
      return record
    }
  )

  // ── handoff:execute — Create + persist + resolve target action ────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_EXECUTE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_EXECUTE
      const args = requireObject(rawArgs, ch)

      const params = parseHandoffParams(args, ch, { includeExpiresAt: true })

      const envelope = handoffService.createEnvelope(params)
      const { record, action } = handoffService.executeHandoff(envelope)
      return { record, action }
    }
  )

  // ── handoff:accept — Mark handoff accepted + link target session ──
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_ACCEPT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_ACCEPT
      const args = requireObject(rawArgs, ch)
      const handoffId = requireString(args, 'handoffId', ch)
      const targetSessionId = requireString(args, 'targetSessionId', ch)

      try {
        handoffService.accept(handoffId, targetSessionId)
        return { success: true }
      } catch (err) {
        handoffLog.warn(`[handoff:accept] Failed: ${(err as Error).message}`)
        return { success: false, error: (err as Error).message }
      }
    }
  )

  // ── handoff:reject — Mark handoff rejected with reason ────────────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_REJECT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_REJECT
      const args = requireObject(rawArgs, ch)
      const handoffId = requireString(args, 'handoffId', ch)
      const reason = requireString(args, 'reason', ch)

      try {
        handoffService.reject(handoffId, reason)
        return { success: true }
      } catch (err) {
        handoffLog.warn(`[handoff:reject] Failed: ${(err as Error).message}`)
        return { success: false, error: (err as Error).message }
      }
    }
  )

  // ── handoff:getHistory — List handoffs for workspace ──────────────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_GET_HISTORY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_GET_HISTORY
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const limit = optionalNumber(args, 'limit', ch) ?? 50

      // Expire stale handoffs on query
      handoffService.expireStale(workspaceId)

      return handoffService.getHistory(workspaceId, limit)
    }
  )

  // ── handoff:getChain — Get lineage chain for a handoff ────────────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_GET_CHAIN,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_GET_CHAIN
      const args = requireObject(rawArgs, ch)
      const handoffId = requireString(args, 'handoffId', ch)

      return handoffService.getChain(handoffId)
    }
  )

  // ── handoff:preview — Generate envelope preview (no persist) ──────
  ipcMain.handle(
    IPC_CHANNELS.HANDOFF_PREVIEW,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.HANDOFF_PREVIEW
      const args = requireObject(rawArgs, ch)

      const params = parseHandoffParams(args, ch)

      const format = (optionalString(args, 'format', ch) ?? 'standard') as HandoffRenderFormat

      return handoffService.preview(params, format)
    }
  )

  handoffLog.info('[handoff-ipc] ✓ Registered 7 handoff IPC handlers')
}

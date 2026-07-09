/**
 * Snapshot Model Resolver — reads frozen model config from conversation snapshots.
 *
 * Consumers call resolveModelFromSnapshot() instead of modelConfigService.getModel().
 * If the conversation has a snapshot, it returns the frozen model. Otherwise, falls
 * back to live resolution via modelConfigService.
 *
 * This ensures:
 * - Cost attribution matches the model that was active at conversation creation
 * - Recovery restarts don't flip providers
 * - Settings changes don't affect existing conversations
 */

import type { ConversationModelSnapshot, ModelAction, ResolvedAssignment } from '../../shared/types'
import { conversationRepository, blueprintRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'

/**
 * Resolve the model for a conversation, preferring the frozen snapshot.
 *
 * Falls back to live resolution when:
 * - conversationId is null (e.g., blueprint synthetic IDs)
 * - conversation has no snapshot (legacy conversations, pre-migration 111)
 * - snapshot doesn't cover the requested mode
 */
/**
 * Regex matching blueprint synthetic conversation IDs.
 * Format: `blueprint-{phase}-{blueprintId}-{timestamp}`
 * Groups: [1] = phase, [2] = blueprintId
 */
export const BLUEPRINT_CONV_RE = /^blueprint-(specify|clarify|plan|tasks|review|build|verify)-(.+)-\d+$/

export function resolveModelFromSnapshot(
  conversationId: string | null,
  workspacePath: string,
  modelAction: ModelAction,
  isBuildMode: boolean
): string {
  if (!conversationId) {
    return modelConfigService.getModel(workspacePath, modelAction)
  }

  // G6: Blueprint synthetic IDs — read frozen snapshot from blueprint.settings_json
  const bpMatch = BLUEPRINT_CONV_RE.exec(conversationId)
  if (bpMatch) {
    const [, phase, blueprintId] = bpMatch
    try {
      const bp = blueprintRepository.findById(blueprintId)
      const snap = bp?.settingsJson?.modelSnapshot as Record<string, ResolvedAssignment> | undefined
      if (snap?.[phase]?.modelId) return snap[phase].modelId
    } catch {
      // Non-fatal — fall through to live resolution for legacy blueprints
    }
    return modelConfigService.getModel(workspacePath, modelAction)
  }

  // Regular conversations — read snapshot from conversation.model_config_json
  try {
    const conversation = conversationRepository.findById(conversationId)
    const snapshot = conversation?.modelConfigSnapshot
    if (snapshot) {
      return resolveFromSnapshot(snapshot, isBuildMode, modelAction)
    }
  } catch {
    // Non-fatal — fall through to live resolution
  }

  return modelConfigService.getModel(workspacePath, modelAction)
}

/**
 * Extract the model ID from a snapshot based on the mode and action.
 *
 * Background actions (haiku, memoryFeed, activation) use the background assignment.
 * Build mode uses the build assignment.
 * Everything else uses the plan assignment.
 */
function resolveFromSnapshot(
  snapshot: ConversationModelSnapshot,
  isBuildMode: boolean,
  modelAction: ModelAction
): string {
  // Background task actions always use the background assignment
  const backgroundActions: ModelAction[] = ['haiku', 'memoryFeed', 'activation']
  if (backgroundActions.includes(modelAction)) {
    return snapshot.background.modelId
  }

  // Build mode → build assignment, plan mode → plan assignment
  return isBuildMode ? snapshot.build.modelId : snapshot.plan.modelId
}

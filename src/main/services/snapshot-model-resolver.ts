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

import type {
  ConversationModelSnapshot,
  LLMProvider,
  ModelAction,
  ResolvedAssignment
} from '../../shared/types'
import {
  conversationRepository,
  blueprintRepository,
  workspaceRepository
} from '../db/repositories'
import { modelConfigService, resolveAssignment, buildResolveOpts } from './model-config.service'
import { resolveModelAction } from '../../shared/constants'
import type { AgentRole } from '../../shared/types'
import { decryptSettingsKey } from '../ipc/encrypt-settings-keys'
import log from 'electron-log'

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
 * Format (A1): `blueprint-{phase}-{blueprintId}-{task}[-gN]` — the trailing
 * timestamp was dropped when identity became retry-stable, and `-gN` is the
 * resume-permit generation. Both new shapes AND the legacy
 * `-<timestamp>` shape must match: usage rows and conversation ids written by
 * older builds are still read by Phase 0 queries and crash recovery.
 * Groups: [1] = phase, [2] = blueprintId
 */
export const BLUEPRINT_CONV_RE =
  /^blueprint-(specify|clarify|plan|tasks|code-review|review|build|verify)-([0-9a-f]{32})(?:-([A-Za-z]+\d+))?(?:-g\d+)?(?:-\d+)?$/

/**
 * ModelAction → key in the blueprint's frozen modelSnapshot.
 *
 * Keying on the action rather than the conversation-id phase keeps the model and
 * the PROVIDER agreeing. The escalation ladder re-runs a build task under
 * `blueprint:lead-review` while keeping a `blueprint-build-...` conversation id:
 * keying on the id would hand it the build assignment's model (e.g. glm-5.3)
 * while the adapter resolved lead-review's provider (claude), and the CLI would
 * reject the model.
 *
 * `leadReview` / `peerReview` were MISSING here until 2026-09-07, and their
 * absence was not benign: with no key, the provider resolved to `null` and fell
 * back to the workspace default while the model still resolved from the `build`
 * entry, so on a GLM-build blueprint every escalation rung was dispatched to the
 * Claude CLI carrying `model: glm-5.3`. Blueprints created before that date have
 * no frozen entry under these keys — `blueprintSnapshotAssignment` falls back to
 * the live workspace binding for the same action, which keeps provider and model
 * agreeing for them too.
 */
const ACTION_SNAPSHOT_KEY: Record<string, string> = {
  'blueprint:specify': 'specify',
  'blueprint:clarify': 'clarify',
  'blueprint:plan': 'plan',
  'blueprint:tasks': 'tasks',
  'blueprint:review': 'review',
  'blueprint:build': 'build',
  'blueprint:code-review': 'codeReview',
  'blueprint:lead-review': 'leadReview',
  'blueprint:peer-review': 'peerReview',
  'blueprint:verify': 'verify'
}

/**
 * The frozen assignment for a blueprint phase, by blueprint id and model action.
 * Exported so role adapters can resolve their PROVIDER from the same snapshot
 * entry the model comes from — see BlueprintBaseAdapter.getLlmProvider().
 */
export function blueprintSnapshotAssignment(
  blueprintId: string,
  modelAction: ModelAction
): ResolvedAssignment | null {
  try {
    const bp = blueprintRepository.findById(blueprintId)
    if (!bp) return null

    const key = ACTION_SNAPSHOT_KEY[modelAction]
    if (key) {
      const snap = bp.settingsJson?.modelSnapshot as Record<string, ResolvedAssignment> | undefined
      const frozen = snap?.[key]
      if (frozen) return frozen
    }

    // No frozen entry for this action. Resolve the LIVE workspace binding rather
    // than returning null: null used to send provider and model down two
    // different fallbacks (workspace default provider vs per-action model
    // routing), which is exactly how they came to disagree. One assignment for
    // one action means they cannot.
    //
    // Reproducibility is only weakened where it never existed — these are the
    // actions the snapshot does not cover (legacy blueprints predating a key, or
    // a non-blueprint action reaching here).
    return resolveAssignment({ action: modelAction, ...buildResolveOpts(bp.workspaceId) })
  } catch {
    return null
  }
}

/**
 * The `ModelAction` an adapter actually routes on.
 *
 * SINGLE SOURCE OF TRUTH: provider resolution reads the adapter's own action
 * (`BlueprintBaseAdapter.getLlmProvider()`), so model resolution must read the
 * same one or the two describe different routing entries. Prefer what the
 * adapter declares; fall back to the role-derived action for every adapter that
 * declares nothing, which is all of them outside the blueprint pipeline.
 */
export function resolveAdapterModelAction(
  adapter: { role: AgentRole; getUsageModelAction?(): ModelAction | undefined },
  isBuildMode: boolean
): ModelAction {
  return adapter.getUsageModelAction?.() ?? resolveModelAction(adapter.role, isBuildMode)
}

/**
 * The frozen assignment for a blueprint synthetic conversation ID, or null when
 * the ID is not a blueprint ID or the blueprint carries no snapshot.
 *
 * BP-MODEL-BLEED: this used to be inlined in resolveModelFromSnapshot only, so
 * the OpenCode PROVIDER resolver never consulted the snapshot at all — a GLM
 * build binding resolved its model id from the snapshot but its provider from
 * the workspace default, and every build task silently ran on Anthropic.
 */
function blueprintAssignment(
  conversationId: string,
  modelAction: ModelAction
): ResolvedAssignment | null {
  const match = BLUEPRINT_CONV_RE.exec(conversationId)
  if (!match) return null
  const [, , blueprintId] = match
  return blueprintSnapshotAssignment(blueprintId, modelAction)
}

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
  //
  // The `getModel` fallback below is NOT the "no frozen entry for this action"
  // path — `blueprintSnapshotAssignment` handles that itself by resolving the
  // live workspace binding, so it returns an assignment for every action a real
  // blueprint can ask about. What is left is narrow and exceptional: the
  // blueprint row is missing, or the repository threw. Keeping it means a
  // deleted-mid-run blueprint degrades to live resolution instead of crashing
  // the phase; it is deliberately not a provider/model-agreement path, because
  // by the time we are here there is no snapshot to agree with.
  if (BLUEPRINT_CONV_RE.test(conversationId)) {
    const assignment = blueprintAssignment(conversationId, modelAction)
    if (assignment?.modelId) return assignment.modelId
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

// ── OpenCode provider resolution from snapshot ────────────────────────

export interface OpenCodeProviderConfig {
  providerId: string
  modelId: string
  /** Used VERBATIM for cloud/proxied providers — the config writer appends nothing. */
  baseUrl: string | undefined
  apiKey: string | undefined
  /** GLM-2: Context limit to declare for providers absent from models.dev. */
  contextLimit?: number
  /** GLM-2: Output limit to declare alongside `contextLimit`. */
  outputLimit?: number
  /** GLM-3: Housekeeping model within this provider; `''` disables housekeeping. */
  smallModelId?: string | null
}

/**
 * Resolve OpenCode provider configuration from a conversation's frozen snapshot.
 *
 * Provider identity (providerId + modelId) comes from the snapshot to prevent
 * config bleed between chats. Infrastructure settings (baseUrl, apiKey) always
 * come from live workspace settings — they're connection details, not identity.
 *
 * Falls back to live resolution via modelConfigService.getOpenCodeConfig() when:
 * - conversationId is null
 * - conversation has no snapshot (legacy conversations, pre-migration 111)
 *
 * GLM-6: `providerOverride` carries an explicit per-run provider choice (Grill /
 * Council / Audit toggles). It applies to the fallback path only — snapshot-backed
 * conversations keep their frozen identity. Those toggle-driven flows never have a
 * snapshot, so without it they resolved to the workspace default provider.
 */
export function resolveOpenCodeProviderFromSnapshot(
  conversationId: string | null,
  workspacePath: string,
  isBuildMode: boolean,
  providerOverride?: LLMProvider
): OpenCodeProviderConfig {
  const fallback = (): OpenCodeProviderConfig => {
    const config = modelConfigService.getOpenCodeConfig(workspacePath, providerOverride)
    return {
      providerId: config.openCodeProvider,
      modelId: config.openCodeModel,
      baseUrl: config.openCodeBaseUrl,
      apiKey: config.openCodeApiKey,
      contextLimit: config.openCodeContextLimit,
      outputLimit: config.openCodeOutputLimit,
      smallModelId: config.openCodeSmallModel
    }
  }

  if (!conversationId) {
    return fallback()
  }

  // Blueprint synthetic IDs never have conversation rows. Provider identity
  // reaches this path as `providerOverride`, which BlueprintBaseAdapter derives
  // from the same frozen snapshot entry the model comes from — so the fallback
  // is already snapshot-driven for blueprints.
  if (BLUEPRINT_CONV_RE.test(conversationId)) {
    return fallback()
  }

  try {
    const conversation = conversationRepository.findById(conversationId)
    const snapshot = conversation?.modelConfigSnapshot
    if (!snapshot) {
      log.warn(
        `[snapshot-resolver] No snapshot for conversation ${conversationId} — using live OpenCode config`
      )
      return fallback()
    }

    const assignment = isBuildMode ? snapshot.build : snapshot.plan
    return mapAssignmentToOpenCodeConfig(assignment, workspacePath)
  } catch {
    // Non-fatal — fall through to live resolution
    return fallback()
  }
}

/**
 * Map a ResolvedAssignment to OpenCode provider config.
 * Provider identity comes from the assignment; infrastructure from workspace.
 */
function mapAssignmentToOpenCodeConfig(
  assignment: ResolvedAssignment,
  workspacePath: string
): OpenCodeProviderConfig {
  if (assignment.provider === 'glm') {
    // GLM-5: Identity from the snapshot, connection details from live settings.
    // Without this branch a GLM assignment fell through to the `anthropic` provider
    // below and was written into opencode.json as Anthropic.
    const glm = modelConfigService.getGlmConfig(workspacePath)
    return {
      providerId: 'glm',
      modelId: assignment.modelId,
      baseUrl: glm.baseUrl,
      apiKey: glm.apiKey,
      contextLimit: glm.contextLimit,
      outputLimit: glm.outputLimit,
      smallModelId: glm.smallModelId
    }
  }

  if (assignment.provider === 'local-llm') {
    // Local LLM — derive providerId from localBackend, infrastructure from local config
    const providerId = assignment.localBackend === 'omlx' ? 'omlx' : 'ollama'
    const localConfig = modelConfigService.getLocalLLMConfig(workspacePath)
    return {
      providerId,
      modelId: assignment.modelId,
      baseUrl: modelConfigService.getLocalBaseUrl(localConfig),
      apiKey: localConfig.localApiKey
    }
  }

  // Claude / other — use 'anthropic' provider, infrastructure from workspace settings
  const settings = workspaceRepository.getSettingsByPath(workspacePath)
  return {
    providerId: 'anthropic',
    modelId: assignment.modelId,
    baseUrl: settings?.openCodeBaseUrl as string | undefined,
    apiKey: decryptSettingsKey(
      settings?.openCodeApiKey as string | undefined,
      !!settings?.openCodeApiKeyEncrypted
    )
  }
}

/**
 * ProjectSpecialistRoleAdapter — drives AgentSessionService for a single
 * workspace's Project Specialist.
 *
 * Key differences vs. DaVinciRoleAdapter:
 *   - Bound to exactly one workspace (+ its Project Specialist row).
 *   - Prompt identity comes from specialists.prompt (LLM-tailored by the
 *     builder), not from the DA_VINCI_IDENTITY_PROMPT default.
 *   - No persona overlay (specialists ARE the "persona").
 *   - No specialist-ready swap signal (specialists are the target, not
 *     the announcer).
 * Everything else (MCP mounting, allow/disallow lists, memory persistence,
 * intent detection) is identical to DaVinciRoleAdapter.
 */

import type {
  ConversationMode,
  ModelAction
} from '../../../shared/types'
import {
  RECOMMENDED_LOCAL_MODELS
} from '../../../shared/constants'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { getDatabase } from '../../db/index'
import {
  workspaceRepository
} from '../../db/repositories'
import { appendMcpToolGuidance, buildConditionalPrefix, buildModeContextPrefix } from '../prompt-assembly-helpers'
import {
  UNIFIED_MODE_SECTION,
  TONE_STYLE_DIRECTIVES,
  TOOL_PRIORITY_DIRECTIVE
} from '../default-prompts'
import { modelConfigService } from '../model-config.service'
import { promptBuilder } from '../prompt-builder'
import { resolveContextTier } from '../context-management'
import { SystemPromptCache } from '../system-prompt-cache'
import { BaseRoleAdapter } from './base.adapter'

interface SpecialistSnapshot {
  id: string
  agentId: string
  displayName: string
  prompt: string
  buildStatus: string
}

export class ProjectSpecialistRoleAdapter extends BaseRoleAdapter {
  readonly role = 'project-specialist' as const
  readonly agentId: string

  private readonly workspaceId: string
  private snapshot: SpecialistSnapshot | null = null

  /** Pattern 7: Extracted system-prompt snapshot cache. */
  private readonly promptCache = new SystemPromptCache()

  constructor(params: { workspaceId: string; agentId?: string }) {
    super()
    this.workspaceId = params.workspaceId
    this.agentId = params.agentId ?? `workspace-specialist-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.loadSnapshot()

    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)

    // Pattern 6 / Strategy Λ: Lock MCP flags at session start
    this.lockMcpFlags()
  }

  override refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void {
    // Re-read the snapshot — the builder may have updated prompt between sends
    // (skills toggled, prompt rebuilt). Also refresh workspace feature flags.
    this.loadSnapshot()
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)
  }

  override onConversationSwitch(_conversationId: string): void {
    // Drop the cached system-prompt — the next buildPrompts() will rebuild
    // with the new conversation context (and re-read CLAUDE.md if it changed).
    this.invalidateSnapshot()
  }

  /**
   * Drop the cached system-prompt assembly. Called by onConversationSwitch
   * and exposed publicly so the session layer can force a rebuild on
   * mode switches or other lifecycle events.
   */
  invalidateSnapshot(): void {
    this.promptCache.invalidate()
    this.invalidateToneCache()
  }

  buildPrompts(ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.snapshot) this.loadSnapshot()
    if (!this.snapshot) {
      throw new Error(
        `No Project Specialist row for workspace ${this.workspaceId} — has migration 66 run?`
      )
    }

    if (this.snapshot.buildStatus === 'pending' || this.snapshot.buildStatus === 'building') {
      const msg = `Your Project Specialist is still being prepared. Please try again in a moment.`
      return { systemPrompt: msg, effectiveMessage: ctx.message }
    }

    if (this.snapshot.buildStatus === 'failed') {
      const msg = `Project Specialist build failed. Use the ⚙️ Specialist panel to rebuild.`
      return { systemPrompt: msg, effectiveMessage: ctx.message }
    }

    // Pattern 5: Centralized communication tone resolution
    const communicationTone = this.resolveCommunicationTone(
      ctx.conversationId,
      this.workspaceId,
      ctx.turnCount
    )

    // Local LLM: condensed prompt — skip skills, memory, caching strategies.
    // S5: Inject plan-focused directive with context tier for local plan mode.
    if (modelConfigService.isLocalProvider(ctx.workspacePath)) {
      const localConfig = modelConfigService.getLocalLLMConfig(ctx.workspacePath)
      // F2: Resolve actual context window from RECOMMENDED_LOCAL_MODELS (mirrors DaVinci adapter)
      const match = RECOMMENDED_LOCAL_MODELS.find(
        (m) => m.ollamaId === localConfig.localModel || m.omlxId === localConfig.localModel
      )
      const contextTier = resolveContextTier(match?.contextWindow ?? 32_768)
      const systemPrompt = promptBuilder.buildLocalPrompt({
        role: 'da-vinci',
        mode: ctx.mode,
        workspacePath: ctx.workspacePath,
        budgetTier: 'minimal',
        contextTier,
        communicationTone
      })
      return { systemPrompt, effectiveMessage: ctx.message }
    }

    // ── System-prompt assembly with snapshot cache ─────────────────
    // Pattern 1: Centralized model resolution
    const isBuildMode = ctx.mode === 'build' || ctx.mode === 'danger'
    const resolvedModel = this.resolveModel(ctx.workspacePath, `${this.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction)

    // Pattern 7: SystemPromptCache for snapshot reuse
    const cacheKeys = {
      mode: ctx.mode,
      conversationId: ctx.conversationId,
      tone: communicationTone,
      model: resolvedModel ?? null
    }

    let systemPrompt: string
    if (this.promptCache.isValid(cacheKeys, ctx.turnCount)) {
      systemPrompt = this.promptCache.get()!
    } else {
      const modeSection = UNIFIED_MODE_SECTION
      const claudeMdLayer = ctx.workspacePath
        ? promptBuilder.buildClaudeMdLayer(ctx.workspacePath, ctx.mode)
        : ''
      const layers = [modeSection, this.snapshot.prompt]
      const baselineSkills = promptBuilder.skills.buildBaselineSkillsLayer()
      if (baselineSkills) layers.push(baselineSkills)
      if (claudeMdLayer) layers.push(claudeMdLayer)
      // Append communication tone overlay for non-default tones.
      if (communicationTone !== 'default') {
        layers.push(`## Communication Tone Override\n${TONE_STYLE_DIRECTIVES[communicationTone]}`)
      }
      const basePrompt = layers.join('\n\n')
      // Strategy Λ: Use locked flags so MCP guidance matches the mounted tool set.
      const mcpFlags = this.getLockedMcpFlags()
      // Resolve which external MCPs are active — drives prompt guidance injection
      const externalMcpActive = this.resolveExternalMcpActive(
        ctx.workspaceId ?? this.workspaceId,
        ctx.conversationId
      )
      systemPrompt = appendMcpToolGuidance(basePrompt, ctx.turnCount, {
        ...mcpFlags,
        externalMcpActive
      }, resolvedModel)

      // Ensure Tool Priority directive is present
      if (!systemPrompt.includes('## Tool Priority')) {
        systemPrompt += '\n' + TOOL_PRIORITY_DIRECTIVE
      }
      this.promptCache.set(systemPrompt, cacheKeys)
    }

    // Pattern 8: Centralized mode-context prefix
    let effectiveMessage = `${buildModeContextPrefix(ctx.mode, resolvedModel)}\n\n${ctx.message}`

    // User-turn prefix (ASK + MEMORY + IMAGE + DIRECT + plan reminder).
    const conditionalPrefix = buildConditionalPrefix({
      message: ctx.message,
      hasImages: ctx.hasImages,
      mode: ctx.mode,
      turnCount: ctx.turnCount,
      model: resolvedModel
    })
    if (conditionalPrefix) {
      effectiveMessage = `${conditionalPrefix}\n\n---\n\n${effectiveMessage}`
    }

    return { systemPrompt, effectiveMessage }
  }

  protected override resolveWorkspaceId(): string | null {
    return this.workspaceId
  }

  override onSessionStop(): void {
    this.snapshot = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
    this.githubConfigured = false
    this.unlockMcpFlags()
    this.invalidateSnapshot()
  }

  /** Refresh the cached specialist row from the DB. */
  private loadSnapshot(): void {
    try {
      const db = getDatabase()
      const row = db
        .prepare(
          `SELECT id, agent_id, display_name, prompt, build_status
             FROM specialists WHERE workspace_id = ?`
        )
        .get(this.workspaceId) as
        | {
            id: string
            agent_id: string
            display_name: string
            prompt: string
            build_status: string
          }
        | undefined
      if (!row) {
        this.snapshot = null
        return
      }
      this.snapshot = {
        id: row.id,
        agentId: row.agent_id,
        displayName: row.display_name,
        prompt: row.prompt ?? '',
        buildStatus: row.build_status
      }
    } catch (err) {
      this.log.warn('Failed to load Project Specialist snapshot:', err)
      this.snapshot = null
    }
  }

  /** The workspace this adapter is bound to. */
  getWorkspaceId(): string {
    return this.workspaceId
  }

  /** For debugging / UI: who is this adapter bound to? */
  getSpecialistId(): string | null {
    return this.snapshot?.id ?? null
  }

  getDisplayName(): string | null {
    return this.snapshot?.displayName ?? null
  }

  getBuildStatus(): string | null {
    return this.snapshot?.buildStatus ?? null
  }

  getMode(): ConversationMode {
    return 'plan'
  }

}

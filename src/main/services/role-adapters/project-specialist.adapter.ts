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
  AgentIntent,
  CommunicationTone,
  ConversationMode,
  MemoryType,
  ModelAction
} from '../../../shared/types'
import {
  EXTERNAL_MCP_INTEGRATIONS,
  LOCAL_MCP_INTEGRATIONS,
  RECOMMENDED_LOCAL_MODELS
} from '../../../shared/constants'
import type {
  AdapterIntentContext,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AgentRoleAdapter,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'
import { getDatabase } from '../../db/index'
import { chatAgentLogger } from '../../logger'
import {
  conversationRepository,
  memoryRepository,
  workspaceRepository
} from '../../db/repositories'
import { githubService } from '../github.service'
import { intentDetector } from '../intent-detector'
import { appendMcpToolGuidance, buildConditionalPrefix } from '../prompt-assembly-helpers'
import { buildWorkspaceMcpConfig } from '../workspace-mcp-config'
import {
  MODE_CONTEXT_SECTIONS,
  MODE_CONTEXT_SECTIONS_LEAN,
  UNIFIED_MODE_SECTION,
  TONE_STYLE_DIRECTIVES
} from '../default-prompts'
import { resolvePromptVerbosity } from '../../../shared/constants'
import { modelConfigService } from '../model-config.service'
import { promptBuilder } from '../prompt-builder'
import { resolveContextTier } from '../context-management'

interface SpecialistSnapshot {
  id: string
  agentId: string
  displayName: string
  prompt: string
  buildStatus: string
}

export class ProjectSpecialistRoleAdapter implements AgentRoleAdapter {
  readonly role = 'project-specialist' as const
  readonly agentId: string

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private snapshot: SpecialistSnapshot | null = null

  /** Feature flags refreshed from workspace settings each send(). */
  private repomapEnabled = true
  private semanticSearchEnabled = true
  private githubConfigured = false

  /**
   * Strategy Λ: Locked MCP feature flags — snapshotted at onSessionStart()
   * and used for buildMcpConfig() + MCP guidance in the system prompt.
   * Prevents mid-session tool set drift that would break prompt cache prefix.
   */
  private lockedMcpFlags: {
    repomapEnabled: boolean
    semanticSearchEnabled: boolean
    githubConfigured: boolean
  } | null = null

  /**
   * Cached system-prompt assembly (mode + identity + CLAUDE.md + MCP guidance).
   * Mirrors DaVinciPromptAssembler: rebuild on turn 1, reuse on turns 2+ when
   * (conversationId, mode) match. Invalidated on conversation switch, mode
   * switch, and session stop.
   */
  private systemPromptSnapshot: string | null = null
  private systemPromptSnapshotMode: ConversationMode | null = null
  private systemPromptSnapshotConversationId: string | null = null
  private systemPromptSnapshotTone: CommunicationTone | null = null
  private systemPromptSnapshotModel: string | null = null

  /** Cached communication tone to avoid DB queries on every turn */
  private cachedTone: CommunicationTone | null = null
  private cachedToneConversationId: string | null = null

  constructor(params: { workspaceId: string; agentId?: string }) {
    this.workspaceId = params.workspaceId
    this.agentId = params.agentId ?? `workspace-specialist-${params.workspaceId}`
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.loadSnapshot()
    this.refreshWorkspaceFlags(ctx.workspaceId)

    // Strategy Λ: Lock MCP flags at session start for tool set stability.
    this.lockedMcpFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }
  }

  refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void {
    // Re-read the snapshot — the builder may have updated prompt between sends
    // (skills toggled, prompt rebuilt). Also refresh workspace feature flags.
    this.loadSnapshot()
    this.refreshWorkspaceFlags(ctx.workspaceId)
  }

  onConversationSwitch(_conversationId: string): void {
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
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null
    this.systemPromptSnapshotTone = null
    this.systemPromptSnapshotModel = null
    this.cachedTone = null
    this.cachedToneConversationId = null
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

    // ── Resolve effective communication tone (cached to skip DB queries on turns 2+) ──
    // Resolution chain: conversation override → workspace default → 'default'
    // Tone rarely changes mid-session — reuse cached value when conversation hasn't changed.
    let communicationTone: CommunicationTone
    if (
      this.cachedTone &&
      this.cachedToneConversationId === ctx.conversationId &&
      ctx.turnCount > 1
    ) {
      communicationTone = this.cachedTone
    } else {
      communicationTone = 'default'
      try {
        if (ctx.conversationId) {
          const conv = conversationRepository.findById(ctx.conversationId)
          if (conv?.communicationTone) {
            communicationTone = conv.communicationTone
          }
        }
        if (communicationTone === 'default') {
          const wsSettings = workspaceRepository.getSettings(this.workspaceId)
          const wsTone = wsSettings.communicationTone as CommunicationTone | undefined
          if (wsTone && wsTone !== 'default') communicationTone = wsTone
        }
      } catch {
        /* non-fatal — fallback to default tone */
      }
      this.cachedTone = communicationTone
      this.cachedToneConversationId = ctx.conversationId
    }

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
    // Layering mirrors DaVinci:
    //   [MODE SECTION] → [specialists.prompt — identity] → [CLAUDE.md layer] →
    //   [tone overlay (non-default only)] → [MCP guidance turn 1 only]
    //
    // Always rebuild on turn 1 to pick up fresh CLAUDE.md and prompt edits.
    // On turns 2+ reuse when (conversationId, mode, tone) match the cached snapshot.
    const isBuildMode = ctx.mode === 'build' || ctx.mode === 'danger'
    const resolvedModel = modelConfigService.getModel(ctx.workspacePath, `${this.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction)
    const cacheValid =
      ctx.turnCount > 1 &&
      this.systemPromptSnapshot !== null &&
      this.systemPromptSnapshotMode === ctx.mode &&
      this.systemPromptSnapshotConversationId === ctx.conversationId &&
      this.systemPromptSnapshotTone === communicationTone &&
      this.systemPromptSnapshotModel === (resolvedModel ?? null)

    let systemPrompt: string
    if (cacheValid) {
      systemPrompt = this.systemPromptSnapshot as string
    } else {
      const modeSection = UNIFIED_MODE_SECTION
      const claudeMdLayer = ctx.workspacePath
        ? promptBuilder.buildClaudeMdLayer(ctx.workspacePath, ctx.mode)
        : ''
      const layers = [modeSection, this.snapshot.prompt]
      if (claudeMdLayer) layers.push(claudeMdLayer)
      // Append communication tone overlay for non-default tones.
      // Placed after the specialist's own prompt so it takes precedence.
      if (communicationTone !== 'default') {
        layers.push(`## Communication Tone Override\n${TONE_STYLE_DIRECTIVES[communicationTone]}`)
      }
      const basePrompt = layers.join('\n\n')
      // Strategy Λ: Use locked flags so MCP guidance matches the mounted tool set.
      const mcpFlags = this.lockedMcpFlags ?? {
        repomapEnabled: this.repomapEnabled,
        semanticSearchEnabled: this.semanticSearchEnabled,
        githubConfigured: this.githubConfigured
      }
      // Resolve which external MCPs are active — drives prompt guidance injection
      const externalMcpActive = this.resolveExternalMcpActive(
        ctx.workspaceId ?? this.workspaceId,
        ctx.conversationId
      )
      systemPrompt = appendMcpToolGuidance(basePrompt, ctx.turnCount, {
        ...mcpFlags,
        externalMcpActive
      }, resolvedModel)
      this.systemPromptSnapshot = systemPrompt
      this.systemPromptSnapshotMode = ctx.mode
      this.systemPromptSnapshotConversationId = ctx.conversationId
      this.systemPromptSnapshotTone = communicationTone
      this.systemPromptSnapshotModel = resolvedModel ?? null
    }

    // Inject <mode-context> block per-message (same as DaVinci assembler).
    const verbosity = resolvePromptVerbosity(resolvedModel ?? '')
    const modeSections = verbosity === 'lean' ? MODE_CONTEXT_SECTIONS_LEAN : MODE_CONTEXT_SECTIONS
    const modeBlock = modeSections[ctx.mode] ?? modeSections.plan
    let effectiveMessage = `<mode-context>\n${modeBlock.trim()}\n</mode-context>\n\n${ctx.message}`

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

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    if (!this.snapshot) this.loadSnapshot()

    // Strategy Λ: Use locked flags for stable tool set across all turns.
    // Exception: externalMcpActive is ALWAYS read fresh (per-message toggling).
    const baseMcpFlags = this.lockedMcpFlags ?? {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }

    // Resolve external MCP active states via shared helper (same logic as buildPrompts)
    const externalMcpActive = this.resolveExternalMcpActive(ctx.workspaceId, ctx.conversationId)

    // Resolve per-chat local MCP active state from conversation overrides
    const localMcpActive: Record<string, boolean> = {}
    try {
      const conv = ctx.conversationId ? conversationRepository.findById(ctx.conversationId) : null
      const chatOverrides = conv?.mcpOverrides ?? {}
      for (const lm of LOCAL_MCP_INTEGRATIONS) {
        localMcpActive[lm.id] = chatOverrides[lm.id] !== false
      }
    } catch (err) {
      this.log.error('[adapter:local-mcp] Failed to resolve local MCP overrides:', err)
    }

    return buildWorkspaceMcpConfig({
      mode: ctx.mode,
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      featureFlags: { ...baseMcpFlags, externalMcpActive, localMcpActive },
      controlCallbacks: ctx.controlCallbacks,
      isLocalProvider: modelConfigService.isLocalProvider(ctx.workspacePath),
      contextTier: ctx.contextTier
    })
  }

  buildControlCallbacks(params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    return {
      onPlan: () => {
        /* wrapped by session */
      },
      onAskUser: () => {
        /* wrapped by session */
      },
      onMemory: (memory: { type: MemoryType; title: string; content: string }) => {
        // Persist immediately — identical to DaVinciRoleAdapter. The workspace
        // is already known via this.workspaceId, so no need to scan all workspaces.
        try {
          const workspace = workspaceRepository.findById(this.workspaceId)
          const memWorkspaceId =
            memory.type === 'user' || memory.type === 'feedback' ? null : (workspace?.id ?? null)
          const mem = memoryRepository.createIfNotDuplicate({
            workspaceId: memWorkspaceId,
            type: memory.type,
            title: memory.title,
            content: memory.content,
            tags: [],
            sourceConversationId: params.conversationId ?? undefined,
            sourceAgentId: this.agentId,
            importance: 5
          })
          if (mem) {
            this.log.info(`[specialist] Memory created: [${memory.type}] ${memory.title}`)
          } else {
            this.log.info(
              `[specialist] Memory skipped (duplicate): [${memory.type}] ${memory.title}`
            )
          }
        } catch (err) {
          this.log.warn('[specialist] Failed to persist tool-emitted memory:', err)
        }
      }
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
    // Same intent-detection path as DaVinci: grill / askUser / plan are surfaced
    // via control-tool MCP events, plus a fallback 'response' intent if nothing
    // else fired.
    const detectedIntents = intentDetector.detectAll(
      ctx.accumulatedText,
      ctx.controlToolState,
      ctx.mode
    )

    for (const intent of detectedIntents) {
      ctx.emit('intent', intent)
    }

    if (detectedIntents.length === 0) {
      this.log.info(`[PIPELINE:response-path] no-action textLen=${ctx.accumulatedText.length}`)
      ctx.emit('intent', {
        type: 'response',
        content: ctx.accumulatedText
      } as AgentIntent)
    }
  }

  onSessionStop(): void {
    this.snapshot = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
    this.githubConfigured = false
    this.lockedMcpFlags = null
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

  /**
   * Read workspace settings for repomap / semantic-search / github flags.
   * Mirrors DaVinciRoleAdapter.refreshFeatureFlags so both roles honor the
   * same workspace-level MCP toggles.
   */
  private refreshWorkspaceFlags(workspaceId: string | null): void {
    if (!workspaceId) {
      this.repomapEnabled = false
      this.semanticSearchEnabled = false
      this.githubConfigured = false
      return
    }
    try {
      if (!workspaceId) return
      const settings = workspaceRepository.getSettings(workspaceId)
      this.repomapEnabled = settings.repomapEnabled !== false
      this.semanticSearchEnabled = settings.semanticSearchEnabled !== false
      this.githubConfigured = githubService.isConfigured(workspaceId)
    } catch {
      /* non-fatal */
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

  /**
   * Read workspace settings + conversation overrides to determine which
   * external MCPs are active for this chat. Used by both buildPrompts
   * (prompt guidance injection) and buildMcpConfig (tool mounting).
   */
  private resolveExternalMcpActive(
    workspaceId: string | null,
    conversationId: string | null
  ): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    try {
      const wsSettings = workspaceId ? workspaceRepository.getSettings(workspaceId) : {}
      const conv = conversationId ? conversationRepository.findById(conversationId) : null
      const chatOverrides = conv?.mcpOverrides ?? {}

      this.log.info(
        `[adapter:resolve-external-mcp] workspaceId=${workspaceId} conversationId=${conversationId} ` +
          `wsFound=${!!workspaceId} wsSettingsKeys=${Object.keys(wsSettings)
            .filter((k) => k.includes('Available'))
            .join(',')} ` +
          `convFound=${!!conv} chatOverrides=${JSON.stringify(chatOverrides)}`
      )

      for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
        const wsAvailable = !!wsSettings[`${integration.id}Available`]
        const chatActive = !!chatOverrides[integration.id]
        result[integration.id] = wsAvailable && chatActive
        this.log.info(
          `[adapter:resolve-external-mcp] ${integration.id}: wsAvailable=${wsAvailable} chatActive=${chatActive} → mounted=${result[integration.id]}`
        )
      }
    } catch (err) {
      this.log.error('[adapter:external-mcp] Failed to resolve MCP state:', err)
    }
    return result
  }
}

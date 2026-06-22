/**
 * DaVinciRoleAdapter — the home-screen concierge role for AgentSessionService.
 *
 * Phase 1 of the Project Specialist refactor (see
 * docs/architecture/project-specialist-refactor.md).
 *
 * This adapter keeps the Generalist's behavior 100% intact by delegating to
 * the existing helper services (DaVinciPromptAssembler, buildWorkspaceMcpConfig,
 * IntentDetector, memoryService, specialistRepository, etc.). The goal is zero
 * functional drift — only structural reorganization.
 */

import type { ConversationMode, ModelAction, Specialist } from '../../../shared/types'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { DA_VINCI_AGENT_ID } from '../../../shared/constants'
import { DaVinciPromptAssembler } from '../da-vinci-prompt-assembler'
import { memoryService } from '../memory.service'
import { modelConfigService } from '../model-config.service'
import {
  conversationRepository,
  specialistRepository,
  workspaceRepository
} from '../../db/repositories'
import { BaseRoleAdapter } from './base.adapter'

export class DaVinciRoleAdapter extends BaseRoleAdapter {
  readonly role = 'da-vinci' as const
  readonly agentId = DA_VINCI_AGENT_ID

  private readonly promptAssembler = new DaVinciPromptAssembler()

  /** Persona overlay — null = Da Vinci default. */
  private currentPersonaSpecialistId: string | null = null
  private currentPersonaData: Specialist | null = null

  /**
   * Tracks the last specialist id we surfaced a "ready" signal for, so we
   * don't re-prompt every turn after the first readiness transition. Cleared
   * on session end and on workspace change.
   */
  private lastAnnouncedSpecialistId: string | null = null

  /** Cached handoff context — undefined = not yet checked, null = no handoff */
  private handoffContextCache: string | null | undefined = undefined

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.promptAssembler.resetSession()

    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath === ctx.workspacePath)
      const settings = workspace ? workspaceRepository.getSettings(workspace.id) : {}

      if (settings.memoryEnabled !== false && workspace) {
        // Cache-audit optimization: session-start budget reduced from 10K→5K (balanced)
        // and 5K→3K (economy) to lower the first-turn context footprint.
        const memoryBudget = settings.costPreference === 'economy' ? 3000 : 5000
        const memoryCtx = memoryService.getContextForPrompt(workspace.id, memoryBudget)
        if (memoryCtx) this.promptAssembler.setMemoryContext(memoryCtx)
      }
    } catch {
      /* non-fatal — keep defaults */
    }

    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)

    // Pattern 6 / Strategy Λ: Lock MCP flags at session start
    this.lockMcpFlags()

    // Persona carries across session start if conversation was persona-bound,
    // but the session-layer resolves conversations per-send.  On start, reset.
    this.currentPersonaSpecialistId = null
    this.currentPersonaData = null
  }

  refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void {
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)

    // Detect if a Project Specialist has become ready for this workspace
    // since the last send(). If so, arm the one-shot signal so the next
    // buildEffectiveMessage injects the "[PROJECT SPECIALIST READY: <name>]"
    // sentinel into the user message — DaVinci's prompt instructs it to
    // respond with an ask_user swap proposal.
    try {
      if (ctx.workspaceId) {
        const readySpecialist = specialistRepository.findReadyByWorkspace(ctx.workspaceId)
        if (readySpecialist && readySpecialist.id !== this.lastAnnouncedSpecialistId) {
          this.promptAssembler.setPendingSpecialistReadySignal(readySpecialist.displayName)
          this.lastAnnouncedSpecialistId = readySpecialist.id
          this.log.info(
            `[adapter:specialist-ready] Armed swap proposal for workspace=${ctx.workspaceId} specialist=${readySpecialist.displayName}`
          )
        }
      }
    } catch {
      /* non-fatal — detection is best-effort */
    }
  }

  onConversationSwitch(_conversationId: string): void {
    // Matches legacy behavior: invalidate snapshot so the next send() rebuilds.
    this.promptAssembler.invalidateSnapshot()
  }

  buildPrompts(ctx: AdapterPromptContext): AdapterPromptResult {
    // Strategy Λ: Use locked flags for prompt assembly
    const mcpFlags = this.getLockedMcpFlags()

    // Resolve which external MCPs are active for this chat — drives prompt guidance
    const externalMcpActive = this.resolveExternalMcpActive(ctx.workspaceId, ctx.conversationId)

    // Pattern 1: Centralized model resolution
    const isBuildMode = ctx.mode === 'build' || ctx.mode === 'danger'
    const modelAction = `${this.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction
    const resolvedModel = this.resolveModel(ctx.workspacePath, modelAction, ctx.presetId)
    // isLocalProvider is still needed by the assembler for local-prompt branching
    const isLocalProvider = modelConfigService.isLocalProvider(ctx.workspacePath)

    // Inject handoff context from provider switch (cached after first read)
    let handoffPrefix = ''
    if (this.handoffContextCache === undefined && ctx.conversationId) {
      try {
        const conv = conversationRepository.findById(ctx.conversationId)
        this.handoffContextCache = conv?.handoffContext ?? null
      } catch {
        this.handoffContextCache = null
      }
    }
    if (this.handoffContextCache) {
      handoffPrefix = `## Prior Session Context (Handoff)\n\n${this.handoffContextCache}\n\n---\n\n`
    }

    const rawSystemPrompt = this.promptAssembler.buildSystemPromptForTurn({
      message: ctx.message,
      hasImages: ctx.hasImages,
      turnCount: ctx.turnCount,
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      mode: ctx.mode,
      featureFlags: { ...mcpFlags, externalMcpActive },
      costPreference: ctx.costPreference,
      personaSpecialistId: this.currentPersonaSpecialistId,
      personaData: this.currentPersonaData,
      isLocalProvider,
      model: resolvedModel
    })
    const systemPrompt = handoffPrefix ? handoffPrefix + rawSystemPrompt : rawSystemPrompt

    const effectiveMessage = this.promptAssembler.buildEffectiveMessage({
      message: ctx.message,
      conversationId: ctx.conversationId,
      hasImages: ctx.hasImages,
      turnCount: ctx.turnCount,
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      model: resolvedModel
    })

    return { systemPrompt, effectiveMessage }
  }

  protected override resolveWorkspaceId(): string | null {
    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath)
      return workspace?.id ?? null
    } catch {
      return null
    }
  }

  override onSessionStop(): void {
    this.promptAssembler.resetSession()
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
    this.githubConfigured = false
    this.unlockMcpFlags()
    this.currentPersonaSpecialistId = null
    this.currentPersonaData = null
    this.lastAnnouncedSpecialistId = null
  }

  // ── Generalist-specific helpers used by the thin ChatAgentService wrapper ──

  /** Expose the prompt assembler for specialised operations (injectContext, switchMode, persona, compaction). */
  getPromptAssembler(): DaVinciPromptAssembler {
    return this.promptAssembler
  }

  /** Switch persona — clears snapshot and flags a pending persona-switch prefix. */
  setPersona(personaSpecialistId: string | null): void {
    if (personaSpecialistId === this.currentPersonaSpecialistId) return
    this.currentPersonaSpecialistId = personaSpecialistId
    this.currentPersonaData = personaSpecialistId
      ? (specialistRepository.findById(personaSpecialistId) ?? null)
      : null
    this.promptAssembler.invalidateSnapshot()
    this.promptAssembler.setPendingPersonaSwitch(personaSpecialistId)
  }

  getPersona(): { id: string | null; data: Specialist | null } {
    return { id: this.currentPersonaSpecialistId, data: this.currentPersonaData }
  }

  setPendingCompaction(conversationId: string, prompt: string): void {
    this.promptAssembler.setPendingCompaction(conversationId, prompt)
  }

  setPendingModeSwitch(from: ConversationMode, to: ConversationMode): void {
    this.promptAssembler.invalidateSnapshot()
    this.promptAssembler.setPendingModeSwitch(from, to)
  }

  addPendingContext(conversationId: string, context: string): void {
    this.promptAssembler.addPendingContext(conversationId, context)
  }

  getPendingContextSize(conversationId: string): number {
    return this.promptAssembler.getPendingContextSize(conversationId)
  }

  clearConversation(conversationId: string): void {
    this.promptAssembler.clearConversation(conversationId)
  }

  // COMPACT-LOST-01: Confirm that pending injections were sent successfully.
  onSendSuccess(conversationId: string): void {
    this.promptAssembler.confirmPendingConsumed(conversationId)
  }
}

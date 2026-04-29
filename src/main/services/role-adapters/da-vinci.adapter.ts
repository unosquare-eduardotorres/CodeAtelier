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

import type {
  ConversationMode,
  CostPreference,
  AgentIntent,
  MemoryType,
  Specialist
} from '../../../shared/types'
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
import { DA_VINCI_AGENT_ID } from '../../../shared/constants'
import { DaVinciPromptAssembler } from '../da-vinci-prompt-assembler'
import { buildWorkspaceMcpConfig } from '../workspace-mcp-config'
import { githubService } from '../github.service'
import { memoryService } from '../memory.service'
import { memoryRepository, specialistRepository, workspaceRepository } from '../../db/repositories'
import { intentDetector } from '../intent-detector'
import { chatAgentLogger } from '../../logger'

export class DaVinciRoleAdapter implements AgentRoleAdapter {
  readonly role = 'da-vinci' as const
  readonly agentId = DA_VINCI_AGENT_ID

  private readonly log = chatAgentLogger
  private readonly promptAssembler = new DaVinciPromptAssembler()

  /** Feature flags refreshed from workspace settings each send(). */
  private repomapEnabled = false
  private semanticSearchEnabled = false
  private githubConfigured = false

  /**
   * Strategy Λ (Lambda): Locked MCP feature flags — snapshotted at onSessionStart()
   * and used for buildMcpConfig() for the entire session lifetime. This prevents
   * mid-session tool set drift that would break Claude's prompt cache prefix.
   *
   * refreshFeatureFlags() still reads live settings (for specialist-ready detection
   * and telemetry), but the locked flags are what actually drive MCP server mounting.
   * Flags are only re-locked on the next start() or explicit session restart.
   */
  private lockedMcpFlags: {
    repomapEnabled: boolean
    semanticSearchEnabled: boolean
    githubConfigured: boolean
  } | null = null

  /** Persona overlay — null = Da Vinci default. */
  private currentPersonaSpecialistId: string | null = null
  private currentPersonaData: Specialist | null = null

  /**
   * Tracks the last specialist id we surfaced a "ready" signal for, so we
   * don't re-prompt every turn after the first readiness transition. Cleared
   * on session end and on workspace change.
   */
  private lastAnnouncedSpecialistId: string | null = null

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.promptAssembler.resetSession()

    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath === ctx.workspacePath)
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      if (settings.memoryEnabled !== false && workspace) {
        // Cache-audit optimization: session-start budget reduced from 10K→5K (balanced)
        // and 5K→3K (economy) to lower the first-turn context footprint.
        const memoryBudget = settings.costPreference === 'economy' ? 3000 : 5000
        const memoryCtx = memoryService.getContextForPrompt(workspace.id, memoryBudget)
        if (memoryCtx) this.promptAssembler.setMemoryContext(memoryCtx)
      }

      this.repomapEnabled = !!settings.repomapEnabled
      this.semanticSearchEnabled = !!settings.semanticSearchEnabled
      this.githubConfigured = ctx.workspaceId ? githubService.isConfigured(ctx.workspaceId) : false
    } catch {
      /* non-fatal — keep defaults */
    }

    // Strategy Λ: Lock MCP flags at session start — tool set stays stable for
    // the entire session, ensuring Claude's prompt cache prefix is never broken
    // by a mid-session settings toggle.
    this.lockedMcpFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }
    this.log.info(
      `[adapter:lock-mcp-flags] repomap=${this.lockedMcpFlags.repomapEnabled} semantic=${this.lockedMcpFlags.semanticSearchEnabled} github=${this.lockedMcpFlags.githubConfigured}`
    )

    // Persona carries across session start if conversation was persona-bound,
    // but the session-layer resolves conversations per-send.  On start, reset.
    this.currentPersonaSpecialistId = null
    this.currentPersonaData = null
  }

  refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void {
    if (!ctx.workspaceId) return
    try {
      const workspace = workspaceRepository.findById(ctx.workspaceId)
      if (!workspace) return
      const settings = JSON.parse(workspace.settingsJson || '{}')
      this.repomapEnabled = !!settings.repomapEnabled
      this.semanticSearchEnabled = !!settings.semanticSearchEnabled
      this.githubConfigured = githubService.isConfigured(ctx.workspaceId)
    } catch {
      /* non-fatal */
    }

    // Detect if a Project Specialist has become ready for this workspace
    // since the last send(). If so, arm the one-shot signal so the next
    // buildEffectiveMessage injects the "[PROJECT SPECIALIST READY: <name>]"
    // sentinel into the user message — DaVinci's prompt instructs it to
    // respond with an ask_user swap proposal.
    try {
      const readySpecialist = specialistRepository.findReadyByWorkspace(ctx.workspaceId)
      if (readySpecialist && readySpecialist.id !== this.lastAnnouncedSpecialistId) {
        this.promptAssembler.setPendingSpecialistReadySignal(readySpecialist.displayName)
        this.lastAnnouncedSpecialistId = readySpecialist.id
        this.log.info(
          `[adapter:specialist-ready] Armed swap proposal for workspace=${ctx.workspaceId} specialist=${readySpecialist.displayName}`
        )
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
    // Strategy Λ: Use locked flags for prompt assembly (MCP guidance sections
    // must match the tool set mounted via buildMcpConfig). Fall back to live
    // flags only if session hasn't started yet (shouldn't happen in practice).
    const mcpFlags = this.lockedMcpFlags ?? {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }

    const systemPrompt = this.promptAssembler.buildSystemPromptForTurn({
      message: ctx.message,
      hasImages: ctx.hasImages,
      turnCount: ctx.turnCount,
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      mode: ctx.mode,
      featureFlags: mcpFlags,
      costPreference: ctx.costPreference,
      personaSpecialistId: this.currentPersonaSpecialistId,
      personaData: this.currentPersonaData
    })

    const effectiveMessage = this.promptAssembler.buildEffectiveMessage({
      message: ctx.message,
      conversationId: ctx.conversationId,
      hasImages: ctx.hasImages,
      turnCount: ctx.turnCount,
      sessionId: ctx.sessionId,
      mode: ctx.mode
    })

    return { systemPrompt, effectiveMessage }
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    // Strategy Λ: Use locked flags so the MCP server set stays identical across
    // all turns in this session, preserving the Claude prompt cache prefix.
    const mcpFlags = this.lockedMcpFlags ?? {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }

    return buildWorkspaceMcpConfig({
      mode: ctx.mode,
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      featureFlags: mcpFlags,
      controlCallbacks: ctx.controlCallbacks
    })
  }

  buildControlCallbacks(params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    return {
      onPlan: (_plan) => {
        // Session wraps this and emits 'plan' — adapter does nothing extra.
      },
      onAskUser: (_questions) => {
        // Session wraps this and emits 'askQuestion'.
      },
      onMemory: (memory: { type: MemoryType; title: string; content: string }) => {
        // Persist immediately — no need to wait for stream finalize.
        try {
          const workspaces = workspaceRepository.findAll()
          const workspace = workspaces.find((w) => w.repoPath)
          const memWorkspaceId =
            memory.type === 'user' || memory.type === 'feedback' ? null : (workspace?.id ?? null)
          const mem = memoryRepository.createIfNotDuplicate({
            workspaceId: memWorkspaceId,
            type: memory.type,
            title: memory.title,
            content: memory.content,
            tags: [],
            sourceConversationId: params.conversationId ?? undefined,
            sourceAgentId: DA_VINCI_AGENT_ID,
            importance: 5
          })
          if (mem) {
            this.log.info(`Memory created via tool: [${memory.type}] ${memory.title}`)
          } else {
            this.log.info(`Memory skipped (duplicate): [${memory.type}] ${memory.title}`)
          }
        } catch (err) {
          this.log.warn('Failed to persist tool-emitted memory:', err)
        }
      }
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
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
    this.promptAssembler.resetSession()
    this.repomapEnabled = false
    this.semanticSearchEnabled = false
    this.githubConfigured = false
    this.lockedMcpFlags = null
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

  getCompactionThresholds(
    _costPreference: CostPreference
  ): { suggest: number; auto: number } | null {
    // Use session defaults.
    return null
  }

  getPersonaId(): string | null {
    return this.currentPersonaSpecialistId
  }

  clearConversation(conversationId: string): void {
    this.promptAssembler.clearConversation(conversationId)
  }
}

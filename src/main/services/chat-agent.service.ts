/**
 * ChatAgentService — the single long-lived chat session facade.
 *
 * After Phase 2 of the Project Specialist refactor this class is a router:
 *   - Workspace has a **ready** Project Specialist → start an
 *     AgentSessionService backed by ProjectSpecialistRoleAdapter.
 *   - Workspace has no specialist (or it is still pending/failed) → fall
 *     back to DaVinciRoleAdapter (the legacy concierge behavior).
 *
 * Both paths share the same EventEmitter surface (chunk, statusUpdate,
 * complete, intent, handoff, plan, askQuestion, promptSuggestion,
 * compactNeeded, elicitation) so every existing consumer
 * (chat-stream.service.ts, agent.ipc.ts, sdk-control.ipc.ts,
 * chat-lifecycle.ipc.ts, checkpoint.ipc.ts, agent-lifecycle.ipc.ts,
 * task-pipeline.service.ts, tests) keeps working unchanged.
 *
 * See docs/architecture/project-specialist-refactor.md.
 */

import { EventEmitter } from 'node:events'
import type { AgentRole, AgentStatus, ConversationMode, ImageAttachment } from '../../shared/types'
import { chatAgentLogger } from '../logger'
import { AgentSessionService } from './agent-session.service'
import { DaVinciRoleAdapter } from './role-adapters/da-vinci.adapter'
import { ProjectSpecialistRoleAdapter } from './role-adapters/project-specialist.adapter'
import type { AgentRoleAdapter } from './agent-session.types'
import type { CacheEfficiencyReport } from './agent-token-tracker'
import { workspaceRepository } from '../db/repositories'
import { getDatabase } from '../db/index'
import { modelConfigService } from './model-config.service'

/** Events forwarded session → this facade. */
const FORWARDED_EVENTS = [
  'chunk',
  'statusUpdate',
  'complete',
  'intent',
  'plan',
  'askQuestion',
  'promptSuggestion',
  'compactNeeded',
  'elicitation'
] as const

export class ChatAgentService extends EventEmitter {
  private readonly log = chatAgentLogger

  /** Owning adapter + session. Rebuilt on each start() to pick the right adapter. */
  private adapter: AgentRoleAdapter
  private session: AgentSessionService
  /** Cleanup functions for the currently-wired forwarders. */
  private forwarderCleanups: Array<() => void> = []

  /** The DaVinciRoleAdapter is always alive for home / persona lookups. */
  private readonly daVinciAdapter: DaVinciRoleAdapter

  constructor() {
    super()
    this.setMaxListeners(100)

    this.daVinciAdapter = new DaVinciRoleAdapter()
    this.adapter = this.daVinciAdapter
    this.session = new AgentSessionService(this.adapter)
    this.wireSessionForwarders()

    // Outside code emits elicitationResponse on us — relay to the session.
    this.on('elicitationResponse', (payload: unknown) => {
      this.session.emit('elicitationResponse', payload)
    })
  }

  private wireSessionForwarders(): void {
    for (const evt of FORWARDED_EVENTS) {
      const handler = (...args: unknown[]): void => {
        this.emit(evt, ...args)
      }
      this.session.on(evt, handler)
      this.forwarderCleanups.push(() => this.session.off(evt, handler))
    }
  }

  private teardownSessionForwarders(): void {
    for (const off of this.forwarderCleanups) off()
    this.forwarderCleanups = []
  }

  /**
   * Pick the right adapter for the given workspace path.
   * Returns the workspace's ProjectSpecialistRoleAdapter when a specialist
   * row exists AND its build_status is 'ready'. Otherwise falls back to the
   * shared DaVinciRoleAdapter.
   */
  private resolveAdapter(workspacePath: string): AgentRoleAdapter {
    try {
      const workspace = workspaceRepository.findByPath(workspacePath)
      if (!workspace) return this.daVinciAdapter

      const settings = JSON.parse(workspace.settingsJson || '{}') as {
        specialistSwapAccepted?: boolean
      }
      if (!settings.specialistSwapAccepted) {
        // User has not accepted the swap yet → keep DaVinci.
        return this.daVinciAdapter
      }

      const db = getDatabase()
      const row = db
        .prepare(`SELECT id, build_status FROM specialists WHERE workspace_id = ?`)
        .get(workspace.id) as { id: string; build_status: string } | undefined
      if (row?.build_status === 'ready') {
        this.log.info(
          `[adapter-swap] Using ProjectSpecialistRoleAdapter (user-accepted) for workspace=${workspace.id}`
        )
        return new ProjectSpecialistRoleAdapter({ workspaceId: workspace.id })
      }
    } catch (err) {
      this.log.warn('[adapter-swap] resolveAdapter failed, falling back to DaVinci:', err)
    }
    return this.daVinciAdapter
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    const nextAdapter = this.resolveAdapter(workspacePath)
    const adapterChanged = nextAdapter !== this.adapter

    if (adapterChanged) {
      // Stop + dispose the existing session so we don't leak listeners.
      try {
        await this.session.stop()
      } catch {
        /* ignore — session may not have been started yet */
      }
      this.teardownSessionForwarders()
      this.adapter = nextAdapter
      this.session = new AgentSessionService(this.adapter)
      this.wireSessionForwarders()
    }

    return this.session.start(workspacePath, mode, resumeSessionId)
  }

  async send(message: string, conversationId: string, images?: ImageAttachment[]): Promise<void> {
    return this.session.send(message, conversationId, images)
  }

  async stop(): Promise<void> {
    return this.session.stop()
  }

  cancelCurrentQuery(): void {
    this.session.cancelCurrentQuery()
  }

  async switchMode(mode: ConversationMode): Promise<void> {
    if (mode === this.session.getMode()) return
    // Only the Generalist adapter carries mode-switch prefix state.
    if (this.adapter === this.daVinciAdapter) {
      this.daVinciAdapter.setPendingModeSwitch(this.session.getMode(), mode)
    }
    return this.session.switchMode(mode)
  }

  async switchPersona(personaSpecialistId: string | null, conversationId: string): Promise<void> {
    // Persona is a Generalist-only concept; if the Project Specialist is active,
    // persona switches are ignored (warning logged).
    if (this.adapter !== this.daVinciAdapter) {
      this.log.warn('[persona-switch] Ignored — Project Specialist is active for this workspace')
      return
    }
    if (personaSpecialistId === this.daVinciAdapter.getPersona().id) return
    if (!this.session.getWorkspacePath()) return

    this.log.info(
      `[PIPELINE:persona-switch] ${this.daVinciAdapter.getPersona().id ?? 'Da Vinci'} → ${personaSpecialistId ?? 'Da Vinci'}`
    )

    this.daVinciAdapter.setPersona(personaSpecialistId)

    if (this.session.isRunning()) {
      this.daVinciAdapter.setPendingCompaction(
        conversationId,
        'Summarize the conversation so far — a persona change is about to happen.'
      )
    }
  }

  async injectContext(context: string, conversationId: string): Promise<void> {
    if (!this.session.getWorkspacePath()) {
      this.log.warn('Cannot inject context — agent not started')
      return
    }
    // Only the Generalist adapter caches pending context; the Project Specialist
    // writes a simpler prompt and doesn't need the lazy-inject mechanism.
    if (this.adapter !== this.daVinciAdapter) return

    const existingSize = this.daVinciAdapter.getPendingContextSize(conversationId)
    this.daVinciAdapter.addPendingContext(conversationId, context)
    if (existingSize > 0) {
      this.log.info(
        `Appended to pending context injection for conversation ${conversationId} (${context.length} chars added, total: ${existingSize + context.length + 2} chars)`
      )
    } else {
      this.log.info(
        `Stored pending context injection for conversation ${conversationId} (${context.length} chars — will prepend to next send())`
      )
    }
  }

  async compact(extractNuance = false): Promise<void> {
    const workspacePath = this.session.getWorkspacePath()
    const conversationId = this.session.getCurrentConversationId()
    if (!workspacePath || !conversationId) {
      throw new Error('Agent not running — nothing to compact')
    }

    // Local LLMs: delegate directly to session.compact() which emits
    // 'compactNeeded' with level='local-unsupported' — no sessionId needed.
    if (modelConfigService.isLocalProvider(workspacePath)) {
      await this.session.compact()
      return
    }

    const sessionId = this.session.getSessionId(conversationId)
    if (!sessionId) {
      throw new Error('No session to compact')
    }

    this.log.info(`Starting native SDK compaction (nuance=${extractNuance})`)

    // Pending compaction prefix is only wired on the Generalist adapter; for
    // the Project Specialist we simply delegate to the session's compact.
    if (this.adapter === this.daVinciAdapter) {
      if (extractNuance) {
        this.daVinciAdapter.setPendingCompaction(
          conversationId,
          '/compact Extract nuance: preserve ALL decisions, preferences, file paths, specialist reports verbatim. Keep recent 3-4 turns verbatim.'
        )
      } else {
        this.daVinciAdapter.setPendingCompaction(conversationId, '/compact')
      }
    }
    await this.session.compact()
  }

  async resumeAt(messageId: string): Promise<void> {
    return this.session.resumeAt(messageId)
  }

  // ── Accessors ─────────────────────────────────────────────────────

  getStatus(): AgentStatus {
    return this.session.getStatus()
  }

  isRunning(): boolean {
    return this.session.isRunning()
  }

  getActiveQuery(): import('@anthropic-ai/claude-agent-sdk').Query | null {
    return this.session.getActiveQuery()
  }

  getWorkspacePath(): string | null {
    return this.session.getWorkspacePath()
  }

  getCurrentConversationId(): string | null {
    return this.session.getCurrentConversationId()
  }

  getStreamedContent(): string {
    return this.session.getStreamedContent()
  }

  getMode(): ConversationMode {
    return this.session.getMode()
  }

  getCacheEfficiency(): CacheEfficiencyReport {
    return this.session.getCacheEfficiency()
  }

  getSessionId(conversationId: string): string | undefined {
    return this.session.getSessionId(conversationId)
  }

  clearSession(conversationId: string): void {
    this.session.clearSession(conversationId)
    if (this.adapter === this.daVinciAdapter) {
      this.daVinciAdapter.clearConversation(conversationId)
    }
  }

  /** Which role is currently driving the session. */
  getActiveRole(): AgentRole {
    return this.adapter.role
  }

  /** The agent_id of the currently active adapter (DA_VINCI_AGENT_ID or workspace-specialist-<wsId>). */
  getActiveAgentId(): string {
    return this.adapter.agentId
  }

  /** The DB role tag (`'da-vinci' | 'specialist'`) for whichever adapter is active. */
  getActiveMessageRole(): 'da-vinci' | 'specialist' {
    return this.adapter.role === 'project-specialist' ? 'specialist' : 'da-vinci'
  }

  /**
   * Returns persona overlay info for the current Da Vinci adapter, or null when
   * no persona is active (Da Vinci default) or when a Project Specialist
   * adapter is driving (the project specialist *is* the active identity, not a
   * persona overlay — callers should treat that as `getActiveMessageRole()`).
   *
   * Used by the chat-stream service to drive the renderer's thinking-indicator
   * avatar so it matches the saved bubble's identity from the very first chunk.
   */
  getActivePersona(): { id: string; agentId: string; alias: string | null } | null {
    if (this.adapter !== this.daVinciAdapter) return null
    const persona = this.daVinciAdapter.getPersona()
    if (!persona.id) return null
    return {
      id: persona.id,
      agentId: persona.data?.agentId ?? persona.id,
      alias: persona.data?.alias ?? persona.data?.displayName ?? null
    }
  }
}

export const chatAgentService = new ChatAgentService()

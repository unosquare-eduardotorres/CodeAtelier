/**
 * ChatAgentService — multi-workspace chat session manager.
 *
 * Maintains a Map<workspaceId, SessionEntry> so multiple workspace sessions can
 * run concurrently. Switching workspaces in the UI is now a view swap only —
 * background sessions continue executing.
 *
 * The adapter-resolution logic picks between DaVinciRoleAdapter (the default
 * concierge) and ProjectSpecialistRoleAdapter (workspace-specific AI) based on
 * the workspace's specialist build_status and the user's swap acceptance.
 *
 * All existing consumers (chat-stream.service.ts, agent.ipc.ts, etc.) continue
 * working through backward-compatible accessors that delegate to the active
 * workspace session.
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
  'elicitation',
  'budgetCapReached'
] as const

/** Internal state for a single workspace's session. */
interface SessionEntry {
  adapter: AgentRoleAdapter
  session: AgentSessionService
  forwarderCleanups: Array<() => void>
  workspacePath: string
}

export class ChatAgentService extends EventEmitter {
  private readonly log = chatAgentLogger

  /** Active sessions indexed by workspaceId. */
  private sessions = new Map<string, SessionEntry>()

  /** Currently active (visible in UI) workspace. */
  private _activeWorkspaceId: string | null = null

  /** The DaVinciRoleAdapter is always alive for home / persona lookups. */
  private readonly daVinciAdapter: DaVinciRoleAdapter

  constructor() {
    super()
    this.setMaxListeners(100)

    this.daVinciAdapter = new DaVinciRoleAdapter()

    // Outside code emits elicitationResponse on us — relay to the active session.
    this.on('elicitationResponse', (payload: unknown) => {
      this.getActiveSession()?.emit('elicitationResponse', payload)
    })
  }

  // ── Multi-Session Management ──────────────────────────────────────

  /**
   * Start (or re-activate) a session for a workspace. If the workspace already
   * has a running session, this is a no-op — the session keeps running.
   * Does NOT stop other workspace sessions.
   */
  async startForWorkspace(
    workspaceId: string,
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    const existing = this.sessions.get(workspaceId)
    if (existing) {
      this.log.info(`[multi-session] Workspace ${workspaceId} already has a session — activating`)
      // Adapter may have changed (e.g., specialist build_status changed)
      const nextAdapter = this.resolveAdapter(workspacePath)
      if (nextAdapter !== existing.adapter) {
        this.log.info(
          `[multi-session] Adapter changed for workspace ${workspaceId} — rebuilding session`
        )
        await this.stopForWorkspace(workspaceId)
        // Fall through to create a new session below
      } else {
        this._activeWorkspaceId = workspaceId
        return // Session already running with correct adapter
      }
    }

    const adapter = this.resolveAdapter(workspacePath)
    const session = new AgentSessionService(adapter)
    const forwarderCleanups: Array<() => void> = []

    const entry: SessionEntry = { adapter, session, forwarderCleanups, workspacePath }

    // SVC-01: Wire forwarders and start BEFORE adding to map.
    // If start() throws, the entry never enters the map — prevents
    // dead-session ghost entries that block future startForWorkspace calls.
    this.wireSessionForwarders(workspaceId, entry)
    try {
      await session.start(workspacePath, mode, resumeSessionId)
    } catch (err) {
      // Cleanup on failure — don't leave partial forwarders
      this.teardownSessionForwarders(entry)
      throw err
    }

    // Only add to map and set active AFTER successful start
    this.sessions.set(workspaceId, entry)
    this._activeWorkspaceId = workspaceId
  }

  /**
   * Stop and remove a workspace session. Does NOT affect other sessions.
   */
  async stopForWorkspace(workspaceId: string): Promise<void> {
    const entry = this.sessions.get(workspaceId)
    if (!entry) return

    this.log.info(`[multi-session] Stopping session for workspace ${workspaceId}`)
    this.teardownSessionForwarders(entry)

    try {
      await entry.session.stop()
    } catch {
      /* ignore — session may not have been fully started */
    }

    this.sessions.delete(workspaceId)

    if (this._activeWorkspaceId === workspaceId) {
      this._activeWorkspaceId = null
    }
  }

  /** Stop all running sessions (e.g., app quit). */
  async stopAll(): Promise<void> {
    const workspaceIds = [...this.sessions.keys()]
    this.log.info(`[multi-session] Stopping all ${workspaceIds.length} sessions`)
    await Promise.allSettled(workspaceIds.map((id) => this.stopForWorkspace(id)))
  }

  /** Send a message to a specific workspace session. */
  async sendForWorkspace(
    workspaceId: string,
    message: string,
    conversationId: string,
    images?: ImageAttachment[]
  ): Promise<void> {
    const entry = this.sessions.get(workspaceId)
    if (!entry) throw new Error(`No session for workspace ${workspaceId}`)
    return entry.session.send(message, conversationId, images)
  }

  /** Get the session for a specific workspace (or undefined). */
  getSessionForWorkspace(workspaceId: string): AgentSessionService | undefined {
    return this.sessions.get(workspaceId)?.session
  }

  /** Get the adapter for a specific workspace (or undefined). */
  getAdapterForWorkspace(workspaceId: string): AgentRoleAdapter | undefined {
    return this.sessions.get(workspaceId)?.adapter
  }

  /** Get statuses for all running workspace sessions. */
  getAllStatuses(): Map<string, AgentStatus> {
    const statuses = new Map<string, AgentStatus>()
    for (const [wsId, entry] of this.sessions) {
      const status = entry.session.getStatus()
      statuses.set(wsId, { ...status, workspaceId: wsId })
    }
    return statuses
  }

  /** Set the currently active (visible) workspace. */
  setActiveWorkspace(workspaceId: string | null): void {
    this._activeWorkspaceId = workspaceId
  }

  /** Get the active workspace ID. */
  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  /** Check if a given workspace has a running session. */
  hasSessionForWorkspace(workspaceId: string): boolean {
    return this.sessions.has(workspaceId)
  }

  /** Get the number of active sessions. */
  get activeSessionCount(): number {
    return this.sessions.size
  }

  // ── Event Forwarding (workspace-tagged) ───────────────────────────

  private wireSessionForwarders(workspaceId: string, entry: SessionEntry): void {
    for (const evt of FORWARDED_EVENTS) {
      const handler = (...args: unknown[]): void => {
        // Emit with workspaceId as the first argument for new consumers
        this.emit(evt, ...args)
        // Also emit a workspace-tagged version for multi-session-aware consumers
        this.emit(`${evt}:ws`, workspaceId, ...args)
      }
      entry.session.on(evt, handler)
      entry.forwarderCleanups.push(() => entry.session.off(evt, handler))
    }
  }

  private teardownSessionForwarders(entry: SessionEntry): void {
    for (const off of entry.forwarderCleanups) off()
    entry.forwarderCleanups = []
  }

  // ── Adapter Resolution ────────────────────────────────────────────

  /**
   * Pick the right adapter for the given workspace path.
   * Returns the workspace's ProjectSpecialistRoleAdapter when a specialist
   * row exists AND its build_status is 'ready'. Otherwise falls back to the
   * shared DaVinciRoleAdapter.
   */
  private resolveAdapter(workspacePath: string): AgentRoleAdapter {
    try {
      const workspace = workspaceRepository.findByPath(workspacePath)
      if (!workspace) {
        // SVC-02: Log workspace path for debugging — silent fallback is hard to trace
        this.log.warn(`[adapter-swap] Workspace not found for path=${workspacePath}, using DaVinci`)
        return this.daVinciAdapter
      }

      const settings = workspaceRepository.getSettings(workspace.id)
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

  // ── Active Session Helper ─────────────────────────────────────────

  private getActiveSession(): AgentSessionService | undefined {
    if (!this._activeWorkspaceId) return undefined
    return this.sessions.get(this._activeWorkspaceId)?.session
  }

  private getActiveEntry(): SessionEntry | undefined {
    if (!this._activeWorkspaceId) return undefined
    return this.sessions.get(this._activeWorkspaceId)
  }

  private getActiveAdapter(): AgentRoleAdapter {
    return this.getActiveEntry()?.adapter ?? this.daVinciAdapter
  }

  /**
   * Ensure a live session exists & is active for a workspace; lazily starts
   * it if missing. Self-heals the fire-and-forget startAgent race.
   */
  async ensureStarted(workspaceId: string, workspacePath: string): Promise<void> {
    if (!this.hasSessionForWorkspace(workspaceId)) {
      await this.startForWorkspace(workspaceId, workspacePath)
    }
    if (this._activeWorkspaceId !== workspaceId) {
      this.setActiveWorkspace(workspaceId)
    }
  }

  // ── Backward-Compatible Lifecycle (delegates to active workspace) ─

  /**
   * Start a session for a workspace path. Resolves workspaceId from the path.
   * Backward-compatible with the old single-session API.
   */
  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    const workspace = workspaceRepository.findByPath(workspacePath)
    const workspaceId = workspace?.id ?? workspacePath // Fallback to path if no workspace found
    return this.startForWorkspace(workspaceId, workspacePath, mode, resumeSessionId)
  }

  async send(message: string, conversationId: string, images?: ImageAttachment[]): Promise<void> {
    const session = this.getActiveSession()
    if (!session) throw new Error('No active session — call start() first')
    return session.send(message, conversationId, images)
  }

  async stop(): Promise<void> {
    if (this._activeWorkspaceId) {
      return this.stopForWorkspace(this._activeWorkspaceId)
    }
  }

  cancelCurrentQuery(): void {
    this.getActiveSession()?.cancelCurrentQuery()
  }

  async switchMode(mode: ConversationMode): Promise<void> {
    const session = this.getActiveSession()
    if (!session) return

    if (mode === session.getMode()) return
    const adapter = this.getActiveAdapter()
    if (adapter === this.daVinciAdapter) {
      this.daVinciAdapter.setPendingModeSwitch(session.getMode(), mode)
    }
    return session.switchMode(mode)
  }

  async switchPersona(personaSpecialistId: string | null, conversationId: string): Promise<void> {
    const adapter = this.getActiveAdapter()
    const session = this.getActiveSession()
    if (!session) return

    // Persona is a Generalist-only concept; if the Project Specialist is active,
    // persona switches are ignored (warning logged).
    if (adapter !== this.daVinciAdapter) {
      this.log.warn('[persona-switch] Ignored — Project Specialist is active for this workspace')
      return
    }
    if (personaSpecialistId === this.daVinciAdapter.getPersona().id) return
    if (!session.getWorkspacePath()) return

    this.log.info(
      `[PIPELINE:persona-switch] ${this.daVinciAdapter.getPersona().id ?? 'Da Vinci'} → ${personaSpecialistId ?? 'Da Vinci'}`
    )

    this.daVinciAdapter.setPersona(personaSpecialistId)

    if (session.isRunning()) {
      this.daVinciAdapter.setPendingCompaction(
        conversationId,
        'Summarize the conversation so far — a persona change is about to happen.'
      )
    }
  }

  async injectContext(context: string, conversationId: string): Promise<void> {
    const session = this.getActiveSession()
    if (!session?.getWorkspacePath()) {
      this.log.warn('Cannot inject context — agent not started')
      return
    }
    const adapter = this.getActiveAdapter()
    // Only the Generalist adapter caches pending context; the Project Specialist
    // writes a simpler prompt and doesn't need the lazy-inject mechanism.
    if (adapter !== this.daVinciAdapter) return

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
    const session = this.getActiveSession()
    if (!session) throw new Error('Agent not running — nothing to compact')

    const workspacePath = session.getWorkspacePath()
    const conversationId = session.getCurrentConversationId()
    if (!workspacePath || !conversationId) {
      throw new Error('Agent not running — nothing to compact')
    }

    // Local LLMs: delegate directly to session.compact() which emits
    // 'compactNeeded' with level='local-unsupported' — no sessionId needed.
    if (modelConfigService.isLocalProvider(workspacePath)) {
      await session.compact()
      return
    }

    const sessionId = session.getSessionId(conversationId)
    if (!sessionId) {
      throw new Error('No session to compact')
    }

    this.log.info(`Starting native SDK compaction (nuance=${extractNuance})`)

    const adapter = this.getActiveAdapter()
    // Pending compaction prefix is only wired on the Generalist adapter; for
    // the Project Specialist we simply delegate to the session's compact.
    if (adapter === this.daVinciAdapter) {
      if (extractNuance) {
        this.daVinciAdapter.setPendingCompaction(
          conversationId,
          '/compact Extract nuance: preserve ALL decisions, preferences, file paths, specialist reports verbatim. Keep recent 3-4 turns verbatim.'
        )
      } else {
        this.daVinciAdapter.setPendingCompaction(conversationId, '/compact')
      }
    }
    await session.compact()
  }

  async resumeAt(messageId: string): Promise<void> {
    const session = this.getActiveSession()
    if (!session) throw new Error('No active session for resumeAt')
    return session.resumeAt(messageId)
  }

  // ── Accessors (backward-compat — delegate to active workspace) ────

  getStatus(): AgentStatus {
    const session = this.getActiveSession()
    if (!session) {
      return {
        agentId: this.daVinciAdapter.agentId,
        agentType: 'da-vinci',
        status: 'idle',
        elapsedMs: 0,
        tokenUsage: 0,
        workspaceId: this._activeWorkspaceId ?? undefined
      }
    }
    return { ...session.getStatus(), workspaceId: this._activeWorkspaceId ?? undefined }
  }

  isRunning(): boolean {
    return this.getActiveSession()?.isRunning() ?? false
  }

  /**
   * Route the renderer's answer to an ask_user question back through the IPC bridge
   * to the control-actions MCP server's pending askUserAndWaitForResponse promise.
   */
  respondToAskUser(requestId: string, response: string): void {
    this.getActiveSession()?.respondToAskUser(requestId, response)
  }

  /**
   * Route respondToAskUser to a specific workspace (for cross-workspace permission flow).
   */
  respondToAskUserForWorkspace(workspaceId: string, requestId: string, response: string): void {
    this.sessions.get(workspaceId)?.session.respondToAskUser(requestId, response)
  }

  getWorkspacePath(): string | null {
    return this.getActiveSession()?.getWorkspacePath() ?? null
  }

  getCurrentConversationId(): string | null {
    return this.getActiveSession()?.getCurrentConversationId() ?? null
  }

  getStreamedContent(): string {
    return this.getActiveSession()?.getStreamedContent() ?? ''
  }

  getMode(): ConversationMode {
    return this.getActiveSession()?.getMode() ?? 'plan'
  }

  getCacheEfficiency(): CacheEfficiencyReport {
    const session = this.getActiveSession()
    if (!session) {
      return { hitRate: 0, savedTokens: 0, totalInput: 0, turns: 0, turnBreakdown: [] }
    }
    return session.getCacheEfficiency()
  }

  getSessionId(conversationId: string): string | undefined {
    return this.getActiveSession()?.getSessionId(conversationId)
  }

  clearSession(conversationId: string): void {
    this.getActiveSession()?.clearSession(conversationId)
    const adapter = this.getActiveAdapter()
    if (adapter === this.daVinciAdapter) {
      this.daVinciAdapter.clearConversation(conversationId)
    }
  }

  /** Which executor backend is active for the current workspace (cli | local-direct | unknown). */
  getExecutorBackend(): string {
    const wp = this.getActiveSession()?.getWorkspacePath() ?? undefined
    return modelConfigService.getExecutorBackend(wp)
  }

  /** Which role is currently driving the session. */
  getActiveRole(): AgentRole {
    return this.getActiveAdapter().role
  }

  /** The agent_id of the currently active adapter (DA_VINCI_AGENT_ID or workspace-specialist-<wsId>). */
  getActiveAgentId(): string {
    return this.getActiveAdapter().agentId
  }

  /** The DB role tag (`'da-vinci' | 'specialist'`) for whichever adapter is active. */
  getActiveMessageRole(): 'da-vinci' | 'specialist' {
    return this.getActiveAdapter().role === 'project-specialist' ? 'specialist' : 'da-vinci'
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
    const adapter = this.getActiveAdapter()
    if (adapter !== this.daVinciAdapter) return null
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

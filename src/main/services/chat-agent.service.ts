/**
 * ChatAgentService — multi-workspace chat session manager.
 *
 * Maintains a Map<workspaceId, SessionEntry> so multiple workspace sessions can
 * run concurrently. Switching workspaces in the UI is now a view swap only —
 * background sessions continue executing.
 *
 * Every workspace uses ProjectSpecialistRoleAdapter. When a specialist row
 * exists with build_status='ready', the adapter uses the tailored prompt;
 * otherwise it falls back to DEFAULT_ARCHITECT_PROMPT.
 *
 * All existing consumers (chat-stream.service.ts, agent.ipc.ts, etc.) continue
 * working through backward-compatible accessors that delegate to the active
 * workspace session.
 */

import { EventEmitter } from 'node:events'
import type {
  AgentRole,
  AgentStatus,
  ControlToolState,
  ConversationMode,
  ImageAttachment
} from '../../shared/types'
import { chatAgentLogger } from '../logger'
import { AgentSessionService } from './agent-session.service'
import { ProjectSpecialistRoleAdapter } from './role-adapters/project-specialist.adapter'
import type { AgentRoleAdapter } from './agent-session.types'
import type { CacheEfficiencyReport } from './agent-token-tracker'
import { workspaceRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { memoryDocWatcherService } from './memory-doc-watcher.service'

/** Events forwarded session → this facade. */
const FORWARDED_EVENTS = [
  'chunk',
  'statusUpdate',
  'complete',
  'intent',
  'plan',
  'askQuestion',
  'permissionRequest',
  'permissionResolved',
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

  constructor() {
    super()
    this.setMaxListeners(100)

    // ELICIT-ROUTES-ACTIVE-01: Route elicitationResponse to the correct workspace
    // session when a workspaceId is provided, falling back to the active session.
    // The permission.ipc handler already routes correctly per-workspace; this
    // catch-all is only hit from sdk-control.ipc which always targets the active UI.
    this.on('elicitationResponse', (payload: unknown) => {
      const wsId = (payload as Record<string, unknown> | null)?.workspaceId as string | undefined
      const session = wsId ? this.getSessionForWorkspace(wsId) : this.getActiveSession()
      if (session) {
        session.emit('elicitationResponse', payload)
      } else {
        this.log.warn('[elicitationResponse] No session for routing — response dropped')
      }
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
      // ADAPTER-IDENTITY-01: Compare by adapter type, not object identity —
      // resolveAdapter() creates fresh instances, so identity always differs.
      if (nextAdapter.constructor !== existing.adapter.constructor) {
        this.log.info(
          `[multi-session] Adapter changed for workspace ${workspaceId} — rebuilding session`
        )
        await this.stopForWorkspace(workspaceId)
        // Fall through to create a new session below
      } else {
        this._activeWorkspaceId = workspaceId
        // C2-FIX: Ensure the doc watcher follows the active workspace.
        // Without this, switching back to a previously-started workspace
        // leaves the watcher pointed at the last-started workspace.
        if (memoryDocWatcherService.activeWorkspace !== workspaceId) {
          try {
            const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
            if (settings.memoryDocCapture !== false) {
              memoryDocWatcherService.start(workspaceId, workspacePath)
            } else {
              // N3-FIX: Target workspace has docCapture off — stop the old watcher
              // so it doesn't keep watching the previous workspace.
              memoryDocWatcherService.stop()
            }
          } catch (err) {
            this.log.debug('[doc-watcher] Failed to restart doc watcher on switch-back:', err)
          }
        }
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

    // Start doc watcher if capture is enabled
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      if (settings.memoryDocCapture !== false) {
        memoryDocWatcherService.start(workspaceId, workspacePath)
      } else {
        // N3-FIX: New session's workspace has docCapture off — stop any
        // watcher left over from the previous workspace.
        memoryDocWatcherService.stop()
      }
    } catch (err) {
      this.log.debug('[doc-watcher] Failed to start doc watcher:', err)
    }
  }

  /**
   * Stop and remove a workspace session. Does NOT affect other sessions.
   */
  async stopForWorkspace(workspaceId: string): Promise<void> {
    const entry = this.sessions.get(workspaceId)
    if (!entry) return

    this.log.info(`[multi-session] Stopping session for workspace ${workspaceId}`)
    // C1-FIX: Only stop the doc watcher if it belongs to THIS workspace —
    // stopping a background session must not kill the active workspace's watcher.
    if (memoryDocWatcherService.activeWorkspace === workspaceId) {
      memoryDocWatcherService.stop()
    }
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
   * Always returns a ProjectSpecialistRoleAdapter. When a specialist row
   * exists with build_status='ready', the adapter uses the tailored prompt;
   * otherwise it falls back to DEFAULT_ARCHITECT_PROMPT.
   */
  private resolveAdapter(workspacePath: string): AgentRoleAdapter {
    const workspace = workspaceRepository.findByPath(workspacePath)
    const workspaceId = workspace?.id ?? workspacePath
    return new ProjectSpecialistRoleAdapter({ workspaceId })
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

  private getActiveAdapter(): AgentRoleAdapter | undefined {
    return this.getActiveEntry()?.adapter
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

  cancelCurrentQuery(conversationId?: string): void {
    this.getActiveSession()?.cancelCurrentQuery(conversationId)
  }

  async switchMode(mode: ConversationMode): Promise<void> {
    const session = this.getActiveSession()
    if (!session) return

    if (mode === session.getMode()) return
    const adapter = this.getActiveAdapter()
    adapter?.setPendingModeSwitch?.(session.getMode(), mode)
    return session.switchMode(mode)
  }

  /** @deprecated Persona system removed — no-op. */
  async switchPersona(_personaSpecialistId: string | null, _conversationId: string): Promise<void> {
    this.log.warn('[persona-switch] Persona system removed — no-op')
  }

  async injectContext(context: string, conversationId: string): Promise<void> {
    const session = this.getActiveSession()
    if (!session?.getWorkspacePath()) {
      this.log.warn('Cannot inject context — agent not started')
      return
    }
    const adapter = this.getActiveAdapter()
    if (!adapter?.addPendingContext) return

    const existingSize = adapter.getPendingContextSize?.(conversationId) ?? 0
    adapter.addPendingContext(conversationId, context)
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
    if (adapter?.setPendingCompaction) {
      if (extractNuance) {
        adapter.setPendingCompaction(
          conversationId,
          '/compact Extract nuance: preserve ALL decisions, preferences, file paths, specialist reports verbatim. Keep recent 3-4 turns verbatim.'
        )
      } else {
        adapter.setPendingCompaction(conversationId, '/compact')
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
        agentId: 'specialist',
        agentType: 'specialist',
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

  /**
   * Route respondToPermission to a specific workspace (for cross-workspace permission flow).
   */
  respondToPermissionForWorkspace(
    workspaceId: string,
    requestId: string,
    approved: boolean,
    input?: unknown
  ): void {
    this.sessions.get(workspaceId)?.session.respondToPermission(requestId, approved, input)
  }

  /**
   * Whether any session is waiting on a human permission decision.
   * Used by the stream watchdogs to distinguish "waiting on a person" from
   * "zombie stream" — the two are indistinguishable from chunk activity alone.
   */
  hasPendingHumanDecision(): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.session.hasHumanDecisionPending()) return true
    }
    return false
  }

  getWorkspacePath(): string | null {
    return this.getActiveSession()?.getWorkspacePath() ?? null
  }

  getCurrentConversationId(): string | null {
    return this.getActiveSession()?.getCurrentConversationId() ?? null
  }

  getStreamedContent(conversationId?: string): string {
    return this.getActiveSession()?.getStreamedContent(conversationId) ?? ''
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
    this.clearConversationPendingState(conversationId)
  }

  /**
   * COMPACT-ABORT-01: Clear only the adapter's per-conversation pending state
   * (compaction, context injection) without touching the session map.
   * Safe to call on abort — the conversation remains resumable.
   */
  clearConversationPendingState(conversationId: string): void {
    this.getActiveAdapter()?.clearConversation?.(conversationId)
  }

  /**
   * Read-only access to the active session's control tool state.
   * Used by chat-stream.service for late plan injection when the plan event
   * arrives via IPC socket after the stream complete event via stdout.
   */
  getControlToolState(): ControlToolState | null {
    return this.getActiveSession()?.getControlToolState() ?? null
  }

  /** Which executor backend is active for the current workspace (cli | local-direct | unknown). */
  getExecutorBackend(): string {
    const wp = this.getActiveSession()?.getWorkspacePath() ?? undefined
    return modelConfigService.getExecutorBackend(wp)
  }

  /** Which role is currently driving the session. */
  getActiveRole(): AgentRole {
    return this.getActiveAdapter()?.role ?? 'specialist'
  }

  /** The agent_id of the currently active adapter. */
  getActiveAgentId(): string {
    return this.getActiveAdapter()?.agentId ?? 'specialist'
  }

  /** The DB role tag for the active adapter. Always 'specialist'. */
  getActiveMessageRole(): 'specialist' {
    return 'specialist'
  }

  /** @deprecated Persona system removed — always returns null. */
  getActivePersona(): { id: string; agentId: string; alias: string | null } | null {
    return null
  }
}

export const chatAgentService = new ChatAgentService()

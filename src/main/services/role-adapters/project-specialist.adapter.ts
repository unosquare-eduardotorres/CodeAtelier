/**
 * ProjectSpecialistRoleAdapter — drives AgentSessionService for a single
 * workspace's Project Specialist.
 *
 * Phase 2 of the Project Specialist refactor.
 *
 * Key differences vs. DaVinciRoleAdapter:
 *   - Bound to exactly one workspace (+ its Project Specialist row).
 *   - No handoff support: specialists never delegate.
 *   - Prompt comes from specialists.prompt (the LLM-tailored build output),
 *     not from a roster / MCP-guidance assembler.
 *   - MCP config comes from specialists.mcp_config (composed by McpComposer)
 *     + skill-declared MCPs (future — currently empty map).
 *   - No control-actions MCP beyond plan + askUser (no handoff, no memory
 *     batching — specialists write memories directly via the Memory tool in
 *     Build mode).
 *   - No persona overlay.
 */

import type { ConversationMode } from '../../../shared/types'
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
import { mcpComposerService, type ComposedMcpConfig } from '../mcp-composer.service'
import { createControlActionsMcpServer } from '../control-actions.tool'
import { codeGraphMcpService } from '../code-graph.tool'
import { semanticSearchMcpService } from '../semantic-search.tool'
import { gitContextMcpService } from '../git-context.tool'
import { taskContextMcpService } from '../task-context.tool'
import { checkpointContextMcpService } from '../checkpoint-context.tool'
import { gitHubContextMcpService } from '../github-context.tool'

interface SpecialistSnapshot {
  id: string
  agentId: string
  displayName: string
  prompt: string
  buildStatus: string
  mcpConfig: ComposedMcpConfig | null
}

export class ProjectSpecialistRoleAdapter implements AgentRoleAdapter {
  readonly role = 'project-specialist' as const
  readonly agentId: string

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private snapshot: SpecialistSnapshot | null = null

  constructor(params: { workspaceId: string; agentId?: string }) {
    this.workspaceId = params.workspaceId
    this.agentId = params.agentId ?? `workspace-specialist-${params.workspaceId}`
  }

  async onSessionStart(_ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.loadSnapshot()
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // Re-read the snapshot — the builder may have updated prompt/mcp_config
    // between sends (skills toggled, prompt rebuilt).
    this.loadSnapshot()
  }

  onConversationSwitch(_conversationId: string): void {
    // Prompt is static per send() — nothing to invalidate. Kept for contract.
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

    return {
      systemPrompt: this.snapshot.prompt,
      effectiveMessage: ctx.message
    }
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    if (!this.snapshot) this.loadSnapshot()

    const isBuildMode = ctx.mode === 'build'
    const enabled = new Set(this.snapshot?.mcpConfig?.enabled ?? [])

    // Allow / disallow lists — plan mode is read-only, build mode allows edits.
    // Concrete tool names mirror DaVinciMcpConfig so the SDK recognises them.
    const allowedTools = isBuildMode
      ? undefined
      : [
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'mcp__control-actions__emit_plan',
          'mcp__control-actions__ask_user',
          'mcp__control-actions__emit_memory'
        ]

    const disallowedTools = isBuildMode
      ? ['Agent', 'ToolSearch', 'ExitPlanMode', 'AskUserQuestion']
      : ['Write', 'Edit', 'ExitPlanMode', 'AskUserQuestion', 'ToolSearch']

    // Always include the control-actions MCP (with handoff disabled for specialists).
    const mcpServers: Record<string, unknown> = {
      ...createControlActionsMcpServer(ctx.controlCallbacks)
    }

    // Add MCPs from the composed snapshot — the builder stored the composed
    // set in specialists.mcp_config. Honoring it here makes user toggles +
    // tech recommendations actually take effect at runtime.
    if (ctx.workspaceId) {
      if (enabled.has('code-graph')) {
        Object.assign(
          mcpServers,
          codeGraphMcpService.getMcpServersConfig(ctx.workspaceId, ctx.workspacePath)
        )
      }
      if (enabled.has('semantic-search')) {
        Object.assign(mcpServers, semanticSearchMcpService.getMcpServersConfig(ctx.workspaceId))
      }
      if (enabled.has('github-context')) {
        Object.assign(
          mcpServers,
          gitHubContextMcpService.getMcpServersConfig(ctx.workspaceId, ctx.workspacePath)
        )
      }
    }
    if (enabled.has('git-context')) {
      Object.assign(mcpServers, gitContextMcpService.getMcpServersConfig(ctx.workspacePath))
    }
    if (ctx.conversationId) {
      if (enabled.has('task-context')) {
        Object.assign(
          mcpServers,
          taskContextMcpService.getMcpServersConfig(ctx.conversationId, ctx.workspacePath)
        )
      }
      if (enabled.has('checkpoint-context')) {
        Object.assign(
          mcpServers,
          checkpointContextMcpService.getMcpServersConfig(ctx.conversationId)
        )
      }
    }

    return { mcpServers, allowedTools, disallowedTools }
  }

  buildControlCallbacks(_params: {
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
      onMemory: (memory) => {
        // Project Specialists persist memories through the same MCP memory tool,
        // but we no-op here — the memory tool writes directly via its own
        // SDK-side handler.
        this.log.debug(
          `[project-specialist] memory hook fired: [${memory.type}] ${memory.title}`
        )
      }
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
    // Specialists never emit handoff/askUser/plan via the legacy regex path —
    // only control-tool MCP events. We simply emit a 'response' intent with the
    // accumulated text so the chat UI has something to persist.
    ctx.emit('intent', {
      type: 'response',
      content: ctx.accumulatedText
    })
  }

  onSessionStop(): void {
    this.snapshot = null
  }

  /** Refresh the cached specialist row from the DB. */
  private loadSnapshot(): void {
    try {
      const db = getDatabase()
      const row = db
        .prepare(
          `SELECT id, agent_id, display_name, prompt, build_status, mcp_config
             FROM specialists WHERE workspace_id = ?`
        )
        .get(this.workspaceId) as
        | {
            id: string
            agent_id: string
            display_name: string
            prompt: string
            build_status: string
            mcp_config: string
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
        buildStatus: row.build_status,
        mcpConfig: mcpComposerService.parseConfig(row.mcp_config)
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

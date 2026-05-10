/**
 * AuditRoleAdapter — drives AgentSessionService for a single workspace health
 * auditor track (e.g. "database", "code", "testing").
 *
 * Key differences vs. chat adapters:
 *   - Single-shot: one message ("Begin your audit.") → one response → done.
 *   - Read-only: write tools are explicitly disallowed.
 *   - No personas, no intent detection, no control-tool callbacks.
 *   - Always runs in 'plan' mode (no build mode).
 *   - Shorter interaction timeout (5 min per auditor).
 *   - MCP servers mounted: code-graph + semantic-search + git-context (NO control-actions).
 */

import type { AuditMode, AuditTrackId, CostPreference } from '../../../shared/types'
import type { RoundContext } from '../audit-prompt-templates'
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
import { workspaceRepository } from '../../db/repositories'
import { codeGraphMcpService } from '../code-graph.tool'
import { semanticSearchMcpService } from '../semantic-search.tool'
import { gitContextMcpService } from '../git-context.tool'
import { codeAnalysisMcpService } from '../code-analysis.tool'
import { renderAuditPrompt } from '../audit-prompt-templates'
import { detectTechStack } from '../tech-stack-detector.service'
import { chatAgentLogger } from '../../logger'
import { appendMcpToolGuidance, type PromptFeatureFlags } from '../prompt-assembly-helpers'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

export class AuditRoleAdapter implements AgentRoleAdapter {
  readonly role = 'audit' as const
  readonly agentId: string
  interactionTimeoutMs = 5 * 60_000 // 5 min per auditor (adjusted for local LLMs in onSessionStart)

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private readonly trackId: AuditTrackId
  private readonly mode: AuditMode
  private readonly skillContent?: string
  private readonly roundContext?: RoundContext

  private readonly llmProvider: import('../../../shared/types').LLMProvider

  private systemPrompt: string | null = null

  // Feature flags read on session start
  private repomapEnabled = false
  private semanticSearchEnabled = false

  constructor(params: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
    skillContent?: string
    roundContext?: RoundContext
    llmProvider?: import('../../../shared/types').LLMProvider
  }) {
    this.workspaceId = params.workspaceId
    this.trackId = params.trackId
    this.mode = params.mode
    this.skillContent = params.skillContent
    this.roundContext = params.roundContext
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `audit-${params.trackId}-${params.workspaceId}`
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Read workspace settings for MCP flags
    try {
      const workspace = workspaceRepository.findById(this.workspaceId)
      if (workspace) {
        const settings = JSON.parse(workspace.settingsJson || '{}')
        this.repomapEnabled = !!settings.repomapEnabled
        this.semanticSearchEnabled = !!settings.semanticSearchEnabled
      }
    } catch {
      /* non-fatal */
    }

    // Increase timeout for local LLMs — they're much slower but still productive.
    // 45 min gives enough headroom to manually observe progress via live stream.
    if (this.llmProvider === 'local-llm') {
      this.interactionTimeoutMs = 45 * 60_000 // 45 min for local LLMs
      this.log.info(`[audit-adapter] Using extended timeout (45 min) for local LLM`)
    }

    // Detect tech stack and build prompt
    const detectedTechs = ctx.workspacePath ? detectTechStack(ctx.workspacePath).detectedTechs : []

    const workspaceName = (() => {
      try {
        const ws = workspaceRepository.findById(this.workspaceId)
        return ws?.name ?? 'Unknown'
      } catch {
        return 'Unknown'
      }
    })()

    this.systemPrompt = renderAuditPrompt({
      trackId: this.trackId,
      workspaceName,
      detectedTechs,
      skillContent: this.skillContent,
      roundContext: this.roundContext
    })

    // Append MCP tool guidance (same as DaVinci/Grill) so the agent knows how to use custom tools
    const featureFlags: PromptFeatureFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: false // auditors don't mount GitHub tools
    }
    this.systemPrompt = appendMcpToolGuidance(this.systemPrompt, 1, featureFlags)

    this.log.info(
      `[audit-adapter] ${this.trackId} audit started for workspace=${this.workspaceId} mode=${this.mode}`
    )
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // No-op — single-shot, no need to refresh mid-audit
  }

  onConversationSwitch(_conversationId: string): void {
    // No-op — auditors don't switch conversations
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `AuditRoleAdapter.buildPrompts() called before onSessionStart() for track=${this.trackId}`
      )
    }
    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: 'Begin your audit.'
    }
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    // Local LLM path — mount code-graph, semantic-search (if enabled), code-analysis.
    // Skip git-context to save tokens (Bash + git CLI equivalent).
    if (this.llmProvider === 'local-llm') {
      const servers: Record<string, McpServerConfig> = {}

      // Code graph (conditional on workspace flag)
      if (this.repomapEnabled && ctx.workspaceId) {
        Object.assign(
          servers,
          codeGraphMcpService.getMcpServersConfig(ctx.workspaceId, ctx.workspacePath)
        )
      }
      // Semantic search (conditional on workspace flag)
      if (this.semanticSearchEnabled && ctx.workspaceId) {
        Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(ctx.workspaceId))
      }
      // Code analysis: always on for audits
      Object.assign(servers, codeAnalysisMcpService.getMcpServersConfig(ctx.workspacePath))

      return {
        ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
        allowedTools: [
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          // Code graph (if mounted)
          ...(this.repomapEnabled && ctx.workspaceId
            ? [
                'mcp__code-graph__graph_map',
                'mcp__code-graph__search_identifiers',
                'mcp__code-graph__find_dead_code',
                'mcp__code-graph__file_outline',
                'mcp__code-graph__find_callers',
                'mcp__code-graph__find_callees',
                'mcp__code-graph__find_references',
                'mcp__code-graph__file_dependencies',
                'mcp__code-graph__file_dependents',
                'mcp__code-graph__symbol_hotspots',
                'mcp__code-graph__coupling_analysis',
                'mcp__code-graph__circular_dependencies',
                'mcp__code-graph__module_boundary_health'
              ]
            : []),
          // Semantic search (if mounted)
          ...(this.semanticSearchEnabled && ctx.workspaceId
            ? [
                'mcp__semantic-search__semantic_search',
                'mcp__semantic-search__similar_code',
                'mcp__semantic-search__codebase_concepts'
              ]
            : []),
          // Code analysis (always)
          'mcp__code-analysis__todo_scanner',
          'mcp__code-analysis__dependency_health',
          'mcp__code-analysis__test_coverage_map'
        ],
        disallowedTools: [
          'Write',
          'Edit',
          'Bash',
          'ListDir',
          'Agent',
          'ToolSearch',
          'ExitPlanMode',
          'AskUserQuestion',
          'TodoWrite'
        ]
      }
    }

    const servers: Record<string, McpServerConfig> = {}

    // Code graph (conditional on workspace flag)
    if (this.repomapEnabled && ctx.workspaceId) {
      Object.assign(
        servers,
        codeGraphMcpService.getMcpServersConfig(ctx.workspaceId, ctx.workspacePath)
      )
    }

    // Semantic search (conditional on workspace flag)
    if (this.semanticSearchEnabled && ctx.workspaceId) {
      Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(ctx.workspaceId))
    }

    // Git context: always on
    Object.assign(servers, gitContextMcpService.getMcpServersConfig(ctx.workspacePath))

    // Code analysis: always on for audits
    Object.assign(servers, codeAnalysisMcpService.getMcpServersConfig(ctx.workspacePath))

    // Read-only — NO control-actions MCP, NO checkpoint-context, NO github-context

    return {
      ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
      // Explicit allow-list: read-only tools only
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        // Code graph MCP tools (if mounted)
        ...(this.repomapEnabled && ctx.workspaceId
          ? [
              'mcp__code-graph__graph_map',
              'mcp__code-graph__search_identifiers',
              'mcp__code-graph__find_dead_code',
              'mcp__code-graph__file_outline',
              'mcp__code-graph__find_callers',
              'mcp__code-graph__find_callees',
              'mcp__code-graph__find_references',
              'mcp__code-graph__file_dependencies',
              'mcp__code-graph__file_dependents',
              'mcp__code-graph__symbol_hotspots',
              'mcp__code-graph__coupling_analysis',
              'mcp__code-graph__circular_dependencies',
              'mcp__code-graph__module_boundary_health'
            ]
          : []),
        // Semantic search (if mounted)
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? [
              'mcp__semantic-search__semantic_search',
              'mcp__semantic-search__similar_code',
              'mcp__semantic-search__codebase_concepts'
            ]
          : []),
        // Git context (always)
        'mcp__git-context__git_log',
        'mcp__git-context__git_diff',
        'mcp__git-context__git_blame',
        // Code analysis (always)
        'mcp__code-analysis__todo_scanner',
        'mcp__code-analysis__dependency_health',
        'mcp__code-analysis__test_coverage_map'
      ],
      // Explicitly block all write + agent tools
      disallowedTools: [
        'Write',
        'Edit',
        'Bash',
        'ListDir',
        'Agent',
        'ToolSearch',
        'ExitPlanMode',
        'AskUserQuestion',
        'TodoWrite' // Prevent audit from modifying todos
      ]
    }
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // No-op — auditors don't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(_ctx: AdapterIntentContext): void {
    // No-op — auditors don't emit intents
  }

  getCompactionThresholds(
    _costPreference: CostPreference
  ): { suggest: number; auto: number } | null {
    return null
  }

  getPersonaId(): string | null {
    return null
  }

  onSessionStop(): void {
    this.systemPrompt = null
    this.repomapEnabled = false
    this.semanticSearchEnabled = false
  }
}

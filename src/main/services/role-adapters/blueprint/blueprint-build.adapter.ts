/**
 * Blueprint Build Adapter — write-mode agent that executes individual BUILD tasks.
 *
 * CLI config: --permission-mode auto, --effort xhigh, --goal "condition"
 *
 * Key difference from other blueprint adapters: this one overrides buildMcpConfig()
 * for full write access (Write, Edit, Bash), matching the mpa-builder.adapter.ts pattern.
 * Each BUILD task gets its own adapter instance with task-specific context injected.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import { TOOL_PRIORITY_DIRECTIVE_BUILDER } from '../../default-prompts'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { PhaseContext } from '../../../../shared/blueprint-types'
import { MCP_TOOLS } from '../../../../shared/constants'

export class BlueprintBuildAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-build'
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly taskContext: string

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    taskContext: string
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.taskContext = params.taskContext
    this.agentId = `blueprint-build-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:build'
  }

  protected buildPhaseSystemPrompt(): string {
    // Build the base phase prompt with context variables injected
    const basePrompt = buildPhaseSystemPrompt('build', this.phaseContext)

    // Append task-specific context so the agent knows exactly which task to implement
    const taskSection = ['', '## Current Task', '', this.taskContext].join('\n')

    // Append TOOL_PRIORITY_DIRECTIVE_BUILDER (write-mode variant).
    // The base class's appendToolGuidance() will skip the generic directive
    // because it checks for '## Tool Priority' already present.
    return basePrompt + taskSection + TOOL_PRIORITY_DIRECTIVE_BUILDER
  }

  getPhaseMessage(): string {
    return [
      'Implement the task described in "Current Task" above.',
      '',
      'Reference the spec and plan from <previous_artifacts> for full context.',
      'Follow the commit protocol: stage files individually, use conventional commits,',
      'reference the task ID in the commit message.',
      '',
      'When done, emit a `blueprint-phase-complete` block with phase: "build".'
    ].join('\n')
  }

  /**
   * BUILD gets full write access — overrides the read-only base config.
   * Follows the mpa-builder.adapter.ts pattern.
   */
  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        // Full read/write
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'WebSearch',
        'WebFetch',
        'ListDir',
        // Code graph tools
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        // Semantic search
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        // Git context
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        // Code analysis
        ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES
      ],
      disallowedTools: ['Agent', 'ToolSearch', 'AskUserQuestion', 'TodoWrite']
    }
  }
}

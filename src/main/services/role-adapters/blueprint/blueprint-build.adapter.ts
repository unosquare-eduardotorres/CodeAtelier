/**
 * Blueprint Build Adapter — write-mode agent that executes individual BUILD tasks.
 *
 * CLI config: --permission-mode acceptEdits (or bypassPermissions when autoMode enabled),
 *             --effort high, goalMode: enforce (/goal via stdin)
 *
 * Key difference from other blueprint adapters: this one overrides buildMcpConfig()
 * for full write access (Write, Edit, Bash), matching the mpa-builder.adapter.ts pattern.
 * Each BUILD task gets its own adapter instance with task-specific context injected.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { PhaseContext } from '../../../../shared/blueprint-types'
import { MCP_TOOLS } from '../../../../shared/constants'
import { appPreferenceRepository } from '../../../db/repositories/app-preference.repository'

export class BlueprintBuildAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-build'
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly taskContext: string
  private readonly modelAction: ModelAction

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    taskContext: string
    /**
     * Overrides the routed model for this one session. Used by the escalation
     * ladder to re-run a gate-failing task on `blueprint:lead-review` — same
     * prompt, same tools, stronger model. Defaults to `blueprint:build`.
     */
    modelAction?: ModelAction
    /** Task under execution — recorded on every usage row for this session. */
    taskId?: string
    /** 1-based position in the builder retry ladder. */
    attempt?: number
  }) {
    super({
      workspaceId: params.workspaceId,
      blueprintId: params.blueprintId,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.attempt != null ? { attempt: params.attempt } : {})
    })
    this.phaseContext = params.phaseContext
    this.taskContext = params.taskContext
    this.modelAction = params.modelAction ?? 'blueprint:build'
    this.agentId = `blueprint-build-${params.blueprintId}`
  }

  protected getModelAction(): ModelAction {
    return this.modelAction
  }

  protected buildPhaseSystemPrompt(): string {
    // Build the base phase prompt with context variables injected
    const basePrompt = buildPhaseSystemPrompt('build', this.phaseContext)

    // Phase 1.2: Maximize prompt-prefix cache hits. All tasks in a run share the
    // longest identical prefix (the whole base prompt); only the task-specific
    // section differs at the end, enabling KV-cache reuse across tasks (for
    // providers that support prefix caching).
    //
    // E7: `TOOL_PRIORITY_DIRECTIVE_BUILDER` used to be concatenated here, which
    // gave the pipeline's most expensive phase TWO overlapping `## Tool Priority`
    // sections in that shared prefix, re-sent on every one of ~31 calls per
    // attempt. build-phase.md already carries a fuller routing table, so the
    // directive's non-redundant parts (file_outline/find_references ordering,
    // inspection-vs-execution, the typecheck rung) were folded into the template
    // and the concatenation dropped. The prefix shape is unchanged — just shorter.
    // The constant itself stays: mpa-builder.adapter.ts is its other consumer.
    //
    // The base class's appendToolGuidance() still skips the generic directive
    // because build-phase.md's own '## Tool Priority' heading satisfies its check.
    const taskSection = ['', '## Current Task', '', this.taskContext].join('\n')

    return basePrompt + taskSection
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
   *
   * Phase 1.3: When `leanBuildMcp` preference is enabled, semantic-search and
   * code-analysis tools are omitted. This saves 2 node child processes per task
   * (and ~2-4K tokens of tool schemas), at the cost of those capabilities.
   * Gate defaults to OFF (full MCP) — flip after timing data confirms benefit.
   */
  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    const lean = appPreferenceRepository.getAppPreferences().leanBuildMcp

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
        // Code graph tools (always — primary intelligence layer)
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        // Semantic search (skipped in lean mode — saves 1 process + ~600 token schema)
        ...(!lean && this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        // Git context (always — commit protocol depends on it)
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        // Code analysis (skipped in lean mode — saves 1 process + ~1.5K token schemas)
        ...(!lean ? MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES : []),
        // Memory tools — phase prompts instruct memory_search/memory_record usage
        ...(ctx.workspaceId ? MCP_TOOLS.MEMORY._ALL_NAMES : [])
      ],
      disallowedTools: ['Agent', 'ToolSearch', 'AskUserQuestion', 'TodoWrite']
    }
  }
}

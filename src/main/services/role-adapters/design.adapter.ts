/**
 * DesignRoleAdapter — drives `AgentSessionService` for a single Impeccable
 * evaluate command (`audit` or `critique`).
 *
 * Operationally identical to `AuditRoleAdapter`: read-only, plan mode, no
 * personas, no intent detection, and the same ` ```audit-finding ` output
 * contract. The only difference is the system prompt, which carries the
 * Impeccable knowledge layer and the user's design brief.
 *
 * ── Why `role = 'audit'` rather than a new `'design'` role ───────────────────
 * `AgentRole` feeds `resolveModelAction(role, isBuildMode)`, which would derive
 * a non-existent `'design:plan'` action for a new role and silently fall back.
 * A design pass IS an audit in every operational sense the session layer cares
 * about, and sharing a role across adapters is already established here — four
 * blueprint adapters share `'blueprint-review'`. The model is still routed
 * through the dedicated `design:audit` action below, so the Design rows in
 * model settings control it exactly as the user expects.
 */

import type { DesignCommandId, LLMProvider, ModelAction } from '../../../shared/types'
import type {
  AdapterIntentContext,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { workspaceRepository } from '../../db/repositories'
import { getDesignCommand } from '../../../shared/design-commands'
import { detectTechStack } from '../tech-stack-detector.service'
import {
  buildImpeccableLayer,
  renderDesignPrompt,
  type DesignRoundContext
} from '../design-prompt-templates'
import { BaseRoleAdapter, type McpStrategy } from './base.adapter'

export interface DesignAdapterParams {
  workspaceId: string
  commandId: DesignCommandId
  brief: string
  scopeMode: 'project' | 'paths'
  scopePaths: string[]
  refineCommands: string[]
  productMd?: string
  designMd?: string
  detectorSummary?: string
  roundContext?: DesignRoundContext
  llmProvider?: LLMProvider
}

export class DesignRoleAdapter extends BaseRoleAdapter {
  readonly role = 'audit' as const
  readonly agentId: string
  /** 5 min per command, matching the audit adapter. Extended for local LLMs. */
  interactionTimeoutMs = 5 * 60_000

  private readonly params: DesignAdapterParams
  private readonly llmProvider: LLMProvider

  private systemPrompt: string | null = null

  constructor(params: DesignAdapterParams) {
    super()
    this.params = params
    this.llmProvider = params.llmProvider ?? 'claude'
    this.explicitLlmProvider = params.llmProvider
    this.agentId = `design-${params.commandId}-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.refreshWorkspaceFeatureFlags(this.params.workspaceId)
    this.applyLocalLlmTimeout(this.llmProvider)

    const detectedTechs = ctx.workspacePath ? detectTechStack(ctx.workspacePath).detectedTechs : []

    const workspaceName = (() => {
      try {
        return workspaceRepository.findById(this.params.workspaceId)?.name ?? 'Unknown'
      } catch {
        return 'Unknown'
      }
    })()

    // Routed through `design:audit`, so the Design section of model settings
    // controls which model runs an evaluate command.
    const resolvedModel = this.resolveModel(ctx.workspacePath, 'design:audit')

    const command = getDesignCommand(this.params.commandId)

    this.systemPrompt = renderDesignPrompt({
      commandId: this.params.commandId,
      commandName: command?.name ?? this.params.commandId,
      commandDescription: command?.description ?? '',
      workspaceName,
      detectedTechs,
      brief: this.params.brief,
      scopeMode: this.params.scopeMode,
      scopePaths: this.params.scopePaths,
      refineCommands: this.params.refineCommands,
      impeccableLayer: buildImpeccableLayer(this.params.commandId),
      productMd: this.params.productMd,
      designMd: this.params.designMd,
      detectorSummary: this.params.detectorSummary,
      roundContext: this.params.roundContext
    })

    this.systemPrompt = this.appendToolGuidance(this.systemPrompt, 1, resolvedModel)

    this.log.info(
      `[design-adapter] ${this.params.commandId} started for workspace=${this.params.workspaceId} ` +
        `scope=${this.params.scopeMode}`
    )
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `DesignRoleAdapter.buildPrompts() called before onSessionStart() for command=${this.params.commandId}`
      )
    }
    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: 'Begin your design review.'
    }
  }

  /**
   * Route on `design:audit` rather than on the action derived from `role`.
   *
   * `role` is `'audit'` (see the header note), so without this override
   * `resolveAdapterModelAction` falls back to `resolveModelAction('audit', …)`
   * and every design run resolves through the Workspace Health audit entry —
   * making the Design → Evaluate row in model settings decorative. Mirrors
   * `BlueprintBaseAdapter.getUsageModelAction()`, which exists for the same
   * reason: several adapters share one role, so the action must be declared.
   */
  override getUsageModelAction(): ModelAction {
    return 'design:audit'
  }

  protected override getMcpStrategy(): McpStrategy {
    return 'readonly'
  }

  protected override getIncludeGitContext(): boolean {
    return this.llmProvider !== 'local-llm'
  }

  /** No-op — design evaluations don't emit intents. */
  override emitDetectedIntents(_ctx: AdapterIntentContext): void {
    /* no-op */
  }

  override onSessionStop(): void {
    this.systemPrompt = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
  }
}

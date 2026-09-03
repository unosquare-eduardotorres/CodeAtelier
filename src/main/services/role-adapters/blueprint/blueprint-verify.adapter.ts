/**
 * Blueprint Verify Adapter — read-only + Bash agent that performs adversarial verification.
 *
 * CLI config: --permission-mode acceptEdits (or bypassPermissions when autoMode enabled),
 *             --effort high, goalMode: enforce (/goal via stdin)
 *
 * Key difference from other blueprint adapters: overrides buildMcpConfig() to add
 * Bash + ListDir while keeping Write/Edit disabled. The verify prompt calls for
 * "limited testing commands" — Bash is needed to run npm test, npx tsc, etc.
 */

import { BlueprintBaseAdapter } from './blueprint-base.adapter'
import { buildPhaseSystemPrompt } from '../../blueprint-prompt-loader'
import type { AgentRole, ModelAction } from '../../../../shared/types'
import type { AdapterMcpContext, AdapterMcpResult } from '../../agent-session.types'
import type { PhaseContext } from '../../../../shared/blueprint-types'
import { MCP_TOOLS } from '../../../../shared/constants'

/**
 * E3 — cap for the diff prepended to VERIFY's first message.
 *
 * 30 K, NOT the reviews' 120 K. This lands in the very first message of a phase
 * that also runs on small-window local models; 120 K would overflow the context
 * before the agent had read the instructions.
 */
const VERIFY_DIFF_MAX_CHARS = 30_000

/**
 * Framing that fights the anchoring risk head-on. A diff shows what was
 * WRITTEN, while levels 1–2 of verify's own methodology are about what is
 * MISSING — so handing it a diff without this sentence trades thoroughness for
 * speed and reports the trade as a higher pass rate.
 */
const DIFF_PREAMBLE =
  'The diff below is what BUILD changed. Use it to orient, not to scope — ' +
  'a requirement with no diff hunk is a finding, not an absence of evidence.'

export class BlueprintVerifyAdapter extends BlueprintBaseAdapter {
  readonly role: AgentRole = 'blueprint-verify'
  readonly agentId: string

  private readonly phaseContext: PhaseContext
  private readonly workspacePath: string | null

  constructor(params: {
    workspaceId: string
    blueprintId: string
    phaseContext: PhaseContext
    /** E3 — required for the optional feature-diff injection; null disables it. */
    workspacePath?: string | null
  }) {
    super({ workspaceId: params.workspaceId, blueprintId: params.blueprintId })
    this.phaseContext = params.phaseContext
    this.workspacePath = params.workspacePath ?? null
    this.agentId = `blueprint-verify-${params.blueprintId}`
  }

  /**
   * E3 — the feature diff, or '' when the flag is off, the path is unknown, or
   * git has nothing to say. Flag-gated and default OFF: see
   * `AppPreferences.verifyFeatureDiff`.
   */
  /**
   * Is the injection switched on? Overridable seam — the module is loaded
   * lazily and its ESM namespace is frozen, so a test cannot patch the export.
   */
  protected verifyDiffEnabled(): boolean {
    try {
      const {
        appPreferenceRepository
      } = require('../../../db/repositories/app-preference.repository')
      return appPreferenceRepository.getAppPreferences().verifyFeatureDiff === true
    } catch {
      return false // preferences unavailable — behave as if off
    }
  }

  /** The diff itself. Same seam rationale as `verifyDiffEnabled`. */
  protected loadFeatureDiff(): string | null {
    if (!this.workspacePath) return null
    try {
      return require('../../blueprint-feature-diff').assembleFeatureDiff(
        this.blueprintId,
        this.workspacePath,
        VERIFY_DIFF_MAX_CHARS
      )
    } catch {
      return null // git unavailable — behave as if there is no diff
    }
  }

  private featureDiffSection(): string[] {
    if (!this.workspacePath) return []
    if (!this.verifyDiffEnabled()) return []

    const diff = this.loadFeatureDiff()
    // null = no baseline / git failed; '' = clean tree. Neither is worth a
    // section, and an empty one would read as "BUILD changed nothing".
    if (!diff) return []

    return ['', DIFF_PREAMBLE, '', '```diff', diff, '```']
  }

  protected getModelAction(): ModelAction {
    return 'blueprint:verify'
  }

  protected buildPhaseSystemPrompt(): string {
    return buildPhaseSystemPrompt('verify', this.phaseContext)
  }

  getPhaseMessage(): string {
    // The diff section is spread, not inserted: with the flag off it is an empty
    // array and the message is byte-for-byte what it was before E3.
    const diffSection = this.featureDiffSection()
    return [
      'Begin adversarial verification of the BUILD phase output.',
      ...diffSection,
      '',
      'Apply the 4-level artifact verification methodology:',
      '1. EXISTS — file present at expected path',
      '2. SUBSTANTIVE — real implementation, not stubs',
      '3. WIRED — imported and used by other code',
      '4. DATA FLOWING — real data traverses the wiring',
      '',
      'Scan for anti-patterns, verify all key links from the plan,',
      'trace each spec requirement to code, and run tests if available.',
      '',
      'MANDATORY: End your response with a ```blueprint-phase-complete fence block.',
      'The block must be valid JSON containing at minimum:',
      '  "phase": "verify", "status": "complete",',
      '  "overallStatus": "passed" | "gaps_found" | "human_needed"',
      'This block is required — without it, automated remediation cannot trigger.'
    ].join('\n')
  }

  /**
   * VERIFY gets read-only + Bash + ListDir (for test execution and directory traversal).
   * Write/Edit remain disabled — verification doesn't modify code.
   */
  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'Bash', // For running tests + inspection commands
        'ListDir', // For directory traversal verification
        'WebSearch',
        'WebFetch',
        // Code graph tools
        ...(this.repomapEnabled && ctx.workspaceId ? MCP_TOOLS.CODE_GRAPH._ALL_NAMES : []),
        // Semantic search
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
          : []),
        // Git context
        ...MCP_TOOLS.GIT_CONTEXT._ALL_NAMES,
        // Code analysis
        ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
        // Memory tools — phase prompts instruct memory_search/memory_record usage
        ...(ctx.workspaceId ? MCP_TOOLS.MEMORY._ALL_NAMES : [])
      ],
      disallowedTools: [
        'Write',
        'Edit',
        'Agent',
        'ToolSearch',
        'ExitPlanMode',
        'AskUserQuestion',
        'TodoWrite',
        'TaskCreate',
        'TaskUpdate'
      ]
    }
  }
}

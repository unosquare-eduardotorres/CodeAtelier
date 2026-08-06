import { z } from 'zod'
import type { StructuredPlan, GrillQuestion, PhaseProgressEvent } from '../../shared/types'

/**
 * Event callback signatures for control tool actions.
 * Registered by the chat-agent adapter layer. There is no handoff callback —
 * specialists don't delegate, they execute directly.
 *
 * The actual MCP server is externalized in src/main/mcp-servers/control-actions-server.ts
 * and communicates with the main process via the IPC bridge (Unix domain socket).
 */
export interface ControlActionCallbacks {
  onPlan: (plan: StructuredPlan) => void
  /**
   * `action` is an optional programmatic tag emitted by the ask_user tool.
   * The renderer maps known action tags to custom handling when the user
   * accepts the proposal. Undefined for plain Q&A.
   *
   * `requestId` correlates the question with the user's response over the IPC
   * bridge. The production CLI path supplies it via `bridge.on('askUser')`;
   * the in-process callback path forwards it here so the answer can route back
   * to the waiting ask_user promise. Undefined when no round-trip is wired.
   */
  onAskUser: (questions: GrillQuestion[], action?: string, requestId?: string) => void
  /** Called when the agent reports plan phase progress via emit_phase_progress */
  onPhaseProgress?: (progress: PhaseProgressEvent) => void
  // onMemory removed — memory tools now live on the dedicated memory MCP server
}

// -- Zod Schemas (reusable for tests) --

export const planSchema = z.object({
  type: z
    .enum(['bug', 'feature', 'refactor', 'audit', 'investigation'])
    .optional()
    .describe(
      'Plan classification: bug (fix/diagnostic), feature (new capability), ' +
        'refactor (restructure), audit (analysis), investigation (root cause)'
    ),
  title: z.string().describe('Short title for the plan (shown as card header)'),
  summary: z.string().describe('1-3 sentence overview of the plan'),
  goal: z
    .string()
    .optional()
    .describe(
      'Clear, measurable completion condition defining what "done" looks like. ' +
        'Example: "All 3 phases complete, retry middleware tested with >80% coverage, ' +
        'no regressions in existing tests"'
    ),
  problemSummary: z.string().optional().describe('For diagnostic plans: what problem was found'),
  rootCause: z.string().optional().describe('For diagnostic plans: single root cause analysis'),
  decisions: z
    .array(
      z.object({
        what: z.string(),
        why: z.string()
      })
    )
    .optional()
    .describe('Key design decisions made'),
  rootCauses: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string(),
        symptom: z.string().optional().describe('Which user-visible symptom this explains')
      })
    )
    .optional()
    .describe('For bugs: numbered root causes, each explaining a user-visible symptom'),
  verification: z
    .array(z.string())
    .optional()
    .describe(
      'Post-implementation verification steps — numbered acceptance criteria ' +
        'that can be manually tested'
    ),
  phases: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        complexity: z.number().min(1).max(10).describe('Complexity score 1-10'),
        fileCount: z.number().optional(),
        risk: z.enum(['low', 'medium', 'high']),
        description: z.string(),
        files: z
          .array(
            z.object({
              file: z.string(),
              change: z.string()
            })
          )
          .optional()
      })
    )
    .optional()
    .describe(
      'For complex features/refactors: phased breakdown with complexity 1-10, file count, risk level'
    ),
  currentState: z
    .string()
    .optional()
    .describe('For audits/features: description of the current state / the problem being solved'),
  implementationOrder: z
    .array(z.number())
    .optional()
    .describe('Recommended phase execution order by phase ID'),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        icon: z.string().optional(),
        content: z.string().describe('Markdown content for this section'),
        mermaid: z.string().optional().describe('Optional mermaid diagram for this section')
      })
    )
    .optional()
    .describe('Markdown content sections with optional mermaid diagrams'),
  steps: z
    .array(
      z.object({
        description: z.string(),
        file: z.string().optional(),
        change: z.string().optional()
      })
    )
    .optional()
    .describe('Flat list of steps (use sections OR steps, not both)'),
  files: z.array(z.string()).optional().describe('List of files affected'),
  filesChanged: z
    .array(
      z.object({
        file: z.string(),
        change: z.string()
      })
    )
    .optional()
    .describe('Files with change descriptions'),
  risks: z
    .array(
      z.object({
        risk: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        mitigation: z.string().optional()
      })
    )
    .optional(),
  expectedOutcome: z.string().optional(),
  deferredItems: z.array(z.string()).optional(),
  diagrams: z
    .array(
      z.object({
        title: z.string(),
        mermaid: z.string()
      })
    )
    .optional()
})

export const emitMemorySchema = z.object({
  type: z
    .enum(['user', 'feedback', 'project', 'reference'])
    .describe(
      'Memory type: user (preferences), feedback (corrections), project (architecture), reference (links/docs)'
    ),
  title: z.string().min(1).describe('Short title for the memory'),
  content: z.string().min(1).describe('What to remember — be specific and actionable')
})

export const askUserSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe('The question text'),
        header: z.string().optional().describe('Section header for grouping'),
        options: z
          .array(
            z.object({
              label: z.string(),
              description: z.string().optional()
            })
          )
          .optional()
          .describe('Multiple choice options (omit for free-form)')
      })
    )
    .describe('One or more clarifying questions'),
  action: z
    .string()
    .optional()
    .describe(
      'Optional programmatic action tag for the renderer. Omit for plain clarifying questions.'
    )
})

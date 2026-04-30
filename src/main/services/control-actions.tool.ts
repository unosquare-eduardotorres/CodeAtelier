import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import type { StructuredPlan, GrillQuestion, MemoryType } from '../../shared/types'

const controlLog = log.scope('ControlActions')

/**
 * Event callback signatures for control tool actions.
 * Registered by the chat-agent adapter layer. There is no handoff callback —
 * specialists don't delegate, they execute directly.
 */
export interface ControlActionCallbacks {
  onPlan: (plan: StructuredPlan) => void
  /**
   * `action` is an optional programmatic tag emitted by the ask_user tool
   * (e.g. "swap-to-specialist"). The renderer maps known action tags to IPC
   * calls when the user accepts the proposal. Undefined for plain Q&A.
   */
  onAskUser: (questions: GrillQuestion[], action?: string) => void
  onMemory: (memory: { type: MemoryType; title: string; content: string }) => void
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
      'Optional programmatic action tag for the renderer. Known values: ' +
        '"swap-to-specialist" — when the user picks the first option, the ' +
        'renderer will swap the workspace adapter to the ready Project ' +
        'Specialist. Omit for plain clarifying questions.'
    )
})

/**
 * Creates the control-actions MCP server config.
 *
 * No handoff tool and no mode gating — the remaining tools
 * (emit_plan / ask_user / emit_memory) are available in both modes.
 *
 * @param callbacks Event handlers called when the LLM invokes a control tool
 */
export function createControlActionsMcpServer(
  callbacks: ControlActionCallbacks
): Record<string, McpServerConfig> {
  const tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, z.ZodType>
    handler: (
      args: Record<string, unknown>
    ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }> = []

  // emit_plan — available in BOTH modes
  tools.push({
    name: MCP_TOOLS.CONTROL_ACTIONS.EMIT_PLAN.tool,
    description:
      'Emit a structured plan, proposal, or investigation findings. ' +
      'The UI renders this as an interactive card with Build Now / Refine buttons. ' +
      'Use this instead of writing plan text — only tool-emitted plans are actionable.',
    inputSchema: planSchema.shape as unknown as Record<string, z.ZodType>,
    handler: async (args) => {
      const plan = planSchema.parse(args) as StructuredPlan
      controlLog.info(
        `[control:emit_plan] title="${plan.title}" steps=${plan.steps?.length ?? plan.sections?.length ?? 0}`
      )
      callbacks.onPlan(plan)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Plan "${plan.title}" emitted successfully. The user can see it as an interactive card.`
          }
        ]
      }
    }
  })

  // ask_user — available in BOTH modes
  tools.push({
    name: MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.tool,
    description:
      'Ask the user one or more clarifying questions before proceeding. ' +
      'The UI renders these as an interactive question card. ' +
      'Use when the request is ambiguous or multiple valid approaches exist.',
    inputSchema: askUserSchema.shape as unknown as Record<string, z.ZodType>,
    handler: async (args) => {
      const { questions, action } = askUserSchema.parse(args)
      controlLog.info(
        `[control:ask_user] questionCount=${questions.length} action=${action ?? 'none'}`
      )
      callbacks.onAskUser(
        questions.map((q) => ({
          ...q,
          id: (q as Record<string, unknown>).id ?? crypto.randomUUID(),
          options: q.options ?? []
        })) as GrillQuestion[],
        action
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: `Questions sent to user. Wait for their response before continuing.`
          }
        ]
      }
    }
  })

  // emit_memory — available in BOTH modes
  tools.push({
    name: MCP_TOOLS.CONTROL_ACTIONS.EMIT_MEMORY.tool,
    description:
      'Persist a memory for future sessions. ' +
      'Use for: user preferences, corrections to your approach, architecture decisions, reference material. ' +
      'Do NOT use for transient discussion or info already in CLAUDE.md.',
    inputSchema: emitMemorySchema.shape as unknown as Record<string, z.ZodType>,
    handler: async (args) => {
      const memory = emitMemorySchema.parse(args)
      controlLog.info(`[control:emit_memory] type="${memory.type}" title="${memory.title}"`)
      callbacks.onMemory(memory)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory saved: [${memory.type}] ${memory.title}`
          }
        ]
      }
    }
  })

  const config = createSdkMcpServer({
    name: MCP_TOOLS.CONTROL_ACTIONS._SERVER,
    version: '1.0.0',
    tools
  })

  return { 'control-actions': config }
}

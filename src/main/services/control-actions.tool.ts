import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import type { StructuredPlan, HandoffBrief, GrillQuestion, MemoryType } from '../../shared/types'

const controlLog = log.scope('ControlActions')

/**
 * Event callback signatures for control tool actions.
 * The generalist service registers handlers for these.
 */
export interface ControlActionCallbacks {
  onPlan: (plan: StructuredPlan) => void
  onHandoff: (brief: HandoffBrief) => void
  onAskUser: (questions: GrillQuestion[]) => void
  onMemory: (memory: { type: MemoryType; title: string; content: string }) => void
}

// -- Zod Schemas (reusable for tests) --

export const planSchema = z.object({
  title: z.string().describe('Short title for the plan (shown as card header)'),
  summary: z.string().describe('1-3 sentence overview of the plan'),
  problemSummary: z.string().optional().describe('For diagnostic plans: what problem was found'),
  rootCause: z.string().optional().describe('For diagnostic plans: root cause analysis'),
  decisions: z
    .array(
      z.object({
        what: z.string(),
        why: z.string()
      })
    )
    .optional()
    .describe('Key design decisions made'),
  sections: z
    .array(
      z.object({
        title: z.string(),
        steps: z.array(
          z.object({
            description: z.string(),
            file: z.string().optional(),
            change: z.string().optional()
          })
        )
      })
    )
    .optional()
    .describe('Grouped steps by section/phase'),
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
        severity: z.enum(['low', 'medium', 'high']),
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

export const handoffSchema = z.object({
  specialist: z
    .string()
    .describe('The specialist ID to hand off to (e.g. "platform-architect")'),
  summary: z
    .string()
    .describe('What the specialist should do — actionable description'),
  mode: z
    .enum(['plan', 'build'])
    .optional()
    .describe('Execution mode (default: current mode)'),
  decisions: z
    .array(z.string())
    .optional()
    .describe('Key decisions already made'),
  constraints: z
    .array(z.string())
    .optional()
    .describe('Constraints the specialist must follow'),
  filesDiscussed: z
    .array(z.string())
    .optional()
    .describe('Files already read/discussed')
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
    .describe('One or more clarifying questions')
})

/**
 * Creates the control-actions MCP server config.
 *
 * @param mode Current conversation mode — determines which tools are available
 * @param callbacks Event handlers called when the LLM invokes a control tool
 * @param investigationModeEnabled Whether specialist handoffs are enabled
 */
export function createControlActionsMcpServer(
  mode: 'plan' | 'build',
  callbacks: ControlActionCallbacks,
  investigationModeEnabled: boolean
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

  // request_handoff — ONLY in build mode AND investigation mode enabled
  if (mode === 'build' && investigationModeEnabled) {
    tools.push({
      name: MCP_TOOLS.CONTROL_ACTIONS.REQUEST_HANDOFF.tool,
      description:
        'Hand off a task to a specialist agent for code changes, deep investigation, or execution. ' +
        'Only use when the task requires specialist expertise. ' +
        'For simple questions, answer directly without handing off.',
      inputSchema: handoffSchema.shape as unknown as Record<string, z.ZodType>,
      handler: async (args) => {
        const brief = handoffSchema.parse(args)
        controlLog.info(
          `[control:request_handoff] specialist="${brief.specialist}" summary="${brief.summary.substring(0, 80)}"`
        )
        callbacks.onHandoff(brief as HandoffBrief)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Handoff to ${brief.specialist} initiated.`
            }
          ]
        }
      }
    })
  }

  // ask_user — available in BOTH modes
  tools.push({
    name: MCP_TOOLS.CONTROL_ACTIONS.ASK_USER.tool,
    description:
      'Ask the user one or more clarifying questions before proceeding. ' +
      'The UI renders these as an interactive question card. ' +
      'Use when the request is ambiguous or multiple valid approaches exist.',
    inputSchema: askUserSchema.shape as unknown as Record<string, z.ZodType>,
    handler: async (args) => {
      const { questions } = askUserSchema.parse(args)
      controlLog.info(`[control:ask_user] questionCount=${questions.length}`)
      callbacks.onAskUser(questions as GrillQuestion[])
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

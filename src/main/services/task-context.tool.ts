import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import { taskArtifactService } from './task-artifact.service'

const taskLog = log.scope('TaskContext')

/**
 * Manages per-conversation MCP servers that expose `list_tasks` and `get_task_output`
 * tools to the Claude Agent SDK. All tools are read-only.
 *
 * Used by: Generalist only (specialists receive dependency outputs via prompt injection).
 * Keyed by conversationId since tasks are per-conversation.
 */
class TaskContextMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given conversation.
   * Exposes `list_tasks` and `get_task_output` tools backed by task artifacts.
   */
  getMcpServersConfig(
    conversationId: string,
    workspacePath: string
  ): Record<string, McpServerConfig> {
    const key = `${conversationId}:${workspacePath}`
    let config = this.servers.get(key)
    if (config) return { 'task-context': config }

    config = createSdkMcpServer({
      name: MCP_TOOLS.TASK_CONTEXT._SERVER,
      version: '1.0.0',
      tools: [
        {
          name: MCP_TOOLS.TASK_CONTEXT.LIST_TASKS.tool,
          description:
            'Get the current task plan state for this conversation. Returns task IDs, ' +
            'specialist assignments, statuses (pending/running/completed/failed), and dependencies. ' +
            'Use to understand execution progress and task ordering.',
          inputSchema: {},
          handler: async () => {
            try {
              const state = await taskArtifactService.readPlanState(workspacePath, conversationId)

              if (!state) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'No active task plan found for this conversation.'
                    }
                  ]
                }
              }

              taskLog.info(
                `list_tasks: ${state.tasks.length} tasks (conversation: ${conversationId.slice(0, 8)})`
              )
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              taskLog.error('list_tasks failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error reading task plan: ${msg}` }]
              }
            }
          }
        },
        {
          name: MCP_TOOLS.TASK_CONTEXT.GET_TASK_OUTPUT.tool,
          description:
            'Read the output artifact from a completed specialist task. Returns the ' +
            'specialist result (capped at 4,000 characters). Use to review what a ' +
            'specialist produced without re-running the task.',
          inputSchema: {
            taskId: z.string().describe('Task ID to read output for (e.g. "task-1")')
          },
          handler: async (args) => {
            try {
              const taskId = args.taskId as string
              const output = await taskArtifactService.readTaskOutput(
                workspacePath,
                conversationId,
                taskId
              )

              if (!output) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `No output found for task "${taskId}". It may not have completed yet.`
                    }
                  ]
                }
              }

              // Cap output at 4,000 characters to stay within token budget
              const MAX_OUTPUT_CHARS = 4000
              const truncated = output.length > MAX_OUTPUT_CHARS
              const result = truncated
                ? output.slice(0, MAX_OUTPUT_CHARS) +
                  `\n\n[Truncated - ${output.length - MAX_OUTPUT_CHARS} more characters]`
                : output

              taskLog.info(
                `get_task_output: ${taskId} (${output.length} chars${truncated ? ', truncated' : ''})`
              )
              return { content: [{ type: 'text' as const, text: result }] }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              taskLog.error('get_task_output failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error reading task output: ${msg}` }]
              }
            }
          }
        }
      ]
    })

    this.servers.set(key, config)
    return { 'task-context': config }
  }

  dispose(conversationId: string, workspacePath: string): void {
    this.servers.delete(`${conversationId}:${workspacePath}`)
  }
}

export const taskContextMcpService = new TaskContextMcpService()

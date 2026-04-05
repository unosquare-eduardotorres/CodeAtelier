import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { checkpointService } from './checkpoint.service'

const cpLog = log.scope('CheckpointContext')

/**
 * Manages per-conversation MCP servers that expose `list_checkpoints` and `get_checkpoint`
 * tools to the Claude Agent SDK. All tools are read-only — does NOT expose restoreGitState
 * (that's a destructive action that goes through UI/IPC).
 *
 * Used by: Generalist only (only the orchestrator should decide rollback).
 * Keyed by conversationId.
 */
class CheckpointContextMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given conversation.
   * Exposes `list_checkpoints` and `get_checkpoint` tools backed by checkpointService.
   */
  getMcpServersConfig(conversationId: string): Record<string, McpServerConfig> {
    let config = this.servers.get(conversationId)
    if (config) return { 'checkpoint-context': config }

    config = createSdkMcpServer({
      name: 'checkpoint-context',
      version: '1.0.0',
      tools: [
        {
          name: 'list_checkpoints',
          description:
            'List all checkpoints for this conversation. Returns checkpoint IDs, labels, ' +
            'git branch/SHA, and timestamps. Use to see available rollback points.',
          inputSchema: {},
          handler: async () => {
            try {
              const checkpoints = checkpointService.listCheckpoints(conversationId)

              if (checkpoints.length === 0) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'No checkpoints found for this conversation.'
                    }
                  ]
                }
              }

              cpLog.info(
                `list_checkpoints: ${checkpoints.length} checkpoints (conversation: ${conversationId.slice(0, 8)})`
              )
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(checkpoints, null, 2)
                  }
                ]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              cpLog.error('list_checkpoints failed:', msg)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Error listing checkpoints: ${msg}`
                  }
                ]
              }
            }
          }
        },
        {
          name: 'get_checkpoint',
          description:
            'Get the full state of a checkpoint — task statuses, git state, and metadata. ' +
            'Use to inspect what the system state was at a specific point. ' +
            'NOTE: This is read-only. To restore, use the UI rollback action.',
          inputSchema: {
            checkpointId: z.string().describe('Checkpoint ID to retrieve')
          },
          handler: async (args) => {
            try {
              const checkpointId = args.checkpointId as string
              const checkpoint = checkpointService.getCheckpoint(checkpointId)

              if (!checkpoint) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Checkpoint "${checkpointId}" not found.`
                    }
                  ]
                }
              }

              const result = {
                gitBranch: checkpoint.gitBranch,
                gitCommitSha: checkpoint.gitCommitSha,
                activeTaskIds: checkpoint.state.activeTaskIds,
                completedTaskIds: checkpoint.state.completedTaskIds,
                taskStatuses: checkpoint.state.taskStatuses,
                taskResults: checkpoint.state.taskResults
              }

              cpLog.info(`get_checkpoint: ${checkpointId}`)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              cpLog.error('get_checkpoint failed:', msg)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Error reading checkpoint: ${msg}`
                  }
                ]
              }
            }
          }
        }
      ]
    })

    this.servers.set(conversationId, config)
    return { 'checkpoint-context': config }
  }

  dispose(conversationId: string): void {
    this.servers.delete(conversationId)
  }
}

export const checkpointContextMcpService = new CheckpointContextMcpService()

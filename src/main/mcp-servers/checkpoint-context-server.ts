#!/usr/bin/env node
/**
 * Checkpoint Context MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: checkpoint_list, checkpoint_diff
 * Provides conversation-scoped file checkpoint management.
 *
 * Environment variables:
 *   CONVERSATION_ID — Active conversation UUID
 *   WORKSPACE_PATH  — Absolute workspace path
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const CONVERSATION_ID = process.env.CONVERSATION_ID ?? ''
void process.env.WORKSPACE_PATH // Reserved for future use

if (!CONVERSATION_ID) {
  console.error('[checkpoint-context-server] ERROR: CONVERSATION_ID is required')
  process.exit(1)
}

const server = new McpServer(
  { name: 'checkpoint-context', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function registerTools(): Promise<void> {
  server.tool(
    'checkpoint_list',
    'List file checkpoints for the current conversation.',
    {},
    async () => {
      // Delegate to in-process service
      return {
        content: [
          {
            type: 'text' as const,
            text: `[checkpoint_list] conversation=${CONVERSATION_ID} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'checkpoint_diff',
    'Show diff between current file state and a checkpoint.',
    {
      filePath: z.string().describe('File path to diff'),
      checkpointId: z.string().optional().describe('Checkpoint to diff against (default: latest)')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[checkpoint_diff] file=${args.filePath} checkpoint=${args.checkpointId ?? 'latest'} — delegating to in-process service`
          }
        ]
      }
    }
  )
}

async function main(): Promise<void> {
  await registerTools()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[checkpoint-context-server] Started (conversation=${CONVERSATION_ID})`)
}

main().catch((err) => {
  console.error('[checkpoint-context-server] Fatal:', err)
  process.exit(1)
})

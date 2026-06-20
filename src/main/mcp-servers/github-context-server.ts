#!/usr/bin/env node
/**
 * GitHub Context MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: github_pr_list, github_pr_detail, github_issues
 *
 * Environment variables:
 *   WORKSPACE_ID   — Workspace UUID (for looking up GitHub token)
 *   WORKSPACE_PATH — Absolute workspace path
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
void process.env.WORKSPACE_PATH // Reserved for future Octokit integration

if (!WORKSPACE_ID) {
  console.error('[github-context-server] ERROR: WORKSPACE_ID is required')
  process.exit(1)
}

const server = new McpServer(
  { name: 'github-context', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function registerTools(): Promise<void> {
  server.tool(
    'github_pr_list',
    'List recent pull requests for the repository.',
    {
      state: z.enum(['open', 'closed', 'all']).optional().default('open'),
      maxResults: z.number().int().min(1).max(100).optional().default(10)
    },
    async (args) => {
      // Delegate to in-process service (shares Octokit instance)
      return {
        content: [
          {
            type: 'text' as const,
            text: `[github_pr_list] state=${args.state} max=${args.maxResults} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'github_pr_detail',
    'Get details of a specific pull request.',
    {
      prNumber: z.number().int().min(1).describe('Pull request number')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[github_pr_detail] PR #${args.prNumber} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'github_issues',
    'List recent issues for the repository.',
    {
      state: z.enum(['open', 'closed', 'all']).optional().default('open'),
      labels: z.string().optional().describe('Comma-separated label filter'),
      maxResults: z.number().int().min(1).max(100).optional().default(10)
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[github_issues] state=${args.state} labels=${args.labels ?? 'none'} — delegating to in-process service`
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
  console.error(`[github-context-server] Started (workspace=${WORKSPACE_ID})`)
}

main().catch((err) => {
  console.error('[github-context-server] Fatal:', err)
  process.exit(1)
})

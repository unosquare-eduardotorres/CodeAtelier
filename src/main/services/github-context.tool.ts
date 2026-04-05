import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { githubService } from './github.service'

const ghLog = log.scope('GitHubContext')

/**
 * Manages per-workspace MCP servers that expose `get_pr_status`, `list_pr_comments`,
 * and `list_issues` tools to the Claude Agent SDK. All tools are read-only.
 *
 * Used by: Generalist only (conditional on GitHub token being configured).
 * Keyed by workspaceId (token is per-workspace).
 */
class GitHubContextMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given workspace.
   * Only call this when githubService.isConfigured(workspaceId) is true.
   */
  getMcpServersConfig(workspaceId: string, workspacePath: string): Record<string, McpServerConfig> {
    let config = this.servers.get(workspaceId)
    if (config) return { 'github-context': config }

    config = createSdkMcpServer({
      name: 'github-context',
      version: '1.0.0',
      tools: [
        {
          name: 'get_pr_status',
          description:
            'Get the status of a pull request (open, closed, merged). ' +
            'Returns PR state, title, author, and basic metadata. ' +
            'Requires a PR number.',
          inputSchema: {
            prNumber: z.number().describe('Pull request number')
          },
          handler: async (args) => {
            try {
              const prNumber = args.prNumber as number
              const status = await githubService.getPullRequestStatus(
                workspaceId,
                workspacePath,
                prNumber
              )

              const result = { prNumber, status }
              ghLog.info(`get_pr_status: PR #${prNumber} = ${status}`)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              ghLog.error('get_pr_status failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error getting PR status: ${msg}` }]
              }
            }
          }
        },
        {
          name: 'list_pr_comments',
          description:
            'List review comments on a pull request. Returns up to 10 most recent ' +
            'comments with author, body, file path, and creation date.',
          inputSchema: {
            prNumber: z.number().describe('Pull request number'),
            maxComments: z
              .number()
              .optional()
              .default(10)
              .describe('Max comments to return (default 10, max 25)')
          },
          handler: async (args) => {
            try {
              const prNumber = args.prNumber as number
              const maxComments = Math.min((args.maxComments as number) ?? 10, 25)

              const comments = await githubService.listPullRequestComments(
                workspaceId,
                workspacePath,
                prNumber,
                maxComments
              )

              ghLog.info(`list_pr_comments: PR #${prNumber} returned ${comments.length} comments`)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(comments, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              ghLog.error('list_pr_comments failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error listing PR comments: ${msg}` }]
              }
            }
          }
        },
        {
          name: 'list_issues',
          description:
            'List open issues for the repository. Returns up to 10 most recent ' +
            'issues with title, author, labels, and creation date.',
          inputSchema: {
            state: z
              .enum(['open', 'closed', 'all'])
              .optional()
              .default('open')
              .describe('Issue state filter (default: open)'),
            maxIssues: z
              .number()
              .optional()
              .default(10)
              .describe('Max issues to return (default 10, max 25)'),
            labels: z.string().optional().describe('Comma-separated label names to filter by')
          },
          handler: async (args) => {
            try {
              const state = (args.state as 'open' | 'closed' | 'all') ?? 'open'
              const maxIssues = Math.min((args.maxIssues as number) ?? 10, 25)
              const labels = args.labels as string | undefined

              const issues = await githubService.listIssues(workspaceId, workspacePath, {
                state,
                perPage: maxIssues,
                labels
              })

              ghLog.info(`list_issues: returned ${issues.length} issues (${state})`)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(issues, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              ghLog.error('list_issues failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error listing issues: ${msg}` }]
              }
            }
          }
        }
      ]
    })

    this.servers.set(workspaceId, config)
    return { 'github-context': config }
  }

  dispose(workspaceId: string): void {
    this.servers.delete(workspaceId)
  }
}

export const gitHubContextMcpService = new GitHubContextMcpService()

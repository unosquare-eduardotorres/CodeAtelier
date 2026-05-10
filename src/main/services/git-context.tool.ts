import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import { execSync } from 'node:child_process'

const gitLog = log.scope('GitContext')

/**
 * Manages per-workspace MCP servers that expose `git_log`, `git_diff`, and `git_blame`
 * tools to the Claude Agent SDK. All tools are read-only — no mutations.
 *
 * Used by: Generalist + Specialists + SubAgents (always on).
 */
class GitContextMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given workspace path.
   * Keyed by workspacePath since git context is path-based.
   */
  getMcpServersConfig(workspacePath: string): Record<string, McpServerConfig> {
    let config = this.servers.get(workspacePath)
    if (config) return { 'git-context': config }

    config = createSdkMcpServer({
      name: MCP_TOOLS.GIT_CONTEXT._SERVER,
      version: '1.0.0',
      tools: [
        {
          name: MCP_TOOLS.GIT_CONTEXT.GIT_LOG.tool,
          description:
            'Get recent git commit history. Returns commit hash, author, date, and message. ' +
            'Use to understand what changed recently or find relevant commits.',
          inputSchema: {
            maxCount: z
              .number()
              .optional()
              .default(20)
              .describe('Max commits to return (default 20, max 50)'),
            path: z.string().optional().describe('Filter to commits touching this file/directory'),
            since: z
              .string()
              .optional()
              .describe('Only commits after this date (e.g. "2024-01-01", "3 days ago")'),
            author: z.string().optional().describe('Filter by author name/email')
          },
          handler: async (args) => {
            try {
              const maxCount = Math.min((args.maxCount as number) ?? 20, 50)
              const gitArgs = ['log', `--max-count=${maxCount}`, '--format=%H|%an|%ai|%s']
              if (args.since) gitArgs.push(`--since=${args.since as string}`)
              if (args.author) gitArgs.push(`--author=${args.author as string}`)
              if (args.path) gitArgs.push('--', args.path as string)

              const output = execSync(`git ${gitArgs.join(' ')}`, {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout: 10000
              }).trim()

              if (!output) {
                return {
                  content: [
                    { type: 'text' as const, text: 'No commits found matching the criteria.' }
                  ]
                }
              }

              const commits = output
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                  const [hash, author, date, ...msgParts] = line.split('|')
                  return {
                    hash: hash.slice(0, 7),
                    author,
                    date,
                    message: msgParts.join('|')
                  }
                })

              gitLog.info(`git_log returned ${commits.length} commits`)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(commits, null, 2) }]
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              gitLog.error('git_log failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error running git log: ${msg}` }]
              }
            }
          }
        },
        {
          name: MCP_TOOLS.GIT_CONTEXT.GIT_DIFF.tool,
          description:
            'Show git diff for staged, unstaged, or between commits. ' +
            'Use to understand what code changed and review modifications.',
          inputSchema: {
            target: z
              .enum(['staged', 'unstaged', 'head', 'commit'])
              .default('unstaged')
              .describe('What to diff: staged, unstaged, HEAD vs working tree, or specific commit'),
            commitRef: z
              .string()
              .optional()
              .describe('Commit ref to diff against (only when target="commit")'),
            path: z.string().optional().describe('Filter diff to specific file/directory'),
            maxLines: z
              .number()
              .optional()
              .default(200)
              .describe('Max output lines (default 200, max 500)')
          },
          handler: async (args) => {
            try {
              const maxLines = Math.min((args.maxLines as number) ?? 200, 500)
              const gitArgs: string[] = ['diff']

              switch (args.target) {
                case 'staged':
                  gitArgs.push('--cached')
                  break
                case 'head':
                  gitArgs.push('HEAD')
                  break
                case 'commit':
                  gitArgs.push((args.commitRef as string) ?? 'HEAD~1')
                  break
                // 'unstaged' is the default — no extra args
              }

              if (args.path) gitArgs.push('--', args.path as string)

              const output = execSync(`git ${gitArgs.join(' ')}`, {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout: 15000
              }).trim()

              if (!output) {
                return { content: [{ type: 'text' as const, text: 'No differences found.' }] }
              }

              // Cap output to maxLines
              const lines = output.split('\n')
              const truncated = lines.length > maxLines
              const result = truncated
                ? lines.slice(0, maxLines).join('\n') +
                  `\n\n[Truncated - ${lines.length - maxLines} more lines]`
                : output

              gitLog.info(
                `git_diff (${args.target}) returned ${lines.length} lines${truncated ? ' (truncated)' : ''}`
              )
              return { content: [{ type: 'text' as const, text: result }] }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              gitLog.error('git_diff failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error running git diff: ${msg}` }]
              }
            }
          }
        },
        {
          name: MCP_TOOLS.GIT_CONTEXT.GIT_BLAME.tool,
          description:
            'Show git blame for a file - who last modified each line. ' +
            'Use to understand code ownership and when changes were made.',
          inputSchema: {
            file: z.string().describe('File path relative to repo root'),
            startLine: z.number().optional().describe('Start line number'),
            endLine: z.number().optional().describe('End line number')
          },
          handler: async (args) => {
            try {
              const file = args.file as string
              const gitArgs = ['blame', '--line-porcelain']

              if (args.startLine && args.endLine) {
                gitArgs.push('-L', `${args.startLine},${args.endLine}`)
              }

              gitArgs.push('--', file)

              const output = execSync(`git ${gitArgs.join(' ')}`, {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout: 15000
              }).trim()

              if (!output) {
                return {
                  content: [{ type: 'text' as const, text: 'No blame data available.' }]
                }
              }

              // Parse porcelain format into compact readable format
              const blameEntries: Array<{
                commit: string
                author: string
                date: string
                line: number
                content: string
              }> = []

              const blocks = output.split(/^(?=[a-f0-9]{40} )/m)
              for (const block of blocks) {
                if (!block.trim()) continue
                const commitMatch = block.match(/^([a-f0-9]{40}) \d+ (\d+)/)
                const authorMatch = block.match(/^author (.+)$/m)
                const dateMatch = block.match(/^author-time (\d+)$/m)
                const contentMatch = block.match(/^\t(.*)$/m)

                if (commitMatch && authorMatch && contentMatch) {
                  const timestamp = dateMatch
                    ? new Date(parseInt(dateMatch[1]) * 1000).toISOString().split('T')[0]
                    : 'unknown'
                  blameEntries.push({
                    commit: commitMatch[1].slice(0, 7),
                    author: authorMatch[1],
                    date: timestamp,
                    line: parseInt(commitMatch[2]),
                    content: contentMatch[1]
                  })
                }
              }

              // Cap at ~100 entries to keep output manageable
              const capped = blameEntries.slice(0, 100)
              const result =
                capped.length < blameEntries.length
                  ? JSON.stringify(capped, null, 2) +
                    `\n\n[Truncated - ${blameEntries.length - capped.length} more lines]`
                  : JSON.stringify(capped, null, 2)

              gitLog.info(`git_blame returned ${blameEntries.length} entries for ${file}`)
              return { content: [{ type: 'text' as const, text: result }] }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              gitLog.error('git_blame failed:', msg)
              return {
                content: [{ type: 'text' as const, text: `Error running git blame: ${msg}` }]
              }
            }
          }
        }
      ]
    })

    this.servers.set(workspacePath, config)
    return { 'git-context': config }
  }

  dispose(workspacePath: string): void {
    this.servers.delete(workspacePath)
  }
}

export const gitContextMcpService = new GitContextMcpService()

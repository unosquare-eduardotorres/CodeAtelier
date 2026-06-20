#!/usr/bin/env node
/**
 * Git Context MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: git_log, git_diff, git_blame, git_show
 * All tools are read-only — no mutations.
 *
 * Environment variables:
 *   WORKSPACE_PATH — Absolute path to the git repository
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { spawnSync } from 'node:child_process'
import { truncateToolOutput } from './output-cap'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()

const server = new McpServer(
  { name: 'git-context', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// MCP-01: Use spawnSync with array args to prevent shell command injection.
// String-based execSync allows shell metacharacter injection via tool arguments.
function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: WORKSPACE_PATH,
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024 // 1MB
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `git exited with code ${result.status}`)
  return result.stdout.trim()
}

/** Validate that a git ref contains only safe characters */
const SAFE_REF_RE = /^[a-zA-Z0-9._\/@{}\-~^:]+$/

// git_log
server.tool(
  'git_log',
  'Get recent git commit history with hash, author, date, and message.',
  {
    maxCount: z.number().int().min(1).max(200).optional().default(20),
    path: z.string().optional().describe('Filter to commits touching this file/directory'),
    since: z.string().optional().describe('Only commits after this date'),
    author: z.string().optional().describe('Filter by author')
  },
  async (args) => {
    const gitArgs = [
      'log',
      `--max-count=${Math.min(args.maxCount, 50)}`,
      '--format=%H|%an|%ai|%s',
      ...(args.since ? [`--since=${args.since}`] : []),
      ...(args.author ? [`--author=${args.author}`] : []),
      '--',
      ...(args.path ? [args.path] : [])
    ]
    const output = git(gitArgs)
    const commits = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, ...msg] = line.split('|')
        return { hash, author, date, message: msg.join('|') }
      })
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ commits, count: commits.length }, null, 2) }
      ]
    }
  }
)

// git_diff
server.tool(
  'git_diff',
  'Show diff between commits, branches, or working tree changes.',
  {
    ref: z.string().regex(SAFE_REF_RE, 'Invalid characters in git ref').optional().default('HEAD').describe('Commit/branch to diff from'),
    ref2: z.string().regex(SAFE_REF_RE, 'Invalid characters in git ref').optional().describe('Second ref to diff to (default: working tree)'),
    path: z.string().optional().describe('Filter to specific file/directory'),
    stat: z.boolean().optional().default(false).describe('Show diffstat only (no patch)')
  },
  async (args) => {
    const gitArgs = [
      'diff',
      ...(args.stat ? ['--stat'] : []),
      args.ref,
      ...(args.ref2 ? [args.ref2] : []),
      '--',
      ...(args.path ? [args.path] : [])
    ]
    const output = git(gitArgs)
    // 6A-2: Cap diff output at 30K chars (large diffs in monorepos)
    return {
      content: [{ type: 'text' as const, text: truncateToolOutput(output || '(no changes)') }]
    }
  }
)

// git_blame
server.tool(
  'git_blame',
  'Show line-by-line authorship for a file.',
  {
    filePath: z.string().describe('Relative file path to blame'),
    startLine: z.number().int().min(1).max(100000).optional().describe('Start line number'),
    endLine: z.number().int().min(1).max(100000).optional().describe('End line number')
  },
  async (args) => {
    const gitArgs = [
      'blame',
      '--porcelain',
      ...(args.startLine && args.endLine ? ['-L', `${args.startLine},${args.endLine}`] : []),
      '--',
      args.filePath
    ]
    const output = git(gitArgs)
    return { content: [{ type: 'text' as const, text: truncateToolOutput(output) }] }
  }
)

// git_show
server.tool(
  'git_show',
  'Show details of a specific commit.',
  {
    ref: z.string().regex(SAFE_REF_RE, 'Invalid characters in git ref').describe('Commit hash or reference'),
    stat: z.boolean().optional().default(true).describe('Include diffstat')
  },
  async (args) => {
    const gitArgs = [
      'show',
      ...(args.stat ? ['--stat'] : []),
      args.ref
    ]
    const output = git(gitArgs)
    return { content: [{ type: 'text' as const, text: truncateToolOutput(output) }] }
  }
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[git-context-server] Started (workspace=${WORKSPACE_PATH})`)
}

main().catch((err) => {
  console.error('[git-context-server] Fatal:', err)
  process.exit(1)
})

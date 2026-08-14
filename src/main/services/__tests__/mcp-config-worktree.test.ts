/**
 * The MCP config an agent in a worktree actually gets — against a REAL git tree.
 *
 * The bug this closes is quiet and expensive: every MCP server was handed the
 * workspace's primary path, so an agent working in a track's worktree ran
 * eslint over the *user's* checkout, asked git for the *user's* changed files,
 * and reported both as its own findings. Nothing errored; the answers were
 * simply about a different directory.
 *
 * The in-memory tests in cli-mcp-config-writer-logic.test.ts pin the env split.
 * This one goes the last mile: a genuine `git worktree`, a file that exists in
 * it and nowhere else, and assertions against the JSON as written to disk —
 * because the file is what the CLI reads, and a config that is correct in
 * memory and shared on disk is still wrong.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

const gitAvailable = spawnSync('git', ['--version']).status === 0

// Enter the db/repositories import cycle through db/index; see the note in
// cli-mcp-config-writer-logic.test.ts.
try {
  require('../../db/index')
} catch {
  /* reported by the writer import below */
}

let Writer: typeof import('../cli-mcp-config-writer').CliMcpConfigWriter | null = null
try {
  Writer = require('../cli-mcp-config-writer').CliMcpConfigWriter
} catch {
  Writer = null
}

if (!gitAvailable || !Writer) {
  describe('MCP config in a worktree (skipped)', () => {
    test('requires git and the config writer', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'writer import failed'
    })
  })
} else {
  const WriterClass = Writer

  describe('MCP config in a worktree', () => {
    test('per-tree servers point at the worktree, the graph included', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mcp-wt-'))
      const repo = join(root, 'repo')
      const worktree = join(root, 'wt')

      try {
        // A real repository with one commit, so `worktree add` has a base.
        const git = simpleGit()
        await git.cwd(root).raw(['init', '-q', repo])
        const repoGit = simpleGit(repo)
        await repoGit.addConfig('user.email', 'test@example.com')
        await repoGit.addConfig('user.name', 'Test')
        await writeFile(join(repo, 'base.txt'), 'base\n')
        await repoGit.add('.')
        await repoGit.commit('base')

        await repoGit.raw(['worktree', 'add', '-b', 'feat/only-here', worktree])

        // Exists in the worktree and nowhere else — the file whose lint results
        // the agent would never see if the config pointed at the repo root.
        await writeFile(join(worktree, 'only-in-worktree.ts'), 'export const x = 1\n')
        assert.equal(existsSync(join(worktree, 'only-in-worktree.ts')), true)
        assert.equal(existsSync(join(repo, 'only-in-worktree.ts')), false)

        const writer = new WriterClass()
        const configPath = writer.writeConfig({
          workspacePath: repo,
          executionPath: worktree,
          workspaceId: 'ws-wt',
          conversationId: 'conv-wt',
          mode: 'build',
          featureFlags: {
            repomapEnabled: true,
            semanticSearchEnabled: true,
            githubConfigured: false,
            localMcpActive: {}
          },
          instanceId: 'inst-wt'
        })

        const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          mcpServers: Record<string, { env?: Record<string, string> }>
        }
        const servers = written.mcpServers

        // Per-tree: these must describe the tree the agent is editing.
        assert.equal(servers['code-analysis'].env?.WORKSPACE_PATH, worktree)
        assert.equal(servers['git-context'].env?.WORKSPACE_PATH, worktree)
        assert.equal(servers['process-manager'].env?.WORKSPACE_PATH, worktree)
        assert.equal(servers['control-actions'].env?.WORKSPACE_PATH, worktree)

        // The graph follows the agent as well. A track is on its own branch, so
        // the primary tree's index describes files the agent cannot see and
        // omits the ones it is editing — `only-in-worktree.ts` above being the
        // whole point. It is scoped rather than shared.
        assert.equal(servers['code-graph'].env?.WORKSPACE_PATH, worktree)
        assert.equal(servers['code-graph'].env?.EXECUTION_PATH, undefined)
        assert.ok(servers['code-graph'].env?.WORKSPACE_ID, 'the graph still needs a scope id')

        // Everything else keyed by workspace identity is untouched by this.
        assert.equal(servers['memory'].env?.WORKSPACE_ID, 'ws-wt')

        // The primary tree's own config must be a different file, or one of the
        // two silently overwrites the other.
        const primaryConfigPath = writer.writeConfig({
          workspacePath: repo,
          executionPath: repo,
          workspaceId: 'ws-wt',
          conversationId: 'conv-primary',
          mode: 'build',
          featureFlags: {
            repomapEnabled: true,
            semanticSearchEnabled: true,
            githubConfigured: false,
            localMcpActive: {}
          },
          instanceId: 'inst-wt'
        })
        assert.notEqual(primaryConfigPath, configPath)

        // ...and the worktree's config is still intact after the second write.
        const reread = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          mcpServers: Record<string, { env?: Record<string, string> }>
        }
        assert.equal(reread.mcpServers['code-analysis'].env?.WORKSPACE_PATH, worktree)

        writer.dispose(repo, 'inst-wt')
        assert.equal(existsSync(configPath), false)
        assert.equal(existsSync(primaryConfigPath), false)
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

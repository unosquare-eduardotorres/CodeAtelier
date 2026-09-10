/**
 * btw.ipc + ultraplan.ipc + autofix-pr.service — real handler coverage.
 *
 * All three sat at 0%: their registered tests (btw.test, autofix-pr.test) never
 * imported these modules. These tests drive the actual IPC handlers through
 * tryInvokeHandler and the real autofixPrService.buildFixPrompt, with the
 * one-shot CLI, the services barrel and github.service mocked.
 *
 * Run: tsx src/main/ipc/__tests__/btw-ultraplan-autofix.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getMockRepo,
  tryInvokeHandler,
  createSpy,
  mockService,
  unmockService
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

// ── Mocks ────────────────────────────────────────────────────────────────────

const runOneShotClaude = createSpy(async () => ({ text: 'Short answer' }))
mockService('one-shot-claude', { runOneShotClaude })

// ultraplan's chatAgentService mock is registered below, AFTER btw.ipc and
// autofix-pr.service are required: its key '../services' substring-matches
// every '../services/<name>' request, so it must only be live for the
// ultraplan require.

// autofix-pr needs github.service. ipc-code-changes-p27 leaves a
// 'github.service' mock registered forever — drop it so ours is the one that
// matches (registered later, same key overwrites anyway; explicit for clarity).
unmockService('github.service')
const githubMocks = {
  isConfigured: createSpy(() => true),
  findPrForBranch: createSpy(async () => 42),
  getCheckStatus: createSpy(async () => ({
    checkRuns: [
      { name: 'build', conclusion: 'success' },
      { name: 'test', conclusion: 'failure', output: { summary: '3 tests failed' } }
    ]
  })),
  listPullRequestComments: createSpy(async () => [
    { author: 'dana', body: 'Handle the empty list', path: 'src/api.ts', line: 12 },
    { author: 'sam', body: 'Nit: rename', path: 'src/util.ts', line: null }
  ])
}
mockService('github.service', { githubService: githubMocks })

const convoRepo = getMockRepo('conversation')
const wsRepo = getMockRepo('workspace')
const msgRepo = getMockRepo('message')

// ── Module loads ─────────────────────────────────────────────────────────────

let btwLoaded = false
let ultraplanLoaded = false
let autofixLoaded = false
try {
  require('../btw.ipc').registerBtwIpc()
  btwLoaded = true
} catch (err) {
  console.error(`btw.ipc load FAILED: ${(err as Error).message}`)
}
let autofixPrService: any
try {
  autofixPrService = require('../../services/autofix-pr.service').autofixPrService
  autofixLoaded = true
} catch (err) {
  console.error(`autofix-pr.service load FAILED: ${(err as Error).message}`)
}

// Now the barrel mock (see the ordering comment above), then ultraplan.
const sendCliSlashCommand = createSpy(() => undefined)
mockService('../services', { chatAgentService: { sendCliSlashCommand } })
try {
  require('../ultraplan.ipc').registerUltraplanIpc()
  ultraplanLoaded = true
} catch (err) {
  console.error(`ultraplan.ipc load FAILED: ${(err as Error).message}`)
}

// ── ultraplan.ipc ────────────────────────────────────────────────────────────

describe('ultraplan.ipc — CHAT teleport-back actions', () => {
  for (const [action, key] of [
    ['implement_here', '1'],
    ['new_session', '2'],
    ['cancel', '3']
  ] as const) {
    test(`action ${action} sends CLI choice ${key}`, async () => {
      await runExclusive(async () => {
        assert.ok(ultraplanLoaded, 'ultraplan.ipc must load')
        sendCliSlashCommand.calls.length = 0
        sendCliSlashCommand.callCount = 0
        const r = await tryInvokeHandler('ultraplan:respond', { action })
        assert.equal(r.ok, true)
        assert.deepEqual(sendCliSlashCommand.calls[0], [key])
      })
    })
  }

  test('an unknown action is ignored (no CLI command)', async () => {
    await runExclusive(async () => {
      sendCliSlashCommand.calls.length = 0
      sendCliSlashCommand.callCount = 0
      const r = await tryInvokeHandler('ultraplan:respond', { action: 'teleport' })
      assert.equal(r.ok, true)
      assert.equal(sendCliSlashCommand.callCount, 0)
    })
  })

  test('a missing action is rejected', async () => {
    await runExclusive(async () => {
      const r = await tryInvokeHandler('ultraplan:respond', {})
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /action/)
    })
  })
})

// ── btw.ipc ──────────────────────────────────────────────────────────────────

describe('btw.ipc — ephemeral side questions', () => {
  test('builds context from recent messages and answers', async () => {
    await runExclusive(async () => {
      assert.ok(btwLoaded, 'btw.ipc must load')
      convoRepo.findById = createSpy(() => ({ id: 'c1', workspaceId: 'ws-1' }))
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: '/repo/demo' }))
      msgRepo.findRecentByConversation = createSpy(() => [
        { role: 'user', contentMd: 'Why is the token refreshed twice?' },
        { role: 'assistant', contentMd: 'Because of the retry middleware.' }
      ])
      runOneShotClaude.mockImplementation(async (opts: any) => {
        assert.equal(opts.feature, 'btw')
        assert.ok(opts.args[0] === '--code', 'repoPath is passed as --code')
        assert.ok(String(opts.args.at(-1)).includes('Side question: what is a monad?'))
        return { text: 'Short answer' }
      })
      const r = await tryInvokeHandler('chat:btw', {
        conversationId: 'c1',
        question: 'what is a monad?'
      })
      assert.equal(r.ok, true)
      assert.deepEqual(r.result, { answer: 'Short answer' })
    })
  })

  test('without a repoPath the CLI args have no --code entry', async () => {
    await runExclusive(async () => {
      convoRepo.findById = createSpy(() => ({ id: 'c1', workspaceId: 'ws-1' }))
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: null }))
      msgRepo.findRecentByConversation = createSpy(() => [])
      runOneShotClaude.mockImplementation(async (opts: any) => {
        assert.equal(opts.args[0], '-p', 'no --code without a repoPath')
        return { text: 'ok' }
      })
      const r = await tryInvokeHandler('chat:btw', { conversationId: 'c1', question: 'q' })
      assert.equal(r.ok, true)
    })
  })

  test('an unknown conversation is rejected', async () => {
    await runExclusive(async () => {
      convoRepo.findById = createSpy(() => null)
      const r = await tryInvokeHandler('chat:btw', { conversationId: 'nope', question: 'q' })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /Conversation not found/)
    })
  })

  test('a CLI failure comes back as a Failed-to-answer message', async () => {
    await runExclusive(async () => {
      convoRepo.findById = createSpy(() => ({ id: 'c1', workspaceId: 'ws-1' }))
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: null }))
      msgRepo.findRecentByConversation = createSpy(() => [])
      runOneShotClaude.mockImplementation(async () => {
        throw new Error('CLI not installed')
      })
      const r = await tryInvokeHandler('chat:btw', { conversationId: 'c1', question: 'q' })
      assert.equal(r.ok, true)
      assert.match((r.result as any).answer, /Failed to answer: CLI not installed/)
    })
  })
})

// ── autofix-pr.service ───────────────────────────────────────────────────────

describe('autofix-pr.service — buildFixPrompt', () => {
  test('a missing workspace repo path is an error', async () => {
    await runExclusive(async () => {
      assert.ok(autofixLoaded, 'autofix-pr.service must load')
      wsRepo.findById = createSpy(() => null)
      await assert.rejects(
        () => autofixPrService.buildFixPrompt({ workspaceId: 'ws-x' }),
        /No workspace repo path/
      )
    })
  })

  test('an unconfigured GitHub is an actionable error', async () => {
    await runExclusive(async () => {
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: '/repo/demo' }))
      githubMocks.isConfigured.mockImplementation(() => false)
      await assert.rejects(
        () => autofixPrService.buildFixPrompt({ workspaceId: 'ws-1', prNumber: 7 }),
        /GitHub is not configured/
      )
      githubMocks.isConfigured.mockImplementation(() => true)
    })
  })

  test('failed checks and review comments land in the prompt with instructions', async () => {
    await runExclusive(async () => {
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: '/repo/demo' }))
      const { prompt, context } = await autofixPrService.buildFixPrompt({
        workspaceId: 'ws-1',
        prNumber: 42
      })
      assert.ok(prompt.includes('## Auto-Fix PR #42'), prompt)
      assert.ok(prompt.includes('### ❌ Failed CI Checks'), prompt)
      assert.ok(prompt.includes('**test**'), prompt)
      assert.ok(prompt.includes('3 tests failed'), prompt)
      assert.ok(prompt.includes('### 💬 Review Comments'), prompt)
      assert.ok(prompt.includes('**@dana** on `src/api.ts:12`'), prompt)
      assert.ok(prompt.includes('**@sam** on `src/util.ts`'), prompt) // null line → no :line suffix
      assert.ok(prompt.includes('### Instructions'), prompt)
      assert.equal(context.prNumber, 42)
      assert.equal(context.failedChecks.length, 1)
      assert.equal(context.reviewComments.length, 2)
    })
  })

  test('a clean PR says so instead of inventing instructions', async () => {
    await runExclusive(async () => {
      wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: '/repo/demo' }))
      githubMocks.getCheckStatus.mockImplementation(async () => ({
        checkRuns: [{ name: 'build', conclusion: 'success' }]
      }))
      githubMocks.listPullRequestComments.mockImplementation(async () => [])
      const { prompt } = await autofixPrService.buildFixPrompt({ workspaceId: 'ws-1', prNumber: 9 })
      assert.ok(prompt.includes('looks clean'), prompt)
      assert.ok(!prompt.includes('### Instructions'), prompt)
    })
  })

  test('without a PR number, the current branch is resolved via git and the API', async () => {
    await runExclusive(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-branch-'))
      try {
        execSync('git init -q -b main', { cwd: dir })
        // rev-parse --abbrev-ref HEAD fails on an unborn branch — give it a commit.
        execSync('git -c user.email=t@t.io -c user.name=t commit -q --allow-empty -m init', {
          cwd: dir
        })
        wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: dir }))
        githubMocks.findPrForBranch.mockImplementation(
          async (_ws: string, _p: string, branch: string) => {
            assert.equal(branch, 'main', 'the branch name comes from git rev-parse')
            return 77
          }
        )
        const { context } = await autofixPrService.buildFixPrompt({ workspaceId: 'ws-1' })
        assert.equal(context.prNumber, 77)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  test('a branch with no open PR is an actionable error', async () => {
    await runExclusive(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-nopr-'))
      try {
        execSync('git init -q -b feature-x', { cwd: dir })
        execSync('git -c user.email=t@t.io -c user.name=t commit -q --allow-empty -m init', {
          cwd: dir
        })
        wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: dir }))
        githubMocks.findPrForBranch.mockImplementation(async () => null)
        await assert.rejects(
          () => autofixPrService.buildFixPrompt({ workspaceId: 'ws-1' }),
          /No open PR found for branch "feature-x"/
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('btw/ultraplan/autofix — cleanup', () => {
  test('service mocks are unregistered for later files', async () => {
    await runExclusive(async () => {
      unmockService('../services')
      unmockService('one-shot-claude')
      unmockService('github.service')
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * AGENT-PREFLIGHT scoping (BP-WORKTREE-CWD) — `validateAgents` must interrogate
 * the SAME OpenCode instance that will serve the prompt.
 *
 * `/agent` is directory-scoped exactly like `/event` and `/session/{id}/prompt_async`
 * (SDK: `AppAgentsData.query.directory`). Asking the server-root instance whether
 * `davinci` exists, then sending the prompt to a worktree-scoped instance, is
 * unsound in both directions: a false negative rejects a build that would have
 * worked, a false positive re-opens the 204-then-timeout the preflight exists to
 * prevent. Blueprint BUILD runs in worktrees, so this is the common case.
 *
 * Also pinned: the three previously-conflated failure causes (never connected /
 * request threw / agent genuinely absent) now report distinct `status` values,
 * and only `missing` may reject a prompt.
 *
 * Run: tsx src/main/services/__tests__/opencode-agent-preflight.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

const { OpenCodeExecutor } = require('../opencode-executor')

const WORKTREE = '/tmp/atelier-worktree-track-a'
const ROOT = '/tmp/atelier-root'

type AgentsArgs = { query?: { directory?: string } } | undefined

interface Harness {
  exec: {
    validateAgents(directory?: string): Promise<{
      status: 'ok' | 'unreachable' | 'missing'
      agents: Array<{ name: string }>
      missingExpected: string[]
      message: string
    }>
    execute(options: Record<string, unknown>): AsyncGenerator<{ type: string; error?: string }>
  }
  agentsCalls: AgentsArgs[]
  promptCalls: Array<{ query?: { directory?: string } }>
}

/**
 * An executor wired to a fake client whose `/agent` answer depends on the
 * queried directory — the live shape once agent-session.service's
 * WORKTREE-AGENTS mirror has written definitions into the worktree but not the
 * server root.
 */
function makeExecutor(agentsFor: (directory?: string) => string[] | Error): Harness {
  const agentsCalls: AgentsArgs[] = []
  const promptCalls: Array<{ query?: { directory?: string } }> = []

  const client = {
    app: {
      agents: async (args: AgentsArgs) => {
        agentsCalls.push(args)
        const names = agentsFor(args?.query?.directory)
        if (names instanceof Error) throw names
        return { data: names.map((name) => ({ name, model: 'test-model', mode: 'all' })) }
      }
    },
    session: {
      create: async () => ({ data: { id: 'ses_preflighttest' } }),
      update: async () => ({}),
      promptAsync: async (args: { query?: { directory?: string } }) => {
        promptCalls.push(args)
        return {}
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({})
    },
    event: {
      // Empty stream: the turn ends immediately, so execute() runs to its final
      // status chunk without any event-shape assumptions.
      subscribe: async () => ({
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true as const, value: undefined })
          })
        }
      })
    }
  }

  const exec = new OpenCodeExecutor()
  exec.client = client
  exec.isStarted = true
  return { exec, agentsCalls, promptCalls }
}

function executeOptions(cwd: string): Record<string, unknown> {
  return {
    prompt: 'build the thing',
    systemPrompt: 'you are a builder',
    provider: { providerId: 'ollama', modelId: 'qwen3-coder:30b' },
    cwd,
    agent: 'davinci'
  }
}

describe('OpenCode agent preflight — directory scoping', () => {
  test('validateAgents forwards the directory as a query param', async () => {
    const { exec, agentsCalls } = makeExecutor(() => ['davinci', 'Grill', 'Audit'])
    await exec.validateAgents(WORKTREE)
    assert.deepEqual(
      agentsCalls[0],
      { query: { directory: WORKTREE } },
      '/agent is directory-scoped — the query param must carry the session directory'
    )
  })

  test('validateAgents omits the query param when no directory is given', async () => {
    const { exec, agentsCalls } = makeExecutor(() => ['davinci', 'Grill', 'Audit'])
    await exec.validateAgents()
    assert.equal(agentsCalls.length, 1)
    assert.equal(agentsCalls[0], undefined, 'unscoped callers keep the server-root behaviour')
  })

  test('a directory-scoped answer that lacks the agent is reported as missing', async () => {
    const { exec } = makeExecutor((dir) => (dir === WORKTREE ? ['davinci', 'Grill', 'Audit'] : []))
    const result = await exec.validateAgents(ROOT)
    assert.equal(result.status, 'missing')
    assert.ok(result.missingExpected.includes('davinci'))
    assert.ok(
      result.message.includes(ROOT),
      `message must name the directory probed — got: ${result.message}`
    )
  })

  test('the message reports the agents the server actually returned', async () => {
    const { exec } = makeExecutor(() => ['Grill', 'Audit'])
    const result = await exec.validateAgents(WORKTREE)
    assert.equal(result.status, 'missing')
    assert.deepEqual(result.missingExpected, ['davinci'])
    assert.ok(
      result.message.includes('Grill') && result.message.includes('Audit'),
      `message must list what the directory reported — got: ${result.message}`
    )
  })
})

describe('OpenCode agent preflight — cause separation', () => {
  test('a never-connected client is unreachable, not missing', async () => {
    const exec = new OpenCodeExecutor() // no client assigned
    const result = await exec.validateAgents(WORKTREE)
    assert.equal(result.status, 'unreachable')
    assert.deepEqual(
      result.missingExpected,
      [],
      'not being able to ask is not evidence that an agent is absent'
    )
  })

  test('a throwing agents() call is unreachable, not missing', async () => {
    const { exec } = makeExecutor(() => new Error('ECONNREFUSED 127.0.0.1:4096'))
    const result = await exec.validateAgents(WORKTREE)
    assert.equal(result.status, 'unreachable')
    assert.deepEqual(result.missingExpected, [])
    assert.ok(
      result.message.includes('ECONNREFUSED'),
      `message must carry the underlying error — got: ${result.message}`
    )
  })

  test('an unreachable validator does not reject the prompt', async () => {
    const { exec, promptCalls } = makeExecutor(() => new Error('socket hang up'))
    const chunks: Array<{ type: string; error?: string }> = []
    for await (const chunk of exec.execute(executeOptions(WORKTREE))) chunks.push(chunk)
    assert.equal(
      chunks.filter((c) => c.type === 'error').length,
      0,
      `a validator failure must never block the prompt — got: ${JSON.stringify(chunks)}`
    )
    assert.equal(promptCalls.length, 1, 'the prompt must still be sent')
  })
})

describe('OpenCode agent preflight — worktree regression', () => {
  test('a worktree that has davinci proceeds even when the server root does not', async () => {
    const { exec, agentsCalls, promptCalls } = makeExecutor((dir) =>
      dir === WORKTREE ? ['davinci', 'Grill', 'Audit'] : []
    )
    const chunks: Array<{ type: string; error?: string }> = []
    for await (const chunk of exec.execute(executeOptions(WORKTREE))) chunks.push(chunk)

    assert.deepEqual(
      agentsCalls[0],
      { query: { directory: WORKTREE } },
      'the preflight must ask the instance that will serve the prompt'
    )
    assert.equal(
      chunks.filter((c) => c.type === 'error').length,
      0,
      `the worktree has davinci — the prompt must not be rejected — got: ${JSON.stringify(chunks)}`
    )
    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0]?.query?.directory, WORKTREE)
  })

  test('a genuinely absent agent still rejects before send', async () => {
    const { exec, promptCalls } = makeExecutor(() => ['Grill', 'Audit'])
    const chunks: Array<{ type: string; error?: string }> = []
    for await (const chunk of exec.execute(executeOptions(ROOT))) chunks.push(chunk)

    const error = chunks.find((c) => c.type === 'error')
    assert.ok(error, 'a server that reports no davinci must fail fast, not wait out the timeout')
    assert.ok(
      error!.error?.includes(ROOT),
      `the rejection must name the directory probed — got: ${error!.error}`
    )
    assert.equal(promptCalls.length, 0, 'rejection happens before the prompt is sent')
  })
})

// Await pending async tests before exiting.
summaryAsync().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})

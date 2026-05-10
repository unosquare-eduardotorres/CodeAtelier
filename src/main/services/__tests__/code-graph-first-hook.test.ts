/**
 * Tests for createCodeGraphFirstHook — the PreToolUse hook that enforces
 * Code Graph-first exploration. Validates warn/block modes, graph-tool
 * tracking, non-code file exemptions, and the 5-call enforcement window.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createCodeGraphFirstHook } from '../sdk-hooks'
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal hook input payload matching the SDK shape */
function makeInput(toolName: string, toolInput: Record<string, unknown> = {}): HookInput {
  return { tool_name: toolName, tool_input: toolInput } as HookInput
}

/** Stub options matching the SDK HookCallback 3rd arg */
const hookOptions = { signal: AbortSignal.abort() }

/** Call hook with all 3 required SDK args */
async function callHook(
  hook: ReturnType<typeof createCodeGraphFirstHook>,
  input: HookInput
): Promise<SyncHookJSONOutput> {
  return (await hook(input, undefined, hookOptions)) as SyncHookJSONOutput
}

// ── Warn mode (default) ─────────────────────────────────────────────────────

describe('createCodeGraphFirstHook — warn mode', () => {
  test('allows graph tool as first call', async () => {
    const hook = createCodeGraphFirstHook('warn')
    const result = await callHook(hook, makeInput('mcp__code-graph__search_identifiers'))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read after a graph tool has been called', async () => {
    const hook = createCodeGraphFirstHook('warn')
    await callHook(hook, makeInput('graph_map'))
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/index.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Grep after a graph tool has been called', async () => {
    const hook = createCodeGraphFirstHook('warn')
    await callHook(hook, makeInput('search_identifiers'))
    const result = await callHook(hook, makeInput('Grep', { path: '/proj/src', pattern: 'foo' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Glob after a graph tool has been called', async () => {
    const hook = createCodeGraphFirstHook('warn')
    await callHook(hook, makeInput('mcp__semantic-search__semantic_search'))
    const result = await callHook(hook, makeInput('Glob', { pattern: '**/*.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows premature Read in warn mode (does not block)', async () => {
    const hook = createCodeGraphFirstHook('warn')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/main.ts' }))
    // Warn mode: returns empty (no block decision)
    assert.equal(result.decision, undefined)
  })

  test('allows premature Grep in warn mode (does not block)', async () => {
    const hook = createCodeGraphFirstHook('warn')
    const result = await callHook(
      hook,
      makeInput('Grep', { path: '/proj/src', pattern: 'class Foo' })
    )
    assert.equal(result.decision, undefined)
  })

  test('allows premature Glob in warn mode (does not block)', async () => {
    const hook = createCodeGraphFirstHook('warn')
    const result = await callHook(hook, makeInput('Glob', { pattern: '**/*.ts' }))
    assert.equal(result.decision, undefined)
  })
})

// ── Block mode ──────────────────────────────────────────────────────────────

describe('createCodeGraphFirstHook — block mode', () => {
  test('blocks premature Read on source files', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/service.ts' }))
    assert.equal(result.decision, 'block')
    assert.ok(
      (result.reason as string).includes('search_identifiers'),
      'reason should mention search_identifiers'
    )
  })

  test('blocks premature Grep on source paths', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Grep', { path: '/proj/src', pattern: 'function' })
    )
    assert.equal(result.decision, 'block')
  })

  test('blocks premature Glob', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Glob', { pattern: '**/*.ts' }))
    assert.equal(result.decision, 'block')
  })

  test('allows Read after graph tool even in block mode', async () => {
    const hook = createCodeGraphFirstHook('block')
    await callHook(hook, makeInput('find_dead_code'))
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/service.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Grep after graph tool even in block mode', async () => {
    const hook = createCodeGraphFirstHook('block')
    await callHook(hook, makeInput('mcp__code-graph__graph_map'))
    const result = await callHook(hook, makeInput('Grep', { path: '/proj/src', pattern: 'class' }))
    assert.deepStrictEqual(result, {})
  })
})

// ── Non-code file exemptions ────────────────────────────────────────────────

describe('createCodeGraphFirstHook — non-code file exemptions', () => {
  test('allows Read on package.json without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/package.json' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on tsconfig.json without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/tsconfig.app.json' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .md files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/README.md' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .yml files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/.github/workflows/ci.yml' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .yaml files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/docker-compose.yaml' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .env files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/.env.local' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .json files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/data/fixtures.json' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .lock files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/package-lock.json' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .config. files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/vite.config.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .css files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/src/styles/main.css' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .html files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/index.html' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Read on .svg files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/assets/logo.svg' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Grep on .json path without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Grep', { path: '/proj/config.json', pattern: 'port' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('blocks Read on .ts files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/app.ts' }))
    assert.equal(result.decision, 'block')
  })

  test('blocks Read on .tsx files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/App.tsx' }))
    assert.equal(result.decision, 'block')
  })

  test('blocks Read on .js files without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/util.js' }))
    assert.equal(result.decision, 'block')
  })
})

// ── Graph tool variants ─────────────────────────────────────────────────────

describe('createCodeGraphFirstHook — all graph tool names unlock exploration', () => {
  const graphToolNames = [
    'mcp__code-graph__graph_map',
    'mcp__code-graph__search_identifiers',
    'mcp__code-graph__find_dead_code',
    'mcp__semantic-search__semantic_search',
    'graph_map',
    'search_identifiers',
    'find_dead_code',
    'semantic_search'
  ]

  for (const toolName of graphToolNames) {
    test(`${toolName} unlocks subsequent Read calls`, async () => {
      const hook = createCodeGraphFirstHook('block')
      await callHook(hook, makeInput(toolName))
      const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/index.ts' }))
      assert.deepStrictEqual(result, {}, `Read should be allowed after ${toolName}`)
    })
  }
})

// ── Enforcement window (first 5 calls only) ────────────────────────────────

describe('createCodeGraphFirstHook — enforcement window', () => {
  test('stops enforcing after 5 tool calls', async () => {
    const hook = createCodeGraphFirstHook('block')
    // Burn through 5 calls with non-graph, non-exploration tools (e.g. Write, Bash)
    for (let i = 0; i < 5; i++) {
      await callHook(hook, makeInput('Bash', { command: 'echo hello' }))
    }
    // 6th call: Read should be allowed even without graph tool
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/deep.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('enforces within the first 5 calls', async () => {
    const hook = createCodeGraphFirstHook('block')
    // 1st call: non-exploration tool
    await callHook(hook, makeInput('Write', { file_path: '/proj/out.txt', content: 'x' }))
    // 2nd call: Read on source file — should be blocked (within window)
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/service.ts' }))
    assert.equal(result.decision, 'block')
  })
})

// ── Non-exploration tools are always allowed ────────────────────────────────

describe('createCodeGraphFirstHook — non-exploration tools passthrough', () => {
  test('allows Write without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Write', { file_path: '/proj/src/new.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Bash without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(hook, makeInput('Bash', { command: 'npm test' }))
    assert.deepStrictEqual(result, {})
  })

  test('allows Edit without graph tool', async () => {
    const hook = createCodeGraphFirstHook('block')
    const result = await callHook(
      hook,
      makeInput('Edit', { file_path: '/proj/src/x.ts', old_string: 'a', new_string: 'b' })
    )
    assert.deepStrictEqual(result, {})
  })
})

// ── Default mode ────────────────────────────────────────────────────────────

describe('createCodeGraphFirstHook — defaults to warn', () => {
  test('defaults to warn mode (no block)', async () => {
    const hook = createCodeGraphFirstHook()
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/deep.ts' }))
    // Should not block — warn mode allows but logs
    assert.equal(result.decision, undefined)
  })
})

/**
 * blueprint-workspace-docs.test.ts — E8: total budget + tiering for {{WORKSPACE_DOCS}}.
 *
 * THE BUG: buildWorkspaceDocsBlock capped each file at 30K chars and nothing
 * capped the block. Four well-known docs therefore allowed up to 120K chars
 * (~30K tokens) of task-invariant prefix, re-sent on every one of the ~31 API
 * calls of every build attempt — the single largest uncapped block in the
 * build prompt.
 *
 * THE FIX: an optional tier parameter imposes a TOTAL budget spent in priority
 * order (CLAUDE.md → README.md → PLAN.md → package.json), package.json is
 * summarised to name/scripts/dependency-names rather than injected whole, and
 * anything that no longer fits is NAMED so the agent can Read it.
 *
 * Callers that pass no tier keep the historical per-file-only behaviour.
 *
 * Run: tsx src/main/services/__tests__/blueprint-workspace-docs.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import {
  buildWorkspaceDocsBlock,
  WORKSPACE_DOCS_BUDGET_BY_TIER
} from '../blueprint-document-loader'

/** A workspace with the named docs at the given char sizes. */
function seedWorkspace(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, 'utf-8')
  }
  return dir
}

const body = (n: number, marker: string): string =>
  `${marker}`.repeat(Math.ceil(n / marker.length)).slice(0, n)

describe('workspace docs — tier budgets', () => {
  test('the budget table is exhaustive and ordered small < medium < large', () => {
    assert.deepEqual(Object.keys(WORKSPACE_DOCS_BUDGET_BY_TIER).sort(), [
      'large',
      'medium',
      'small'
    ])
    const { small, medium, large } = WORKSPACE_DOCS_BUDGET_BY_TIER
    assert.ok(small < medium && medium < large)
  })

  test('THE REGRESSION: four oversized docs no longer produce a 120K block', async () => {
    const ws = seedWorkspace('bp-docs-total-', {
      'CLAUDE.md': body(45_000, 'C'),
      'README.md': body(45_000, 'R'),
      'PLAN.md': body(45_000, 'P'),
      'package.json': JSON.stringify({ name: 'x', dependencies: {} })
    })

    const uncapped = await buildWorkspaceDocsBlock(ws)
    const capped = await buildWorkspaceDocsBlock(ws, 'large')

    assert.ok(uncapped!.length > 90_000, 'without a tier the block is still unbounded')
    assert.ok(
      capped!.length <= WORKSPACE_DOCS_BUDGET_BY_TIER.large + 2_000,
      `large-tier block must fit the 60K budget, got ${capped!.length}`
    )
  })

  test('a small-window model gets a much tighter block than a large one', async () => {
    const ws = seedWorkspace('bp-docs-tiers-', {
      'CLAUDE.md': body(45_000, 'C'),
      'README.md': body(45_000, 'R')
    })

    const small = await buildWorkspaceDocsBlock(ws, 'small')
    const large = await buildWorkspaceDocsBlock(ws, 'large')
    assert.ok(small!.length <= WORKSPACE_DOCS_BUDGET_BY_TIER.small + 2_000)
    assert.ok(large!.length > small!.length, 'a bigger window earns a bigger block')
  })

  test('priority order: CLAUDE.md is spent first and survives a tight budget', async () => {
    const ws = seedWorkspace('bp-docs-priority-', {
      'CLAUDE.md': body(11_000, 'CLAUDE-'),
      'README.md': body(40_000, 'README-'),
      'PLAN.md': body(40_000, 'PLAN-')
    })

    const block = await buildWorkspaceDocsBlock(ws, 'small')
    assert.ok(block!.includes('### CLAUDE.md'), 'conventions always make the cut')
    assert.ok(block!.includes('CLAUDE-'), 'and CLAUDE.md is present in full, not as a stub')
  })

  test('docs that no longer fit are NAMED, not silently dropped', async () => {
    const ws = seedWorkspace('bp-docs-omitted-', {
      'CLAUDE.md': body(12_000, 'C'),
      'README.md': body(40_000, 'R'),
      'PLAN.md': body(40_000, 'P')
    })

    const block = await buildWorkspaceDocsBlock(ws, 'small')
    assert.ok(block!.includes('Omitted to stay within the documentation budget'))
    assert.ok(block!.includes('PLAN.md'), 'the omitted doc is named so the agent can Read it')
  })

  test('a repo whose docs already fit is untouched by the budget', async () => {
    const ws = seedWorkspace('bp-docs-small-repo-', {
      'CLAUDE.md': body(8_000, 'C'),
      'README.md': body(4_000, 'R')
    })

    const block = await buildWorkspaceDocsBlock(ws, 'medium')
    assert.ok(!block!.includes('truncated'), 'no truncation marker')
    assert.ok(!block!.includes('Omitted'), 'nothing omitted')
    assert.ok(block!.includes('### CLAUDE.md') && block!.includes('### README.md'))
  })
})

describe('workspace docs — package.json summarisation', () => {
  test('dependency pins are reduced to MAJORS; names and scripts are kept', async () => {
    const ws = seedWorkspace('bp-docs-pkg-', {
      'package.json': JSON.stringify({
        name: 'fixture',
        version: '2.1.0',
        scripts: { build: 'vite build', test: 'tsx run-tests.ts' },
        dependencies: { 'better-sqlite3': '13.0.2', react: '^19.0.1' },
        devDependencies: { tsx: '^4.0.0' },
        // Noise an agent never reasons about — must not survive.
        eslintConfig: { extends: body(4_000, 'noise') }
      })
    })

    const block = await buildWorkspaceDocsBlock(ws, 'medium')
    assert.ok(block!.includes('better-sqlite3'), 'dependency names survive')
    assert.ok(block!.includes('vite build'), 'scripts survive — they are how to build and test')
    assert.ok(block!.includes('fixture'), 'name survives')
    assert.ok(!block!.includes('13.0.2'), 'patch-level pins are noise in a prompt')
    assert.ok(!block!.includes('^19.0.1'), 'the full range is not carried')
    assert.ok(block!.includes('"^19"'), 'the MAJOR survives — it decides which API to write against')
    assert.ok(block!.includes('"13"'), 'an exact pin reduces to its major too')
    assert.ok(!block!.includes('noise'), 'unrelated config blocks are dropped')
  })

  test('type / engines / packageManager survive — they shape the code written', async () => {
    // "type" decides ESM vs CJS for every file the builder creates. Dropping it
    // saved ~40 chars and cost a retry.
    const ws = seedWorkspace('bp-docs-pkg-shape-', {
      'package.json': JSON.stringify({
        name: 'fixture',
        type: 'module',
        engines: { node: '>=20' },
        packageManager: 'pnpm@9.1.0',
        dependencies: {}
      })
    })

    const block = await buildWorkspaceDocsBlock(ws, 'medium')
    assert.ok(block!.includes('"type": "module"'), 'the module system reaches the agent')
    assert.ok(block!.includes('>=20'), 'the runtime floor reaches the agent')
    assert.ok(block!.includes('pnpm@9.1.0'), 'the package manager reaches the agent')
  })

  test('non-semver ranges pass through untouched rather than being mangled', async () => {
    const ws = seedWorkspace('bp-docs-pkg-odd-', {
      'package.json': JSON.stringify({
        name: 'fixture',
        dependencies: { a: 'workspace:*', b: 'latest', c: '^1.0.0 || ^2.0.0', d: '^19' }
      })
    })

    const block = await buildWorkspaceDocsBlock(ws, 'medium')
    assert.ok(block!.includes('workspace:*'))
    assert.ok(block!.includes('latest'))
    assert.ok(block!.includes('^1.0.0 || ^2.0.0'), 'a compound range is not truncated to one side')
    assert.ok(block!.includes('"^19"'), 'an already-major range is left alone')
  })

  test('an unparseable package.json falls back to the raw text', async () => {
    const ws = seedWorkspace('bp-docs-pkg-bad-', { 'package.json': '{ not json ,,' })
    const block = await buildWorkspaceDocsBlock(ws, 'medium')
    assert.ok(block!.includes('not json'))
  })

  test('summarisation applies without a tier too (single coherent contract)', async () => {
    const ws = seedWorkspace('bp-docs-pkg-notier-', {
      'package.json': JSON.stringify({ name: 'n', dependencies: { dep: '1.2.3' } })
    })
    const block = await buildWorkspaceDocsBlock(ws)
    assert.ok(block!.includes('dep'))
    assert.ok(!block!.includes('1.2.3'), 'patch precision is dropped with or without a tier')
  })
})

describe('workspace docs — edge cases', () => {
  test('an empty workspace yields undefined, not an empty block', async () => {
    const ws = seedWorkspace('bp-docs-empty-', {})
    assert.equal(await buildWorkspaceDocsBlock(ws, 'large'), undefined)
  })

  test('a missing workspace path is survivable', async () => {
    const block = await buildWorkspaceDocsBlock(join(tmpdir(), 'does-not-exist-bp-docs'), 'medium')
    assert.equal(block, undefined)
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point.
if (require.main === module) {
  void summaryAsync()
}

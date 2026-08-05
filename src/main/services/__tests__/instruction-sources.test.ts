/**
 * Tests for instruction-sources.service.ts — agent rule file discovery.
 *
 * Covers: multi-format discovery, precedence ordering, frontmatter parsing
 * (inline arrays, block lists, quoted scalars, booleans), glob key aliases,
 * path classification, and scope-path seeding.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync } from './test-harness'
import {
  parseFrontmatter,
  collectInstructionRefs,
  discoverInstructionSources,
  classifyInstructionPath,
  scopePathsForSource,
  instructionScopePaths,
  expandImports,
  formatInstructionSources,
  listWorkspaceFiles
} from '../instruction-sources.service'
import type { InstructionSource } from '../instruction-sources.service'

/**
 * Run `body` against a private fixture repository.
 *
 * The harness runs tests concurrently, so a shared `beforeEach` root would be
 * clobbered between tests — each test gets its own directory instead.
 */
function withRepo(body: (root: string, write: (rel: string, content: string) => void) => void): void {
  const root = join(
    tmpdir(),
    `instr-src-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root, { recursive: true })

  const write = (rel: string, content: string): void => {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }

  try {
    body(root, write)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('returns the raw body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('# Title\n\nsome prose')
    assert.deepEqual(data, {})
    assert.equal(body, '# Title\n\nsome prose')
  })

  test('parses flat scalars and strips quotes', () => {
    const { data, body } = parseFrontmatter(
      '---\ndescription: "API conventions"\nother: plain\n---\nbody text'
    )
    assert.equal(data.description, 'API conventions')
    assert.equal(data.other, 'plain')
    assert.equal(body, 'body text')
  })

  test('parses booleans as booleans, not strings', () => {
    const { data } = parseFrontmatter('---\nalwaysApply: true\nother: false\n---\nx')
    assert.equal(data.alwaysApply, true)
    assert.equal(data.other, false)
  })

  test('parses inline arrays', () => {
    const { data } = parseFrontmatter('---\nglobs: ["src/**/*.ts", "test/**"]\n---\nx')
    assert.deepEqual(data.globs, ['src/**/*.ts', 'test/**'])
  })

  test('parses block lists', () => {
    const { data } = parseFrontmatter('---\nglobs:\n  - src/api/**\n  - "src/db/**"\n---\nx')
    assert.deepEqual(data.globs, ['src/api/**', 'src/db/**'])
  })

  test('does not split commas inside brace groups', () => {
    const { data } = parseFrontmatter('---\nglobs: [src/**/*.{ts,tsx}]\n---\nx')
    assert.deepEqual(data.globs, ['src/**/*.{ts,tsx}'])
  })

  test('ignores an unterminated frontmatter block', () => {
    const raw = '---\nglobs: [a]\nbody with no closing fence'
    const { data, body } = parseFrontmatter(raw)
    assert.deepEqual(data, {})
    assert.equal(body, raw)
  })
})

// ── Discovery ───────────────────────────────────────────────────────────────

describe('discoverInstructionSources', () => {
  test('finds every supported rule file format', () => {
    withRepo((root, write) => {
      write('CLAUDE.md', '# Claude\nProject rules for Claude, long enough to survive.')
      write('AGENTS.md', '# Agents\nProject rules for agents, long enough to survive.')
      write('.cursorrules', 'Legacy cursor rules with enough prose to be kept.')
      write('.windsurfrules', 'Windsurf rules with enough prose to be kept.')
      write('.github/copilot-instructions.md', 'Copilot rules with enough prose here.')
      write('.cursor/rules/api.mdc', '---\nglobs: ["src/api/**"]\n---\nUse Result types.')
      write('.windsurf/rules/db.md', 'Database rules with enough prose to be kept.')

      const sources = discoverInstructionSources(root).filter((s) => s.scope !== 'user')
      const formats = new Set(sources.map((s) => s.format))

      assert.ok(formats.has('claude-md'), 'CLAUDE.md discovered')
      assert.ok(formats.has('agents-md'), 'AGENTS.md discovered')
      assert.ok(formats.has('cursor-mdc'), 'cursor rules discovered')
      assert.ok(formats.has('copilot'), 'copilot instructions discovered')
      assert.ok(formats.has('windsurf'), 'windsurf rules discovered')
      assert.equal(sources.length, 7)
    })
  })

  test('orders sources project → local → nested', () => {
    withRepo((root, write) => {
      write('CLAUDE.md', 'Shared project rules, long enough to survive the filter.')
      write('CLAUDE.local.md', 'Personal overrides, long enough to survive the filter.')
      write('packages/api/AGENTS.md', 'Nested API rules, long enough to survive.')

      const scopes = discoverInstructionSources(root)
        .filter((s) => s.scope !== 'user')
        .map((s) => s.scope)

      assert.deepEqual(scopes, ['project', 'local', 'nested'])
    })
  })

  test('does not report root files as nested', () => {
    withRepo((root, write) => {
      write('CLAUDE.md', 'Root rules with enough prose to be kept by the reader.')

      const sources = discoverInstructionSources(root).filter((s) => s.scope !== 'user')
      assert.equal(sources.length, 1)
      assert.equal(sources[0].scope, 'project')
    })
  })

  test('skips ignored directories when searching for nested rule files', () => {
    withRepo((root, write) => {
      write('node_modules/pkg/AGENTS.md', 'Vendored rules that must never be ingested.')
      write('dist/AGENTS.md', 'Build output rules that must never be ingested.')

      const sources = discoverInstructionSources(root).filter((s) => s.scope !== 'user')
      assert.equal(sources.length, 0)
    })
  })

  test('reads globs from frontmatter and strips it from the content', () => {
    withRepo((root, write) => {
      write(
        '.cursor/rules/api.mdc',
        '---\ndescription: API\nglobs:\n  - src/api/**/*.ts\n---\nAlways return Result<T, E>.'
      )

      const source = discoverInstructionSources(root).find((s) => s.format === 'cursor-mdc')
      assert.ok(source)
      assert.deepEqual(source.globs, ['src/api/**/*.ts'])
      assert.equal(source.alwaysApply, false, 'a scoped file is not always-apply')
      assert.equal(source.content, 'Always return Result<T, E>.')
    })
  })

  test('accepts applyTo as a glob key (copilot dialect)', () => {
    withRepo((root, write) => {
      write(
        '.github/instructions/db.instructions.md',
        '---\napplyTo: "src/db/**"\n---\nMigrations must be sequential.'
      )

      const source = discoverInstructionSources(root).find((s) => s.format === 'copilot')
      assert.ok(source)
      assert.deepEqual(source.globs, ['src/db/**'])
    })
  })

  test('treats a file with no globs as always-apply', () => {
    withRepo((root, write) => {
      write('AGENTS.md', 'Rules that apply everywhere in this repository, no globs.')

      const source = discoverInstructionSources(root).find((s) => s.format === 'agents-md')
      assert.ok(source)
      assert.equal(source.alwaysApply, true)
      assert.deepEqual(source.globs, [])
    })
  })

  test('treats a catch-all glob as always-apply rather than a scope', () => {
    withRepo((root, write) => {
      write('AGENTS.md', '---\nglobs: ["**"]\n---\nRules that apply to the whole tree.')

      const source = discoverInstructionSources(root).find((s) => s.format === 'agents-md')
      assert.ok(source)
      assert.deepEqual(source.globs, [])
      assert.equal(source.alwaysApply, true)
    })
  })

  test('drops files whose body is empty after frontmatter', () => {
    withRepo((root, write) => {
      write('AGENTS.md', '---\nglobs: ["src/**"]\n---\n   \n')

      const sources = discoverInstructionSources(root).filter((s) => s.scope !== 'user')
      assert.equal(sources.length, 0)
    })
  })

  test('collectInstructionRefs finds paths without reading content', () => {
    withRepo((root, write) => {
      write('AGENTS.md', 'Rules with enough prose to be kept by any reader.')
      const refs = collectInstructionRefs(root).filter((r) => r.scope !== 'user')

      assert.equal(refs.length, 1)
      assert.equal(refs[0].format, 'agents-md')
      assert.ok(!('content' in refs[0]), 'refs carry no content')
    })
  })
})

// ── Import expansion ───────────────────────────────────────────────────

describe('expandImports', () => {
  test('inlines a referenced file relative to the importing file', () => {
    withRepo((root, write) => {
      write('docs/style.md', 'Two-space indentation everywhere.')
      write('CLAUDE.md', 'Project rules.\n\n@docs/style.md\n')

      const expanded = expandImports({
        path: join(root, 'CLAUDE.md'),
        content: 'Project rules.\n\n@docs/style.md\n'
      })

      assert.ok(expanded.includes('Two-space indentation everywhere.'))
      assert.ok(expanded.includes('<!-- imported: docs/style.md -->'))
    })
  })

  test('resolves nested imports relative to each importing file', () => {
    withRepo((root, write) => {
      write('docs/deep/leaf.md', 'LEAF CONTENT')
      write('docs/mid.md', 'Mid rules.\n@deep/leaf.md\n')

      const expanded = expandImports({
        path: join(root, 'CLAUDE.md'),
        content: '@docs/mid.md\n'
      })

      assert.ok(expanded.includes('Mid rules.'))
      assert.ok(expanded.includes('LEAF CONTENT'), 'nested import resolved from docs/')
    })
  })

  test('stops at the depth cap', () => {
    withRepo((root, write) => {
      write('a.md', 'A\n@b.md')
      write('b.md', 'B\n@c.md')
      write('c.md', 'C')

      const shallow = expandImports(
        { path: join(root, 'CLAUDE.md'), content: '@a.md' },
        2
      )

      assert.ok(shallow.includes('A'))
      assert.ok(shallow.includes('B'))
      assert.ok(!shallow.includes('C'), 'third hop is beyond the cap')
      assert.ok(shallow.includes('@c.md'), 'uncrossed reference is left verbatim')
    })
  })

  test('breaks import cycles instead of recursing forever', () => {
    withRepo((root, write) => {
      write('a.md', 'A CONTENT\n@b.md')
      write('b.md', 'B CONTENT\n@a.md')

      const expanded = expandImports({ path: join(root, 'a.md'), content: 'A CONTENT\n@b.md' })

      assert.ok(expanded.includes('B CONTENT'))
      assert.ok(expanded.includes('circular import skipped: a.md'))
    })
  })

  test('leaves references inside fenced code blocks alone', () => {
    withRepo((root, write) => {
      write('secret.md', 'SHOULD NOT APPEAR')
      const content = 'Rules.\n\n```sh\nnpm i @secret.md\n```\n'

      const expanded = expandImports({ path: join(root, 'CLAUDE.md'), content })

      assert.ok(!expanded.includes('SHOULD NOT APPEAR'))
      assert.ok(expanded.includes('npm i @secret.md'))
    })
  })

  test('leaves references inside inline code spans alone', () => {
    withRepo((root, write) => {
      write('secret.md', 'SHOULD NOT APPEAR')
      const content = 'Use `@secret.md` to refer to the file.'

      const expanded = expandImports({ path: join(root, 'CLAUDE.md'), content })

      assert.ok(!expanded.includes('SHOULD NOT APPEAR'))
      assert.equal(expanded, content)
    })
  })

  test('ignores email addresses and package handles glued to a word', () => {
    withRepo((root) => {
      const content = 'Contact support@example.com for help.'
      const expanded = expandImports({ path: join(root, 'CLAUDE.md'), content })
      assert.equal(expanded, content)
    })
  })

  test('leaves a missing import verbatim rather than deleting the line', () => {
    withRepo((root) => {
      const content = 'Rules.\n@docs/does-not-exist.md\n'
      const expanded = expandImports({ path: join(root, 'CLAUDE.md'), content })
      assert.equal(expanded, content)
    })
  })

  test('strips frontmatter from imported files', () => {
    withRepo((root, write) => {
      write('docs/api.md', '---\nglobs: ["src/**"]\n---\nAPI BODY')

      const expanded = expandImports({
        path: join(root, 'CLAUDE.md'),
        content: '@docs/api.md'
      })

      assert.ok(expanded.includes('API BODY'))
      assert.ok(!expanded.includes('globs:'), 'frontmatter is not inlined')
    })
  })
})

// ── Classification and scoping ──────────────────────────────────────────────

describe('classifyInstructionPath', () => {
  test('recognises each rule file format by path', () => {
    assert.equal(classifyInstructionPath('CLAUDE.md'), 'claude-md')
    assert.equal(classifyInstructionPath('packages/api/AGENTS.md'), 'agents-md')
    assert.equal(classifyInstructionPath('.cursor/rules/api.mdc'), 'cursor-mdc')
    assert.equal(classifyInstructionPath('.cursorrules'), 'cursor-mdc')
    assert.equal(classifyInstructionPath('.github/copilot-instructions.md'), 'copilot')
    assert.equal(classifyInstructionPath('.clinerules'), 'cline')
    assert.equal(classifyInstructionPath('.windsurfrules'), 'windsurf')
    assert.equal(classifyInstructionPath('.windsurf/rules/db.md'), 'windsurf')
  })

  test('returns null for ordinary documentation', () => {
    assert.equal(classifyInstructionPath('README.md'), null)
    assert.equal(classifyInstructionPath('docs/architecture.md'), null)
  })
})

describe('scopePathsForSource', () => {
  test('prefers declared globs', () => {
    const scope = scopePathsForSource('/repo', '/repo/.cursor/rules/api.mdc', ['src/api/**'])
    assert.deepEqual(scope, ['src/api/**'])
  })

  test('falls back to the containing directory for a nested file', () => {
    const scope = scopePathsForSource('/repo', '/repo/packages/api/AGENTS.md', [])
    assert.deepEqual(scope, ['packages/api'])
  })

  test('gives a root file no scope at all', () => {
    const scope = scopePathsForSource('/repo', '/repo/AGENTS.md', [])
    assert.deepEqual(scope, [])
  })

  test('caps declared globs at ten entries', () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/m${i}/**`)
    assert.equal(scopePathsForSource('/repo', '/repo/AGENTS.md', many).length, 10)
  })

  test('instructionScopePaths derives scope from raw content', () => {
    const scope = instructionScopePaths(
      '/repo',
      '/repo/.cursor/rules/api.mdc',
      '---\nglobs: ["src/api/**"]\n---\nUse Result types.'
    )
    assert.deepEqual(scope, ['src/api/**'])
  })
})

// ── Prompt formatting ─────────────────────────────────────────────────

function source(overrides: Partial<InstructionSource> & { path: string }): InstructionSource {
  return {
    scope: 'project',
    format: 'agents-md',
    globs: [],
    alwaysApply: true,
    content: 'Body',
    ...overrides
  }
}

describe('formatInstructionSources', () => {
  test('returns empty string for no sources', () => {
    assert.equal(formatInstructionSources([], '/repo'), '')
  })

  test('labels each block with its workspace-relative path', () => {
    const out = formatInstructionSources(
      [source({ path: '/repo/packages/api/AGENTS.md', content: 'API rules' })],
      '/repo'
    )
    assert.ok(out.startsWith('## Project Agent Instructions'))
    assert.ok(out.includes('### packages/api/AGENTS.md'))
    assert.ok(out.includes('API rules'))
  })

  test('notes the globs a scoped file applies to', () => {
    const out = formatInstructionSources(
      [source({ path: '/repo/.cursor/rules/api.mdc', globs: ['src/api/**'], content: 'X' })],
      '/repo'
    )
    assert.ok(out.includes('(applies to: src/api/**)'))
  })

  test('preserves the order it is given (precedence order)', () => {
    const out = formatInstructionSources(
      [
        source({ path: '/repo/AGENTS.md', content: 'FIRST' }),
        source({ path: '/repo/pkg/AGENTS.md', scope: 'nested', content: 'SECOND' })
      ],
      '/repo'
    )
    assert.ok(out.indexOf('FIRST') < out.indexOf('SECOND'))
  })

  test('stops at the character budget instead of truncating mid-rule', () => {
    const out = formatInstructionSources(
      [
        source({ path: '/repo/a.md', content: 'A'.repeat(200) }),
        source({ path: '/repo/b.md', content: 'KEEP-OUT' })
      ],
      // First block is '### a.md\n\n' (10) + 200 chars; the second would overflow.
      '/repo',
      215
    )
    assert.ok(out.includes('A'.repeat(200)))
    assert.ok(!out.includes('KEEP-OUT'), 'the block that would overflow is dropped whole')
  })

  test('deduplicates repeated paths', () => {
    const out = formatInstructionSources(
      [source({ path: '/repo/AGENTS.md' }), source({ path: '/repo/AGENTS.md' })],
      '/repo'
    )
    assert.equal(out.split('### AGENTS.md').length - 1, 1)
  })
})

describe('listWorkspaceFiles', () => {
  test('lists files relative to the workspace and skips ignored dirs', () => {
    withRepo((root, write) => {
      write('packages/api/AGENTS.md', 'x')
      write('node_modules/pkg/AGENTS.md', 'x')

      const files = listWorkspaceFiles(root)
      assert.ok(files.includes('packages/api/AGENTS.md'))
      assert.ok(!files.some((f) => f.startsWith('node_modules/')))
    })
  })

  test('honours the depth limit', () => {
    withRepo((root, write) => {
      write('a/b/c/deep.md', 'x')
      assert.ok(!listWorkspaceFiles(root, 1).includes('a/b/c/deep.md'))
      assert.ok(listWorkspaceFiles(root, 5).includes('a/b/c/deep.md'))
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

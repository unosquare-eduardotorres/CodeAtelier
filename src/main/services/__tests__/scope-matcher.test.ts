/**
 * Tests for scope-matcher.ts — glob compilation and scope-path activation.
 *
 * Includes regressions for the three defects in the matcher this replaced:
 * `**` treated as prefix+suffix, no brace expansion, and no negation.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  compileGlob,
  matchesGlob,
  matchesAny,
  matchesScopePath,
  anyPathInScope,
  normalizePath,
  clearGlobCache
} from '../scope-matcher'

describe('normalizePath', () => {
  test('converts backslashes and strips ./ and trailing /', () => {
    assert.equal(normalizePath('src\\api\\index.ts'), 'src/api/index.ts')
    assert.equal(normalizePath('./src/api'), 'src/api')
    assert.equal(normalizePath('src/api/'), 'src/api')
    assert.equal(normalizePath('/'), '/')
  })
})

describe('matchesGlob — single segment wildcards', () => {
  test('* does not cross a path separator', () => {
    assert.ok(matchesGlob('README.md', '*.md'))
    assert.ok(!matchesGlob('docs/guide.md', '*.md'))
    assert.ok(matchesGlob('docs/guide.md', 'docs/*.md'))
  })

  test('? matches exactly one character within a segment', () => {
    assert.ok(matchesGlob('v1.md', 'v?.md'))
    assert.ok(!matchesGlob('v10.md', 'v?.md'))
    assert.ok(!matchesGlob('v/1.md', 'v?1.md'))
  })

  test('a literal dot is not a regex wildcard', () => {
    assert.ok(!matchesGlob('READMExmd', 'README.md'))
  })
})

describe('matchesGlob — globstar', () => {
  test('src/**/*.ts matches nested files', () => {
    assert.ok(matchesGlob('src/a/b/c.ts', 'src/**/*.ts'))
    assert.ok(matchesGlob('src/a.ts', 'src/**/*.ts'), 'globstar also matches zero segments')
  })

  test('src/**/*.ts does not match a look-alike suffix', () => {
    // The old prefix+suffix matcher accepted this: it only checked that the
    // path started with 'src/' and ended with '.ts'.
    assert.ok(!matchesGlob('src/a/b/c.ts.bak', 'src/**/*.ts'))
    assert.ok(!matchesGlob('srcfoo/a.ts', 'src/**/*.ts'))
  })

  test('a/**/b matches with and without intermediate segments', () => {
    assert.ok(matchesGlob('a/b', 'a/**/b'))
    assert.ok(matchesGlob('a/x/b', 'a/**/b'))
    assert.ok(matchesGlob('a/x/y/b', 'a/**/b'))
  })

  test('trailing ** matches everything beneath a directory', () => {
    assert.ok(matchesGlob('src/api/handlers/get.ts', 'src/**'))
    assert.ok(!matchesGlob('test/api.ts', 'src/**'))
  })

  test('leading **/ matches at any depth including root', () => {
    assert.ok(matchesGlob('AGENTS.md', '**/AGENTS.md'))
    assert.ok(matchesGlob('packages/api/AGENTS.md', '**/AGENTS.md'))
  })
})

describe('matchesGlob — brace expansion', () => {
  test('expands a simple alternation', () => {
    assert.ok(matchesGlob('src/a.ts', 'src/*.{ts,tsx}'))
    assert.ok(matchesGlob('src/a.tsx', 'src/*.{ts,tsx}'))
    assert.ok(!matchesGlob('src/a.js', 'src/*.{ts,tsx}'))
  })

  test('expands alternations containing separators', () => {
    assert.ok(matchesGlob('src/api/x.ts', '{src,test}/api/*.ts'))
    assert.ok(matchesGlob('test/api/x.ts', '{src,test}/api/*.ts'))
    assert.ok(!matchesGlob('lib/api/x.ts', '{src,test}/api/*.ts'))
  })

  test('expands nested alternations', () => {
    assert.ok(matchesGlob('src/api/v2/x.ts', 'src/{api/{v1,v2},db}/*.ts'))
    assert.ok(matchesGlob('src/db/x.ts', 'src/{api/{v1,v2},db}/*.ts'))
    assert.ok(!matchesGlob('src/api/v3/x.ts', 'src/{api/{v1,v2},db}/*.ts'))
  })

  test('treats an unclosed brace as a literal', () => {
    assert.ok(matchesGlob('a{b', 'a{b'))
  })
})

describe('matchesAny — pattern lists', () => {
  test('matches when any positive pattern matches', () => {
    assert.ok(matchesAny('docs/a.md', ['README.md', 'docs/**/*.md']))
    assert.ok(!matchesAny('src/a.ts', ['README.md', 'docs/**/*.md']))
  })

  test('negation excludes an otherwise-matching path', () => {
    const patterns = ['src/**/*.ts', '!src/**/*.test.ts']
    assert.ok(matchesAny('src/api/handler.ts', patterns))
    assert.ok(!matchesAny('src/api/handler.test.ts', patterns))
  })

  test('an empty list matches nothing', () => {
    assert.ok(!matchesAny('anything.md', []))
  })

  test('a list of only negations matches everything not excluded', () => {
    assert.ok(matchesAny('src/a.ts', ['!node_modules/**']))
    assert.ok(!matchesAny('node_modules/x/a.ts', ['!node_modules/**']))
  })
})

describe('matchesScopePath', () => {
  test('a plain directory entry scopes everything beneath it', () => {
    assert.ok(matchesScopePath('src/billing/Invoice.java', 'src/billing'))
    assert.ok(matchesScopePath('src/billing', 'src/billing'))
    assert.ok(!matchesScopePath('src/billingx/Invoice.java', 'src/billing'))
    assert.ok(!matchesScopePath('src/other/Invoice.java', 'src/billing'))
  })

  test('a plain file entry matches only that file', () => {
    assert.ok(matchesScopePath('src/db/index.ts', 'src/db/index.ts'))
    assert.ok(!matchesScopePath('src/db/index.test.ts', 'src/db/index.ts'))
  })

  test('a glob entry is matched as a glob', () => {
    assert.ok(matchesScopePath('src/api/users.ts', 'src/api/**'))
    assert.ok(!matchesScopePath('src/db/users.ts', 'src/api/**'))
  })

  test('bracketed directory names are literals, not character classes', () => {
    assert.ok(matchesScopePath('app/[id]/page.tsx', 'app/[id]'))
  })

  test('an empty entry never matches', () => {
    assert.ok(!matchesScopePath('src/a.ts', ''))
  })
})

describe('anyPathInScope', () => {
  test('true when one active path falls under one scope entry', () => {
    const active = ['src/ui/App.tsx', 'src/billing/Invoice.java']
    assert.ok(anyPathInScope(active, ['src/billing']))
  })

  test('false when nothing overlaps', () => {
    assert.ok(!anyPathInScope(['src/ui/App.tsx'], ['src/billing']))
  })

  test('false for empty inputs on either side', () => {
    assert.ok(!anyPathInScope([], ['src/billing']))
    assert.ok(!anyPathInScope(['src/a.ts'], []))
  })
})

describe('compileGlob caching', () => {
  test('returns the same compiled RegExp for the same pattern', () => {
    clearGlobCache()
    const a = compileGlob('src/**/*.ts')
    const b = compileGlob('src/**/*.ts')
    assert.equal(a, b, 'compilation is memoised')
  })

  test('a cleared cache still produces an equivalent matcher', () => {
    const before = compileGlob('docs/**/*.md').source
    clearGlobCache()
    assert.equal(compileGlob('docs/**/*.md').source, before)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

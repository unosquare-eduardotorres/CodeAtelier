/**
 * Tests for detectLanguage + EXT_TO_LANGUAGE — exported from repo.service.ts.
 *
 * Covers extension-to-language mapping, special cases, and fallback behavior.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
const { detectLanguage, EXT_TO_LANGUAGE } = require('../repo.service') as any

// ── Standard extension mappings ──

describe('detectLanguage — standard extensions', () => {
  test('.ts → "typescript"', () => {
    assert.equal(detectLanguage('src/app.ts'), 'typescript')
  })

  test('.tsx → "tsx"', () => {
    assert.equal(detectLanguage('components/App.tsx'), 'tsx')
  })

  test('.js → "javascript"', () => {
    assert.equal(detectLanguage('index.js'), 'javascript')
  })

  test('.py → "python"', () => {
    assert.equal(detectLanguage('scripts/run.py'), 'python')
  })

  test('.rs → "rust"', () => {
    assert.equal(detectLanguage('src/main.rs'), 'rust')
  })

  test('.go → "go"', () => {
    assert.equal(detectLanguage('cmd/server.go'), 'go')
  })

  test('.json → "json"', () => {
    assert.equal(detectLanguage('package.json'), 'json')
  })

  test('.md → "markdown"', () => {
    assert.equal(detectLanguage('README.md'), 'markdown')
  })

  test('.yml → "yaml"', () => {
    assert.equal(detectLanguage('docker-compose.yml'), 'yaml')
  })

  test('.yaml → "yaml"', () => {
    assert.equal(detectLanguage('.github/workflows/ci.yaml'), 'yaml')
  })
})

// ── Special cases ──

describe('detectLanguage — special cases', () => {
  test('Dockerfile (no extension) → "docker"', () => {
    assert.equal(detectLanguage('Dockerfile'), 'docker')
  })

  test('path ending in Dockerfile → "docker"', () => {
    assert.equal(detectLanguage('deploy/Dockerfile'), 'docker')
  })

  test('.dockerfile extension → "docker"', () => {
    assert.equal(detectLanguage('build/app.dockerfile'), 'docker')
  })

  test('.h → "c" (mapped to C)', () => {
    assert.equal(detectLanguage('include/utils.h'), 'c')
  })

  test('.svg → "xml"', () => {
    assert.equal(detectLanguage('assets/icon.svg'), 'xml')
  })

  test('.prisma → "graphql"', () => {
    assert.equal(detectLanguage('prisma/schema.prisma'), 'graphql')
  })
})

// ── Fallback behavior ──

describe('detectLanguage — fallback', () => {
  test('unknown extension → "text"', () => {
    assert.equal(detectLanguage('data/file.xyz'), 'text')
  })

  test('no extension → "text" (unless Dockerfile)', () => {
    assert.equal(detectLanguage('Makefile'), 'text')
  })
})

// ── EXT_TO_LANGUAGE map integrity ──

describe('EXT_TO_LANGUAGE map integrity', () => {
  test('all keys are dotted extensions', () => {
    for (const key of Object.keys(EXT_TO_LANGUAGE)) {
      assert.ok(key.startsWith('.'), `key "${key}" should start with dot`)
    }
  })

  test('all values are non-empty strings', () => {
    for (const [key, value] of Object.entries(EXT_TO_LANGUAGE)) {
      assert.ok(typeof value === 'string' && value.length > 0, `value for "${key}" should be non-empty string`)
    }
  })

  test('map has expected number of entries (≥30)', () => {
    assert.ok(Object.keys(EXT_TO_LANGUAGE).length >= 30, 'expected at least 30 extension mappings')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

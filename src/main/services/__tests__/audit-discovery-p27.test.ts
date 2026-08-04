/**
 * Phase 27 — audit-discovery.service.ts tests.
 *
 * Tests discoverAuditableFiles with a temp directory structure.
 * The function uses readdirSync/statSync (real FS), so we create a minimal
 * temp tree.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverAuditableFiles } from '../audit-discovery.service'

// ── temp workspace helper ──

const TMP_ROOT = join(tmpdir(), `audit-discovery-test-${Date.now()}`)

function setupTempWorkspace(): void {
  mkdirSync(TMP_ROOT, { recursive: true })

  // Create a mini workspace tree
  const dirs = [
    'src/services',
    'src/db/repositories',
    'src/db/migrations',
    'src/components',
    'src/components/styles',
    'src/ipc',
    'src/__tests__',
    'src/middleware',
    'src/security',
    'docs',
    'node_modules/foo',
    '.git/objects'
  ]
  for (const d of dirs) {
    mkdirSync(join(TMP_ROOT, d), { recursive: true })
  }

  // Create files with proper extensions
  const files: Record<string, string> = {
    'src/services/auth.service.ts': '// auth service',
    'src/services/user.service.ts': '// user service',
    'src/db/repositories/user.repository.ts': '// user repo',
    'src/db/migrations/001-init.sql': '-- init migration',
    'src/db/schema.prisma': '// prisma schema',
    'src/components/App.tsx': '// app component',
    'src/components/Layout.tsx': '// layout component',
    'src/ipc/main.ipc.ts': '// ipc handler',
    'src/__tests__/auth.test.ts': '// auth test',
    'src/__tests__/user.spec.ts': '// user spec',
    'docs/README.md': '# README',
    'docs/CLAUDE.md': '# CLAUDE',
    'docs/CONTRIBUTING.md': '# Contributing',
    'package.json': '{}',
    'tsconfig.json': '{}',
    'src/types.ts': '// types',
    'src/constants.ts': '// constants',
    'src/index.ts': '// index',
    '.env': 'API_KEY=test',
    'src/middleware/auth.ts': '// auth middleware',
    'src/security/csp.ts': '// csp',
    'src/components/styles/theme.css': '// theme',
    'node_modules/foo/index.js': '// should be skipped',
    '.git/objects/abc': 'git object'
  }
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(TMP_ROOT, path), content)
  }
}

function cleanupTempWorkspace(): void {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

setupTempWorkspace()

// ── Tests ──

describe('discoverAuditableFiles — database track', () => {
  test('finds SQL migration files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'database')
    assert.ok(result.totalFiles > 0)
    assert.ok(result.filePaths.some((f) => f.includes('migration')))
  })

  test('finds repository files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'database')
    assert.ok(result.filePaths.some((f) => f.includes('repository')))
  })

  test('finds schema files as priority', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'database')
    assert.ok(result.priorityFiles.some((f) => f.includes('schema')))
  })
})

describe('discoverAuditableFiles — code track', () => {
  test('finds TypeScript/TSX source files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'code')
    assert.ok(result.totalFiles > 0)
    assert.ok(result.filePaths.some((f) => f.endsWith('.ts') || f.endsWith('.tsx')))
  })

  test('excludes test files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'code')
    assert.ok(!result.filePaths.some((f) => f.includes('.test.')))
    assert.ok(!result.filePaths.some((f) => f.includes('.spec.')))
    assert.ok(!result.filePaths.some((f) => f.includes('__tests__')))
  })

  test('identifies index.ts as priority', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'code')
    assert.ok(result.priorityFiles.some((f) => f.includes('index.ts')))
  })
})

describe('discoverAuditableFiles — testing track', () => {
  test('finds test and spec files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'testing')
    assert.ok(result.totalFiles > 0)
    assert.ok(result.filePaths.some((f) => f.includes('.test.')))
    assert.ok(result.filePaths.some((f) => f.includes('.spec.')))
  })
})

describe('discoverAuditableFiles — architecture track', () => {
  test('finds package.json and tsconfig', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'architecture')
    assert.ok(result.filePaths.some((f) => f.includes('package.json')))
    assert.ok(result.filePaths.some((f) => f.includes('tsconfig')))
  })

  test('finds types.ts and constants.ts', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'architecture')
    assert.ok(result.filePaths.some((f) => f.includes('types.ts')))
    assert.ok(result.filePaths.some((f) => f.includes('constants.ts')))
  })

  test('finds IPC and services directories', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'architecture')
    assert.ok(result.filePaths.some((f) => f.includes('/ipc/')))
    assert.ok(result.filePaths.some((f) => f.includes('/services/')))
  })
})

describe('discoverAuditableFiles — security track', () => {
  test('finds auth and security files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'security')
    assert.ok(result.filePaths.some((f) => f.includes('auth')))
  })

  test('finds middleware auth files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'security')
    assert.ok(result.filePaths.some((f) => f.includes('middleware')))
  })

  test('identifies auth as priority', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'security')
    assert.ok(result.priorityFiles.some((f) => f.includes('auth')))
  })
})

describe('discoverAuditableFiles — documentation track', () => {
  test('finds markdown files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'documentation')
    assert.ok(result.totalFiles > 0)
    assert.ok(result.filePaths.some((f) => f.endsWith('.md')))
  })

  test('identifies README and CLAUDE.md as priority', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'documentation')
    assert.ok(result.priorityFiles.some((f) => f.includes('README')))
    assert.ok(result.priorityFiles.some((f) => f.includes('CLAUDE.md')))
  })
})

describe('discoverAuditableFiles — ui-ux track', () => {
  test('finds component and layout files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'ui-ux')
    assert.ok(result.totalFiles > 0)
    assert.ok(result.filePaths.some((f) => f.includes('component')))
  })

  test('finds CSS theme files', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'ui-ux')
    assert.ok(result.filePaths.some((f) => f.endsWith('.css')))
  })
})

describe('discoverAuditableFiles — edge cases', () => {
  test('skips node_modules', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'code')
    assert.ok(!result.filePaths.some((f) => f.includes('node_modules')))
  })

  test('skips .git directory', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'code')
    assert.ok(!result.filePaths.some((f) => f.includes('.git')))
  })

  test('returns empty for unknown track', () => {
    const result = discoverAuditableFiles(TMP_ROOT, 'nonexistent' as any)
    assert.equal(result.totalFiles, 0)
    assert.deepEqual(result.filePaths, [])
    assert.deepEqual(result.priorityFiles, [])
  })

  test('returns empty for nonexistent directory', () => {
    const result = discoverAuditableFiles('/nonexistent/path/xyz', 'code')
    assert.equal(result.totalFiles, 0)
  })
})

// Cleanup
cleanupTempWorkspace()

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
